#!/usr/bin/env node
// Pont Claude Code — lets a Claude chat (Claude Desktop) drive Claude Code on the
// same computer: start a task, follow it, answer its questions, get the result.
// No copy-paste between the two.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveModeSetting, parseSafetySetting, untilDoneBudget, saveTaskFiles, backupOnce, waitFor, LIVE, DEFAULT_SAFETY_S } from "./lib.js";
import {
  WAITING, DEFAULT_RESUME_MESSAGE, MAX_AUTO_RESUMES, RESUME_DELAY_MS, RESUME_SPACING_MS, RESUME_CHECK_MS, LIMIT_RETRY_MS,
  isUsageLimitEnd, planAfterLimit, formatHM, createResumeScheduler, createKeepAwake,
} from "./autoresume.js";

const VERSION = "0.4.0";
const QUESTION_MARKER = "BRIDGE_QUESTION:";
const MAX_WAIT_S = 50;          // stay well under the 60 s MCP request timeout of most clients
const DEFAULT_WAIT_S = 45;
const DEFAULT_UNTIL_DONE_MIN = 60; // until_done: wait for the end of the run, up to max_minutes
const MAX_UNTIL_DONE_MIN = 120;
const PROGRESS_EVERY_S = 10;       // progress notifications during a long wait (if the client asked for them)
const MAX_RESULT_CHARS = 24000; // report returned to the chat
const MAX_EVENT_CHARS = 300;    // one progress line
const MAX_EVENTS_KEPT = 500;    // per task, in memory
const MAX_EVENTS_SHOWN = 25;    // per tool response
const MAX_TASKS_SAVED = 50;
const IS_WIN = process.platform === "win32";

const log = (...a) => console.error("[pont-claude-code]", ...a);

// ---------- configuration (env, filled from the extension settings) ----------
// Unfilled ${user_config.x} placeholders and empty strings count as "not set".
const cfg = (name) => { const v = (process.env[name] || "").trim(); return v.startsWith("${") ? "" : v; };
const expandHome = (p) => (p && (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) ? join(homedir(), p.slice(1)) : p);
const truthy = (v) => /^(1|true|yes|on)$/i.test(v);
const onUnlessOff = (v) => !/^(0|false|no|off)$/i.test(v); // settings that are on by default
const msSetting = (name, def) => { const n = Number(cfg(name)); return cfg(name) && Number.isFinite(n) && n >= 0 ? n : def; };

const DEFAULT_CWD = expandHome(cfg("PONT_DEFAULT_CWD")) || homedir();
const ALLOWED_TOOLS = cfg("PONT_ALLOWED_TOOLS");   // comma-separated, e.g. "Bash(npm:*),Bash(git:*)"
const MODEL = cfg("PONT_MODEL");
const ALLOW_BYPASS = truthy(cfg("PONT_ALLOW_BYPASS"));
const STATE_DIR = expandHome(cfg("PONT_STATE_DIR")) || join(homedir(), ".pont-claude-code");

// Automatic resume after a usage limit (on by default) and keeping the Mac awake (on by default).
const AUTO_RESUME = onUnlessOff(cfg("PONT_AUTO_RESUME"));
const AUTO_RESUME_MESSAGE = cfg("PONT_AUTO_RESUME_MESSAGE") || DEFAULT_RESUME_MESSAGE;
const KEEP_AWAKE = onUnlessOff(cfg("PONT_KEEP_AWAKE"));
// Timings: fixed in use; the PONT_*_MS variables only exist so that the tests don't wait for real.
const RESUME_DELAY = msSetting("PONT_RESUME_DELAY_MS", RESUME_DELAY_MS);
const RESUME_SPACING = msSetting("PONT_RESUME_SPACING_MS", RESUME_SPACING_MS);
const RESUME_CHECK = msSetting("PONT_RESUME_CHECK_MS", RESUME_CHECK_MS) || RESUME_CHECK_MS;
const LIMIT_RETRY = msSetting("PONT_LIMIT_RETRY_MS", LIMIT_RETRY_MS);
const CAFFEINATE_BIN = cfg("PONT_CAFFEINATE_BIN") || "caffeinate";

// Modes known to Claude Code (2.x). The real list is read from `claude --help` on first use.
const FALLBACK_MODES = ["acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"];
const MODE_ALIASES = { default: "manual" }; // older name
let permissionModes = null;
const configWarnings = [];

// ---------- locating Claude Code ----------
function findClaude() {
  const explicit = expandHome(cfg("CLAUDE_BIN"));
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    configWarnings.push(`CLAUDE_BIN "${explicit}" does not exist; searching elsewhere.`);
  }
  const h = homedir();
  const candidates = IS_WIN
    ? [join(h, ".local", "bin", "claude.exe"), join(process.env.APPDATA || "", "npm", "claude.cmd")]
    : [join(h, ".local/bin/claude"), join(h, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"];
  for (const c of candidates) if (c && existsSync(c)) return c;
  try {
    if (IS_WIN) {
      const out = execFileSync("where", ["claude"], { encoding: "utf8", timeout: 5000 }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return out.find((p) => /\.exe$/i.test(p)) || out[0] || "claude";
    }
    // Desktop apps start MCP servers with a minimal PATH: ask the user's login shell.
    for (const sh of [process.env.SHELL, "/bin/zsh", "/bin/bash"].filter(Boolean)) {
      try {
        const out = execFileSync(sh, ["-lc", "command -v claude"], { encoding: "utf8", timeout: 5000 }).trim().split("\n").pop();
        if (out && existsSync(out)) return out;
      } catch {}
    }
  } catch {}
  return "claude";
}
const CLAUDE_BIN = findClaude();

// On Windows an npm-installed `claude.cmd` can't be spawned safely without a shell
// (quoting of newlines/parentheses breaks). Run its cli.js with node instead.
function launcher() {
  if (IS_WIN && /\.(cmd|bat)$/i.test(CLAUDE_BIN)) {
    const cli = join(dirname(CLAUDE_BIN), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(cli)) return { cmd: process.execPath, pre: [cli] };
  }
  if (/\.(m?js)$/i.test(CLAUDE_BIN)) return { cmd: process.execPath, pre: [CLAUDE_BIN] };
  return { cmd: CLAUDE_BIN, pre: [] };
}
const LAUNCH = launcher();

function childEnv() {
  const env = { ...process.env };
  if (!IS_WIN) env.PATH = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", env.PATH || ""].join(":");
  for (const k of Object.keys(env)) if (k.startsWith("PONT_")) delete env[k];
  return env;
}

let modesPromise = null;
function getPermissionModes() {
  if (!modesPromise) modesPromise = new Promise((res) => {
    execFile(LAUNCH.cmd, [...LAUNCH.pre, "--help"], { env: childEnv(), timeout: 15000, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout) => {
      const flat = String(stdout || "").replace(/\s+/g, " ");
      const m = flat.match(/--permission-mode <mode>.*?\(choices: ([^)]*)\)/);
      const found = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
      permissionModes = found.length ? found : FALLBACK_MODES;
      // Read the default mode from the settings once the real list is known. A mistyped value
      // that contains exactly one mode name (e.g. "Allow bypassPermissions") uses that mode.
      const r = resolveModeSetting(MODE_SETTING, permissionModes, { aliases: MODE_ALIASES, allowBypass: ALLOW_BYPASS });
      DEFAULT_MODE = r.mode;
      for (const w of r.warnings) { configWarnings.push(w); log("warning:", w); }
      res(permissionModes);
    });
  });
  return modesPromise;
}
const defaultMode = async () => { await getPermissionModes(); return DEFAULT_MODE; };

async function checkMode(mode) {
  const m = MODE_ALIASES[mode] || mode;
  const modes = await getPermissionModes();
  if (!modes.includes(m)) return { error: `Unknown permission mode "${mode}". This Claude Code accepts: ${modes.join(", ")}.` };
  if (m === "bypassPermissions" && !ALLOW_BYPASS)
    return { error: `bypassPermissions is disabled in the extension settings ("Allow bypassPermissions"). Ask the user to enable it there, or use acceptEdits/auto.` };
  return { mode: m };
}

const MODE_SETTING = cfg("PONT_PERMISSION_MODE");
// Safe value until `claude --help` has been read (defaultMode() always waits for that).
let DEFAULT_MODE = "acceptEdits";

// until_done: return on our own with status "running" after this many seconds (0 = off), so
// that clients cutting long tool calls (remote sessions: about 80 s) get an answer instead.
const SAFETY = parseSafetySetting(cfg("PONT_UNTIL_DONE_SAFETY_S"), { def: DEFAULT_SAFETY_S, max: MAX_UNTIL_DONE_MIN * 60 });
if (SAFETY.warning) configWarnings.push(SAFETY.warning);
const UNTIL_DONE_SAFETY_S = SAFETY.seconds;

// ---------- system prompt addition for Claude Code ----------
const BRIDGE_RULES = `# Running under Pont Claude Code
You are being driven by another Claude instance (the "pilot") that is chatting with the user. No human is watching this terminal and nobody can approve prompts live.
- Work autonomously and finish the whole task. Make reasonable decisions yourself rather than asking; note them in your report.
- If an action is refused for permissions, don't look for a way around it: carry on with the rest and list what was blocked in your report.
- Only if you are truly blocked by missing information that you cannot find in the project or decide sensibly, stop and end your final message with one line per question, each starting with "${QUESTION_MARKER}". The pilot will answer and you will be resumed in this same session.
- Finish with a short report: what you changed (files), how you checked it, decisions you made, anything left to do.`;

mkdirSync(STATE_DIR, { recursive: true });
const RULES_FILE = join(STATE_DIR, "bridge-rules.md");
writeFileSync(RULES_FILE, BRIDGE_RULES);
const TASKS_FILE = join(STATE_DIR, "tasks.json");
const ARCHIVE_FILE = join(STATE_DIR, "tasks-archive.json");          // older tasks, moved out unchanged
const BACKUP_FILE = join(STATE_DIR, "tasks.before-0.3.1.json");      // made once, before the first write
// 0.4.0 adds the waiting_limit status: keep tasks.json as 0.3.x left it, once.
backupOnce(TASKS_FILE, join(STATE_DIR, "tasks.before-0.4.0.json"));

// ---------- task registry (persisted so tasks survive an app restart) ----------
/** @type {Map<string, any>} */
const tasks = new Map();

function loadTasks() {
  try {
    const saved = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
    for (const s of saved.tasks || []) {
      const t = { ...blankTask(), ...s, proc: null, waiters: new Set(), events: s.events || [], cursor: (s.events || []).length };
      if (LIVE.has(t.status)) { t.status = "interrupted"; t.events.push("⚠️ interrupted: the Claude app closed while this task was running"); }
      tasks.set(t.id, t);
    }
  } catch {}
}

let saveTimer = null;
function saveTasks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
// tasks.json keeps the MAX_TASKS_SAVED most recent tasks; older ones go to tasks-archive.json.
const archivedKeys = new Set();
function saveNow() {
  clearTimeout(saveTimer);
  try {
    const all = [...tasks.values()];
    const ordered = [...all.filter((t) => t.status !== WAITING), ...all.filter((t) => t.status === WAITING)];
    const list = ordered.map((t) => {
      const { proc, waiters, stderr, ...rest } = t;
      return { ...rest, events: t.events.slice(-40) };
    });
    const r = saveTaskFiles({ file: TASKS_FILE, archiveFile: ARCHIVE_FILE, backupFile: BACKUP_FILE, list, max: MAX_TASKS_SAVED, version: VERSION, archivedKeys });
    if (r.archived) log(`moved ${r.archived} older task(s) to ${ARCHIVE_FILE}`);
    if (r.warning) log("warning:", r.warning);
  } catch (e) { log("could not save tasks:", /** @type {Error} */ (e).message); }
}

// Most recently active last: a task that runs again counts as recent (kept in tasks.json).
function touch(t) { tasks.delete(t.id); tasks.set(t.id, t); }

function blankTask() {
  return {
    id: "", title: "", cwd: "", permissionMode: DEFAULT_MODE, sessionId: null, status: "starting",
    events: [], cursor: 0, runs: 0, result: null, questions: [], denials: [], error: null,
    costUsd: 0, turns: 0, startedAt: null, runStartedAt: null, endedAt: null, durationMs: 0,
    resumeAt: null, autoResumes: 0, autoResumeHistory: [], limitMessage: null,
    proc: null, waiters: new Set(), stderr: "",
  };
}

function newTask({ cwd, permissionMode, sessionId, title }) {
  let id;
  do id = randomUUID().slice(0, 8); while (tasks.has(id));
  const t = { ...blankTask(), id, title: title || "", cwd, permissionMode, sessionId: sessionId || null, startedAt: new Date().toISOString() };
  tasks.set(id, t);
  while (tasks.size > MAX_TASKS_SAVED * 2) { // forget the oldest finished tasks
    const old = [...tasks.values()].find((x) => !LIVE.has(x.status) && x.status !== WAITING);
    if (!old) break;
    tasks.delete(old.id);
  }
  return t;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function pushEvent(t, line) {
  t.events.push(clip(String(line).replace(/\s+/g, " ").trim(), MAX_EVENT_CHARS));
  if (t.events.length > MAX_EVENTS_KEPT) {
    const drop = t.events.length - MAX_EVENTS_KEPT;
    t.events.splice(0, drop);
    t.cursor = Math.max(0, t.cursor - drop);
  }
}

function describeToolUse(item) {
  const i = item.input || {};
  const hint = i.command || i.file_path || i.notebook_path || i.path || i.pattern || i.url || i.query || i.description || i.subject || "";
  return `🔧 ${item.name}${hint ? ": " + String(hint) : ""}`;
}

function settle(t) {
  for (const w of [...t.waiters]) w();
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (IS_WIN) execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => {});
    else process.kill(-proc.pid, "SIGINT"); // whole group: Claude Code and anything it launched
  } catch { try { proc.kill("SIGINT"); } catch {} }
  setTimeout(() => {
    if (proc.exitCode !== null || proc.signalCode) return;
    try { IS_WIN ? proc.kill() : process.kill(-proc.pid, "SIGKILL"); } catch {}
  }, 4000).unref();
}

function runClaude(t, prompt, { resume }) {
  const args = [...LAUNCH.pre, "-p", "--output-format", "stream-json", "--verbose",
    "--append-system-prompt-file", RULES_FILE, "--permission-mode", t.permissionMode];
  if (resume) args.push("--resume", t.sessionId);
  else { t.sessionId = randomUUID(); args.push("--session-id", t.sessionId); }
  if (ALLOWED_TOOLS) args.push("--allowedTools", ALLOWED_TOOLS);
  if (MODEL) args.push("--model", MODEL);

  Object.assign(t, { status: "running", result: null, questions: [], denials: [], error: null, stderr: "", runStartedAt: Date.now(), endedAt: null, resumeAt: null, limitMessage: null });
  t.runs += 1;
  touch(t);
  pushEvent(t, `▶️ run ${t.runs} (${t.permissionMode}) in ${t.cwd}`);
  saveTasks();

  let proc;
  try {
    proc = spawn(LAUNCH.cmd, args, { cwd: t.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], detached: !IS_WIN, windowsHide: true });
  } catch (e) {
    return finish(t, "error", { error: `Could not start Claude Code (${CLAUDE_BIN}): ${e.message}` });
  }
  t.proc = proc;
  refreshAwake();
  // The prompt goes through stdin: no command-line length or quoting limits.
  proc.stdin.on("error", () => {});
  proc.stdin.end(prompt);

  let buf = "";
  let finalMsg = null;
  let rejected = false, resetsAt = null; // "usage limit: rejected" seen during this run
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line[0] !== "{") continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        if (msg.parent_tool_use_id) continue; // sub-agent chatter: keep the log readable
        for (const item of msg.message.content) {
          if (item.type === "text" && item.text?.trim()) pushEvent(t, "💬 " + item.text);
          else if (item.type === "tool_use") pushEvent(t, describeToolUse(item));
        }
      } else if (msg.type === "rate_limit_event" && msg.rate_limit_info?.status && msg.rate_limit_info.status !== "allowed") {
        pushEvent(t, `⚠️ usage limit: ${msg.rate_limit_info.status}`);
        if (msg.rate_limit_info.status === "rejected") { rejected = true; resetsAt = msg.rate_limit_info.resetsAt ?? resetsAt; }
      } else if (msg.type === "result") {
        finalMsg = msg;
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { t.stderr = (t.stderr + c).slice(-3000); });
  proc.on("error", (e) => {
    if (t.proc !== proc) return;
    t.proc = null;
    finish(t, "error", { error: `Could not start Claude Code (${CLAUDE_BIN}): ${e.message}. Is Claude Code installed? You can set its path in the extension settings.` });
  });
  proc.on("close", (code, signal) => {
    if (t.proc !== proc) return;
    t.proc = null;
    if (t.status === "stopped") return finish(t, "stopped");
    if (!finalMsg) {
      const why = t.stderr.trim() || "no output";
      if (isUsageLimitEnd({ text: t.stderr, isError: true, rejected }))
        return limitReached(t, { text: t.stderr.trim(), resetsAt, fields: { error: `Claude Code stopped on a usage limit: ${clip(why, 1500)}` } });
      const hint = resume && /no conversation found|session/i.test(why)
        ? " (to resume a session, cwd must be the folder where that session was started)" : "";
      return finish(t, "error", { error: `Claude Code exited (code ${code}${signal ? ", " + signal : ""}) without a result: ${clip(why, 1500)}${hint}` });
    }
    if (finalMsg.session_id) t.sessionId = finalMsg.session_id;
    t.costUsd += Number(finalMsg.total_cost_usd || 0);
    t.turns += Number(finalMsg.num_turns || 0);
    const text = typeof finalMsg.result === "string" ? finalMsg.result : "";
    const questions = text.split("\n")
      .filter((l) => l.includes(QUESTION_MARKER))
      .map((l) => l.slice(l.indexOf(QUESTION_MARKER) + QUESTION_MARKER.length).trim())
      .filter(Boolean);
    const denials = (finalMsg.permission_denials || []).map((d) => ({
      tool: d.tool_name,
      input: clip(typeof d.tool_input?.command === "string" ? d.tool_input.command : JSON.stringify(d.tool_input || {}), 300),
    }));
    const extra = { result: text, questions, denials };
    if (isUsageLimitEnd({ text, isError: !!finalMsg.is_error, rejected }))
      return limitReached(t, { text, resetsAt, fields: { ...extra, error: clip(text || "usage limit", 2000) } });
    if (finalMsg.is_error) return finish(t, "error", { ...extra, error: clip(text || finalMsg.subtype || "Claude Code reported an error", 2000) });
    finish(t, questions.length ? "needs_input" : denials.length ? "needs_permission" : "done", extra);
  });
}

function finish(t, status, fields = {}) {
  Object.assign(t, fields, { status, endedAt: new Date().toISOString() });
  if (t.runStartedAt) t.durationMs += Date.now() - t.runStartedAt;
  t.runStartedAt = null;
  pushEvent(t, `⏹ run ${t.runs} ended: ${status}`);
  saveTasks();
  settle(t);
  refreshAwake();
}

// ---------- usage limit: wait, then resume the same session by itself ----------
// The run ended on a usage limit: the task waits (status waiting_limit) until resume_at, then the
// scheduler resumes it at resume_at + 2 min, like cc_reply would, in the same permission mode.
function limitReached(t, { text, resetsAt, fields }) {
  const now = Date.now();
  const plan = planAfterLimit({ text, resetsAt, now, autoResumes: t.autoResumes || 0, enabled: AUTO_RESUME, retryMs: LIMIT_RETRY });
  if (plan.wait === false) {
    pushEvent(t, `⚠️ usage limit: ${plan.reason}`);
    log(`task ${t.id}: usage limit, ${plan.reason}`);
    return finish(t, "error", { ...fields, error: `${fields.error || "usage limit"} (${plan.reason})` });
  }
  const resumeAt = new Date(plan.resumeAt).toISOString();
  const when = plan.how === "retry"
    ? `reset time unreadable: new try at ${formatHM(plan.resumeAt + RESUME_DELAY)}`
    : `resets ${formatHM(plan.resumeAt)}, automatic resume at ${formatHM(plan.resumeAt + RESUME_DELAY)}`;
  pushEvent(t, `⏸ usage limit (${when}; ${t.autoResumes || 0}/${MAX_AUTO_RESUMES} automatic resumes done)`);
  log(`task ${t.id}: usage limit → ${WAITING}, resume_at ${resumeAt} (${plan.how}), resumes at ${new Date(plan.resumeAt + RESUME_DELAY).toISOString()}`);
  finish(t, WAITING, { ...fields, resumeAt, limitMessage: clip(String(text || ""), 300) || null });
  scheduler.poke();
}

async function autoResume(t) {
  if (t.status !== WAITING) return;
  // Same permission mode as the last run, re-checked against today's settings: never a wider one.
  const m = await checkMode(t.permissionMode);
  if (t.status !== WAITING) return; // stopped or replied to meanwhile
  const giveUp = (/** @type {string} */ why) => {
    log(`task ${t.id}: automatic resume impossible: ${why}`);
    finish(t, "error", { resumeAt: null, error: `Automatic resume impossible: ${why}` });
  };
  if (m.error) return giveUp(m.error);
  if (!t.sessionId) return giveUp("no Claude Code session to resume");
  try { resolveDir(t.cwd); } catch (e) { return giveUp(/** @type {Error} */ (e).message); }
  t.autoResumes = (t.autoResumes || 0) + 1;
  const line = `reprise automatique n°${t.autoResumes} à ${formatHM(Date.now())}`;
  t.autoResumeHistory = [...(t.autoResumeHistory || []), line];
  pushEvent(t, `🔁 ${line}`);
  log(`task ${t.id}: ${line} (${t.permissionMode})`);
  runClaude(t, AUTO_RESUME_MESSAGE, { resume: true });
}

const scheduler = createResumeScheduler({
  getTasks: () => tasks.values(), launch: autoResume,
  delayMs: RESUME_DELAY, spacingMs: RESUME_SPACING, checkMs: RESUME_CHECK,
  onTick: () => refreshAwake(),
});

// ---------- keep the Mac awake while something runs or waits ----------
const keepAwake = createKeepAwake({ enabled: KEEP_AWAKE, spawn, bin: CAFFEINATE_BIN, log });
function refreshAwake() {
  keepAwake.update([...tasks.values()].some((t) => t.proc || LIVE.has(t.status) || t.status === WAITING));
}

// waitFor(t, seconds, signal) is in lib.js: "settled", "timeout" or "aborted" (client gave up).

// Long wait (until_done): wait for the end of the run, up to maxMinutes. Sends MCP progress
// notifications while waiting when the client supplied a progressToken, so clients that reset
// their timeout on progress keep the call open.
// Returns why the wait ended and which limit applied: the safety limit (default 70 s, so the
// call comes back with "running" before a remote session cuts it at ~80 s) or max_minutes.
async function waitUntilDone(t, { maxMinutes, safetySeconds }, extra) {
  const budget = untilDoneBudget({ maxMinutes, safetySeconds });
  const token = extra?._meta?.progressToken;
  let ticker = null, n = 0;
  if (token !== undefined && LIVE.has(t.status)) {
    const ping = () => {
      n += 1;
      const last = t.events[t.events.length - 1] || "";
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: clip(`${t.status}: ${last}`, 200) } }).catch(() => {});
    };
    ping();
    ticker = setInterval(ping, PROGRESS_EVERY_S * 1000);
  }
  try { return { why: await waitFor(t, budget.seconds, extra?.signal), ...budget, maxMinutes }; }
  finally { clearInterval(ticker); }
}

/** Options of an until_done call → what waitUntilDone needs. */
const untilDoneOpts = (/** @type {number | undefined} */ max_minutes, /** @type {number | undefined} */ safety_seconds) =>
  ({ maxMinutes: max_minutes ?? DEFAULT_UNTIL_DONE_MIN, safetySeconds: safety_seconds ?? UNTIL_DONE_SAFETY_S });

// What the tool returns after a wait. If the client already gave up on the request, don't
// build a report: the progress cursor stays put, so the next cc_wait gets every line.
/**
 * @param {any} t
 * @param {string | { why: string, seconds: number, limit: string, maxMinutes: number }} w
 *   "settled"/"timeout"/"aborted", or the result of waitUntilDone
 */
function afterWait(t, w) {
  const long = typeof w === "object" ? w : null;
  const why = long ? long.why : w;
  if (why === "aborted") return fail("Request cancelled by the client. The Claude Code task keeps running: call cc_wait with this task_id to follow it.");
  const r = report(t);
  if (long && why === "timeout" && LIVE.has(t.status)) {
    const o = JSON.parse(r.content[0].text);
    o.note = long.limit === "safety"
      ? `Still running; returned after the ${long.seconds} s safety limit so that this call isn't cut by the client (remote sessions stop calls at about 80 s). Nothing was interrupted: call cc_wait again (until_done: true) to keep waiting, or cc_stop it.`
      : `Still running after max_minutes (${long.maxMinutes}). Nothing was interrupted: call cc_wait again (until_done: true) to keep waiting, or cc_stop it.`;
    r.content[0].text = JSON.stringify(o, null, 1);
  }
  return r;
}

const NEXT_STEP = {
  running: "Still working. Call cc_wait again with this task_id, preferably with until_done: true so it returns only when the task finishes or needs you (don't start a new task, don't narrate each check to the user).",
  needs_input: "Claude Code asked questions. Answer them yourself with cc_reply if the answer is in this conversation or is a sensible default; ask the user only for what you truly cannot know or decide.",
  needs_permission: "Some actions were blocked by permissions (see permission_denials); the rest of the work may be done. Ask the user whether to allow them, then cc_reply with a wider permission_mode, or tell Claude Code to do without.",
  done: "Finished. Read the report and check it answers the brief; if not, cc_reply with what's missing. Then tell the user the outcome in a few lines (not the raw log).",
  error: "Failed. Explain the error to the user in plain words; retry with cc_reply (same session) or cc_start if it makes sense.",
  stopped: "Stopped. The session is kept: cc_reply continues it.",
  [WAITING]: "Claude Code hit its usage limit. The bridge resumes this same session by itself at resume_at + 2 min, in the same permission mode, with a message asking it to pick up exactly where it stopped: nothing to do. Tell the user in one line when it will resume; don't poll (cc_wait later if you want the outcome). cc_reply resumes it now instead (it may hit the limit again); cc_stop cancels the automatic resume.",
  interrupted: "The Claude app closed while this task was running. cc_reply (e.g. 'continue where you stopped') resumes the same session.",
};

function report(t) {
  const fresh = t.events.slice(t.cursor);
  t.cursor = t.events.length;
  const live = LIVE.has(t.status);
  // Once finished, the last message *is* the report: don't send it twice.
  const norm = (x) => x.replace(/\s+/g, " ").trim();
  const rep = !live && t.result ? norm(t.result) : "";
  const kept = rep ? fresh.filter((l) => !(l.startsWith("💬 ") && rep.startsWith(norm(l.slice(2)).replace(/…$/, "")))) : fresh;
  const shown = kept.slice(-MAX_EVENTS_SHOWN);
  const out = {
    task_id: t.id,
    status: t.status,
    title: t.title || undefined,
    cwd: t.cwd,
    permission_mode: t.permissionMode,
    session_id: t.sessionId,
    runs: t.runs,
    elapsed_s: Math.round((t.durationMs + (t.runStartedAt ? Date.now() - t.runStartedAt : 0)) / 1000),
    cost_usd: Math.round(t.costUsd * 10000) / 10000,
    progress: shown,
    earlier_progress_lines_skipped: kept.length > shown.length ? kept.length - shown.length : undefined,
    next_step: NEXT_STEP[t.status] || "",
  };
  if (t.status === WAITING) {
    out.resume_at = t.resumeAt;
    out.resumes_at_local = t.resumeAt ? formatHM(Date.parse(t.resumeAt) + RESUME_DELAY) : undefined;
  }
  if (t.autoResumes || t.status === WAITING) out.auto_resumes = `${t.autoResumes || 0}/${MAX_AUTO_RESUMES}`;
  if (t.autoResumeHistory?.length) out.auto_resume_history = t.autoResumeHistory;
  if (!live) {
    if (t.result) out.report = clip(t.result, MAX_RESULT_CHARS);
    if (t.questions?.length) out.questions = t.questions;
    if (t.denials?.length) out.permission_denials = t.denials;
    if (t.error) out.error = t.error;
    if (t.status === "done" && /\?\s*$/.test(t.result || "")) out.note = "The report ends with a question: Claude Code may be waiting for an answer.";
  }
  return { content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(out, null, 1) }] };
}

const fail = (/** @type {string} */ msg) => ({ isError: true, content: [{ type: /** @type {const} */ ("text"), text: msg }] });

function getTask(id) {
  const t = tasks.get(String(id).trim());
  if (!t) throw new Error(`Unknown task_id "${id}". Call cc_list to see tasks, or cc_start with session_id (and the same cwd) to resume an older Claude Code session.`);
  return t;
}

function otherLiveTaskIn(cwd, exceptId) {
  return [...tasks.values()].find((x) => x.id !== exceptId && LIVE.has(x.status) && x.cwd === cwd);
}

function resolveDir(cwd) {
  const dir = resolve(expandHome(cwd || DEFAULT_CWD));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  return realpathSync(dir); // same folder, same spelling (e.g. /tmp vs /private/tmp on macOS)
}

// ---------- MCP server ----------
const server = new McpServer(
  { name: "pont-claude-code", version: VERSION },
  {
    instructions: `Pont Claude Code lets you hand work to Claude Code on the user's computer and get the result back, so the user never copy-pastes between this chat and Claude Code.
How to work:
1. cc_start with a COMPLETE brief. Claude Code cannot see this conversation: include the goal, decisions already made, constraints, relevant facts the user gave you, and what "done" looks like. Pass the project folder as cwd.
2. While status is "running", call cc_wait with until_done: true: the call stays open until the task finishes, asks a question or is blocked (or max_minutes, default ${DEFAULT_UNTIL_DONE_MIN}, max ${MAX_UNTIL_DONE_MIN}), so you don't have to poll.${UNTIL_DONE_SAFETY_S ? ` For safety it comes back by itself after ${UNTIL_DONE_SAFETY_S} s with status "running" (remote sessions cut calls at about 80 s): just call cc_wait with until_done: true again.` : ""} If such a call ends in a timeout error, nothing is lost: the task keeps running and the next cc_wait picks it up; then fall back to plain cc_wait calls (${MAX_WAIT_S} s max each). Don't narrate each check to the user.
3. "needs_input": answer Claude Code's questions yourself with cc_reply whenever the answer is in this conversation or is a sensible default. Interrupt the user only for information or decisions only they have.
4. "needs_permission": tell the user what was blocked and ask; then cc_reply with the permission_mode they accept.
5. "waiting_limit": Claude Code hit its usage limit; the bridge resumes the same session by itself after the reset (resume_at + 2 min). Tell the user when, and don't poll.
6. "done": check the report against the brief (cc_reply for anything missing), then give the user a short summary, and only then ask any open questions.
For follow-up work on the same project, prefer cc_reply on the same task: Claude Code keeps its context.`,
  }
);

const modeSchema = z.string().optional().describe("Claude Code permission mode: acceptEdits (edit files, other actions need approval), auto (Claude Code decides what is safe), manual (nothing without approval), dontAsk (only pre-allowed tools), plan (read and plan only), bypassPermissions (everything; only if enabled in settings).");

server.registerTool("cc_start", {
  title: "Start a Claude Code task",
  description: "Start Claude Code on the user's computer in a project folder with a full brief. Returns a task_id and waits up to wait_seconds. To continue a session started elsewhere (e.g. in the terminal), pass its session_id and the same cwd.",
  inputSchema: {
    prompt: z.string().min(1).describe("Complete, self-contained brief for Claude Code."),
    cwd: z.string().optional().describe(`Project folder (absolute or ~/...). Default: ${DEFAULT_CWD}`),
    permission_mode: modeSchema,
    session_id: z.string().optional().describe("Resume this existing Claude Code session instead of starting a new one."),
    title: z.string().optional().describe("Short label for the task."),
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).optional().describe(`Seconds to wait before returning (default 30, max ${MAX_WAIT_S}).`),
  },
  annotations: { title: "Start a Claude Code task", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ prompt, cwd, permission_mode, session_id, title, wait_seconds }) => {
  let dir;
  try { dir = resolveDir(cwd); } catch (e) { return fail(e.message); }
  const m = await checkMode(permission_mode || await defaultMode());
  if (m.error) return fail(m.error);
  const sid = session_id?.trim();
  if (sid && !/^[0-9a-f-]{8,}$/i.test(sid)) return fail(`session_id "${sid}" doesn't look like a Claude Code session id (a UUID).`);
  const busy = otherLiveTaskIn(dir);
  const t = newTask({ cwd: dir, permissionMode: m.mode, sessionId: sid, title });
  runClaude(t, prompt, { resume: !!sid });
  await waitFor(t, wait_seconds ?? 30);
  const r = report(t);
  if (busy) {
    const o = JSON.parse(r.content[0].text);
    o.warning = `Task ${busy.id} is also running in this folder; the two may edit the same files.`;
    r.content[0].text = JSON.stringify(o, null, 1);
  }
  return r;
});

const untilDoneSchema = z.boolean().optional().describe(`Wait until the run ends (done, needs_input, needs_permission, error, stopped, interrupted) instead of at most ${MAX_WAIT_S} s, up to max_minutes, or until the safety limit (safety_seconds, ${UNTIL_DONE_SAFETY_S ? UNTIL_DONE_SAFETY_S + " s here" : "off here"}). Use it for any task that may take more than a minute: the call stays open and returns once there is something to act on. If it comes back with status "running", or ends in a timeout error, the task keeps running; call cc_wait again.`);
const maxMinutesSchema = z.number().positive().max(MAX_UNTIL_DONE_MIN).optional().describe(`With until_done: longest wait in minutes (default ${DEFAULT_UNTIL_DONE_MIN}, max ${MAX_UNTIL_DONE_MIN}). If reached, the task keeps running and the usual report comes back with status "running".`);
const safetySchema = z.number().min(0).max(MAX_UNTIL_DONE_MIN * 60).optional().describe(`With until_done: return on its own with status "running" after this many seconds, before a client that cuts long calls (remote sessions: about 80 s) drops it. Default ${UNTIL_DONE_SAFETY_S} (extension setting; ${DEFAULT_SAFETY_S} unless changed). 0 = no safety limit, wait up to max_minutes.`);

server.registerTool("cc_wait", {
  title: "Follow a Claude Code task",
  description: `Wait until the task stops running (or seconds elapse) and return its status, new progress lines and, when finished, its report, questions or blocked actions. Without until_done it returns within ${MAX_WAIT_S} s. With until_done: true it waits for the end of the run (up to max_minutes, default ${DEFAULT_UNTIL_DONE_MIN}${UNTIL_DONE_SAFETY_S ? `; it comes back by itself with "running" after the ${UNTIL_DONE_SAFETY_S} s safety limit` : ""}): prefer this for long tasks instead of calling every ${MAX_WAIT_S} s. Waiting never interrupts the task.`,
  inputSchema: {
    task_id: z.string(),
    seconds: z.number().min(0).max(MAX_WAIT_S).optional().describe(`Default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}. Ignored when until_done is true.`),
    until_done: untilDoneSchema,
    max_minutes: maxMinutesSchema,
    safety_seconds: safetySchema,
  },
  annotations: { title: "Follow a Claude Code task", readOnlyHint: true, openWorldHint: false },
}, async ({ task_id, seconds, until_done, max_minutes, safety_seconds }, extra) => {
  try {
    const t = getTask(task_id);
    if (until_done) return afterWait(t, await waitUntilDone(t, untilDoneOpts(max_minutes, safety_seconds), extra));
    return afterWait(t, await waitFor(t, seconds ?? DEFAULT_WAIT_S, extra?.signal));
  } catch (e) { return fail(e.message); }
});

server.registerTool("cc_reply", {
  title: "Reply to a Claude Code task",
  description: `Send a message into the same Claude Code session: answers to its questions, corrections, or the next step. Optionally change the permission mode. until_done: true waits for the end of the new run (like cc_wait until_done); if that call times out, the run keeps going: follow it with cc_wait, don't send the reply again.`,
  inputSchema: {
    task_id: z.string(),
    message: z.string().min(1),
    permission_mode: modeSchema,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).optional().describe("Default 30. Ignored when until_done is true."),
    until_done: untilDoneSchema,
    max_minutes: maxMinutesSchema,
    safety_seconds: safetySchema,
  },
  annotations: { title: "Reply to a Claude Code task", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ task_id, message, permission_mode, wait_seconds, until_done, max_minutes, safety_seconds }, extra) => {
  try {
    const t = getTask(task_id);
    if (LIVE.has(t.status)) return fail("This task is still running. Call cc_wait first, or cc_stop it.");
    if (!t.sessionId) return fail("This task has no Claude Code session to resume; use cc_start.");
    if (permission_mode) {
      const m = await checkMode(permission_mode);
      if (m.error) return fail(m.error);
      t.permissionMode = m.mode;
    }
    try { resolveDir(t.cwd); } catch (e) { return fail(e.message); }
    runClaude(t, message, { resume: true });
    if (until_done) return afterWait(t, await waitUntilDone(t, untilDoneOpts(max_minutes, safety_seconds), extra));
    return afterWait(t, await waitFor(t, wait_seconds ?? 30, extra?.signal));
  } catch (e) { return fail(e.message); }
});

server.registerTool("cc_stop", {
  title: "Stop a Claude Code task",
  description: "Interrupt a running task, including commands it launched, or cancel the automatic resume of a task waiting for its usage limit. The session is kept and cc_reply can continue it.",
  inputSchema: { task_id: z.string() },
  annotations: { title: "Stop a Claude Code task", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ task_id }) => {
  try {
    const t = getTask(task_id);
    if (t.status === WAITING) {
      pushEvent(t, "⏹ automatic resume cancelled (cc_stop)");
      log(`task ${t.id}: automatic resume cancelled`);
      finish(t, "stopped", { resumeAt: null });
      scheduler.poke();
    } else if (t.proc) {
      t.status = "stopped";
      killTree(t.proc);
      await new Promise((r) => { const p = t.proc; if (!p) return r(); p.once("close", r); setTimeout(r, 6000).unref(); });
    }
    return report(t);
  } catch (e) { return fail(e.message); }
});

server.registerTool("cc_list", {
  title: "List Claude Code tasks",
  description: "List recent tasks (kept across app restarts; tasks waiting for a usage limit show resume_at) and the bridge's setup: where Claude Code was found, default folder and permission mode, automatic resume, keep-awake.",
  inputSchema: {},
  annotations: { title: "List Claude Code tasks", readOnlyHint: true, openWorldHint: false },
}, async () => {
  const list = [...tasks.values()].slice(-20).reverse().map((t) => ({
    task_id: t.id, title: t.title || undefined, status: t.status, cwd: t.cwd, session_id: t.sessionId,
    runs: t.runs, started_at: t.startedAt, ended_at: t.endedAt || undefined,
    resume_at: t.status === WAITING ? t.resumeAt : undefined,
    resumes_at_local: t.status === WAITING && t.resumeAt ? formatHM(Date.parse(t.resumeAt) + RESUME_DELAY) : undefined,
    auto_resumes: t.autoResumes || t.status === WAITING ? `${t.autoResumes || 0}/${MAX_AUTO_RESUMES}` : undefined,
  }));
  const modes = await getPermissionModes();
  const warnings = [...configWarnings];
  if (DEFAULT_MODE === "bypassPermissions") warnings.unshift("mode par défaut dangereux, préférez acceptEdits");
  const setup = {
    version: VERSION, claude: CLAUDE_BIN, default_cwd: DEFAULT_CWD,
    permission_modes: modes, default_permission_mode: DEFAULT_MODE, bypass_allowed: ALLOW_BYPASS,
    until_done_safety_s: UNTIL_DONE_SAFETY_S,
    auto_resume: { enabled: AUTO_RESUME, max_per_task: MAX_AUTO_RESUMES, delay_after_reset_s: RESUME_DELAY / 1000, spacing_s: RESUME_SPACING / 1000, waiting: [...tasks.values()].filter((t) => t.status === WAITING).length },
    keep_awake: keepAwake.status,
    allowed_tools: ALLOWED_TOOLS || undefined, model: MODEL || undefined,
    warnings: warnings.length ? warnings : undefined,
  };
  return { content: [{ type: "text", text: JSON.stringify({ setup, tasks: list }, null, 1) }] };
});

// ---------- lifecycle ----------
loadTasks();
scheduler.start(); // re-arms waiting tasks; those already due resume right away (20 s apart)
refreshAwake();
const transport = new StdioServerTransport();
await server.connect(transport);
log(`v${VERSION} ready — claude: ${CLAUDE_BIN}, default cwd: ${DEFAULT_CWD}, mode setting: ${MODE_SETTING || "(empty)"}, until_done safety: ${UNTIL_DONE_SAFETY_S} s, auto-resume: ${AUTO_RESUME ? "on" : "off"}, keep awake: ${KEEP_AWAKE ? "on" : "off"}`);
for (const t of tasks.values()) if (t.status === WAITING) log(`task ${t.id}: ${WAITING}, resume_at ${t.resumeAt} (re-armed)`);
for (const w of configWarnings) log("warning:", w);
getPermissionModes().then((m) => {
  log("permission modes:", m.join(", "), "— default:", DEFAULT_MODE);
  if (DEFAULT_MODE === "bypassPermissions") log("warning: mode par défaut dangereux, préférez acceptEdits");
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();   // waiting tasks stay waiting_limit in tasks.json and are re-armed at the next start
  keepAwake.stop();
  for (const t of tasks.values()) if (t.proc) { killTree(t.proc); t.status = "interrupted"; pushEvent(t, "⚠️ interrupted: the Claude app closed"); }
  saveNow();
  setTimeout(() => process.exit(0), 200).unref();
}
process.stdin.on("end", shutdown);  // the Claude app closed the connection
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
