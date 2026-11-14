// End-to-end tests of the MCP server against a fake Claude Code.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const state = mkdtempSync(join(tmpdir(), "pont-state-"));
const proj = realpathSync(mkdtempSync(join(tmpdir(), "pont-proj-")));
const logFile = join(state, "fake.log"), pidFile = join(state, "child.pid");
const CLAUDE = process.env.REAL_CLAUDE ? undefined : join(here, "fake-claude.mjs");

async function connect(extraEnv = {}) {
  const env = { ...process.env, PONT_STATE_DIR: state, PONT_DEFAULT_CWD: proj, FAKE_LOG: logFile, FAKE_CHILD_PID_FILE: pidFile, ...extraEnv };
  if (CLAUDE) env.CLAUDE_BIN = CLAUDE;
  const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.PONT_SERVER ? join(here, "..", process.env.PONT_SERVER) : join(here, "../server/index.js")], env, stderr: "pipe" });
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(transport);
  c.j = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) return { isError: true, text: r.content[0].text }; return JSON.parse(r.content[0].text); };
  return c;
}
const ok = (m) => console.log("✓", m);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let c = await connect();
const tools = (await c.listTools()).tools;
assert.deepEqual(tools.map((t) => t.name).sort(), ["cc_list", "cc_reply", "cc_start", "cc_stop", "cc_wait"]);
assert.ok(tools.find((t) => t.name === "cc_wait").annotations.readOnlyHint);
assert.match(c.getInstructions(), /COMPLETE brief/);
ok("5 tools, annotations, instructions");

const setup = (await c.j("cc_list")).setup;
assert.deepEqual(setup.permission_modes, ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
assert.equal(setup.default_permission_mode, "acceptEdits");
ok("permission modes read from claude --help");

// question flow: start returns while running, wait surfaces 2 questions, reply resumes same session
let r = await c.j("cc_start", { prompt: "Ajoute un serveur. ASK", title: "serveur", wait_seconds: 0.1 });
assert.equal(r.status, "running");
r = await c.j("cc_wait", { task_id: r.task_id, seconds: 10 });
assert.equal(r.status, "needs_input");
assert.deepEqual(r.questions, ["Quel port utiliser ?", "Quelle base de données ?"]);
assert.ok(!r.progress.some((l) => l.includes("SUBAGENT")), "sub-agent lines filtered");
assert.ok(r.progress.some((l) => l.includes("🔧 Bash: ls -la")));
const sid = r.session_id, qid = r.task_id;
assert.match(sid, /^[0-9a-f-]{36}$/);
r = await c.j("cc_reply", { task_id: qid, message: "Port 3000, SQLite.", wait_seconds: 10 });
assert.equal(r.status, "done"); assert.equal(r.session_id, sid); assert.equal(r.runs, 2);
assert.ok(!r.progress.some((l) => l.includes("Fait. app.js")), "final message not duplicated in progress");
assert.ok(r.cost_usd > 0.019);
ok("question → reply in the same session → done");

// the prompt goes via stdin and the session id is fixed with --session-id
const runs = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => !x.args.includes("--help"));
assert.ok(runs[0].args.includes("--session-id") && !runs[0].args.includes("Ajoute un serveur. ASK"));
assert.ok(runs[1].args.includes("--resume"));
assert.equal(runs[0].cwd, proj);
ok("prompt via stdin, --session-id then --resume, default cwd");

// very long brief (no argv limit)
r = await c.j("cc_start", { prompt: "x".repeat(300000), wait_seconds: 10 });
assert.equal(r.status, "done"); assert.match(r.report, /300000 car/);
ok("300 KB brief");

// permissions
r = await c.j("cc_start", { prompt: "Publie. DENY", wait_seconds: 10 });
assert.equal(r.status, "needs_permission"); assert.deepEqual(r.permission_denials, [{ tool: "Bash", input: "npm publish" }]);
r = await c.j("cc_reply", { task_id: r.task_id, message: "ok", permission_mode: "bypassPermissions" });
assert.ok(r.isError && /disabled/.test(r.text));
r = await c.j("cc_start", { prompt: "x", permission_mode: "nope" });
assert.ok(r.isError && /accepts: acceptEdits/.test(r.text));
r = await c.j("cc_start", { prompt: "x", permission_mode: "default", wait_seconds: 10 });
assert.equal(r.permission_mode, "manual");
ok("denials surfaced; bypass refused unless enabled; bad mode refused; default→manual");

// errors
r = await c.j("cc_start", { prompt: "CRASH", wait_seconds: 10 });
assert.equal(r.status, "error"); assert.match(r.error, /boom/);
r = await c.j("cc_start", { prompt: "APIERR", wait_seconds: 10 });
assert.equal(r.status, "error"); assert.match(r.error, /overloaded/);
r = await c.j("cc_start", { prompt: "x", session_id: "00000000-dead-beef-0000-000000000000", wait_seconds: 10 });
assert.equal(r.status, "error"); assert.match(r.error, /must be the folder/);
assert.ok((await c.j("cc_start", { prompt: "x", cwd: "/nope/nope" })).isError);
assert.ok((await c.j("cc_start", { prompt: "x", session_id: "pas un id" })).isError);
assert.ok((await c.j("cc_wait", { task_id: "zzz" })).isError);
ok("crash, API error, unknown session, bad folder, bad id, unknown task");

// question-mark heuristic, rate limit warning
r = await c.j("cc_start", { prompt: "QMARK RATE", wait_seconds: 10 });
assert.equal(r.status, "done"); assert.ok(r.note);
r = await c.j("cc_wait", { task_id: r.task_id, seconds: 0 });
ok("trailing-question note");

// stop kills Claude Code and what it launched; parallel warning; reply while running refused
r = await c.j("cc_start", { prompt: "LONG", wait_seconds: 1 });
const longId = r.task_id;
const r2 = await c.j("cc_start", { prompt: "LONG", wait_seconds: 0.5 });
assert.match(r2.warning, /also running/);
assert.ok((await c.j("cc_reply", { task_id: longId, message: "x" })).isError);
await c.j("cc_stop", { task_id: r2.task_id });
r = await c.j("cc_stop", { task_id: longId });
assert.equal(r.status, "stopped");
await new Promise((res) => setTimeout(res, 500));
const pids = readFileSync(pidFile, "utf8").match(/\d+/g);
ok(`stop (child processes recorded: ${pids?.length ?? 0})`);

// until_done: a long task that finishes during the wait (well past `seconds`), with progress notifications
r = await c.j("cc_start", { prompt: "Gros travail. SLOW4000", wait_seconds: 0.2 });
assert.equal(r.status, "running");
const slowId = r.task_id;
let t0 = Date.now(), notes = 0;
let raw = await c.callTool({ name: "cc_wait", arguments: { task_id: slowId, until_done: true, seconds: 1 } }, undefined, { onprogress: () => { notes++; }, timeout: 120000 });
r = JSON.parse(raw.content[0].text);
assert.equal(r.status, "done"); assert.match(r.report, /SLOW4000/);
assert.ok(Date.now() - t0 > 3000, "waited past `seconds` until the end");
assert.ok(r.progress.some((l) => l.includes("src/part")), "progress lines kept");
assert.ok(notes >= 1, "progress notifications sent");
r = await c.j("cc_reply", { task_id: slowId, message: "Encore. SLOW1500", until_done: true });
assert.equal(r.status, "done"); assert.equal(r.runs, 2);
ok("until_done: long task finishes during the wait (cc_wait and cc_reply)");

// until_done reaches max_minutes: returns "running", nothing interrupted
r = await c.j("cc_start", { prompt: "LONG", wait_seconds: 0.2 });
const capId = r.task_id;
t0 = Date.now();
r = await c.j("cc_wait", { task_id: capId, until_done: true, max_minutes: 0.03 });
const took = Date.now() - t0;
assert.equal(r.status, "running"); assert.match(r.note, /max_minutes/);
assert.ok(took >= 1500 && took < 10000, `stopped waiting at max_minutes (${took} ms)`);
assert.equal((await c.j("cc_wait", { task_id: capId, seconds: 0 })).status, "running", "task still running");
assert.ok((await c.j("cc_wait", { task_id: capId, until_done: true, max_minutes: 121 }).catch((e) => ({ isError: true, text: e.message }))).isError, "max_minutes > 120 refused");
assert.equal((await c.j("cc_stop", { task_id: capId })).status, "stopped");
ok("until_done: max_minutes reached → still running, then stopped on request");

// the client gives up on the request (timeout): the task goes on and the next cc_wait finds it, with every line
r = await c.j("cc_start", { prompt: "Coupure. SLOW3000", wait_seconds: 0.2 });
const cutId = r.task_id;
await assert.rejects(c.callTool({ name: "cc_wait", arguments: { task_id: cutId, until_done: true } }, undefined, { timeout: 800 }), /timed out|timeout/i);
assert.equal((await c.j("cc_list")).tasks.find((x) => x.task_id === cutId).status, "running", "not interrupted by the client timeout");
r = await c.j("cc_wait", { task_id: cutId, until_done: true });
assert.equal(r.status, "done"); assert.match(r.report, /Coupure/);
assert.ok(r.progress.some((l) => l.includes("Bash: ls -la")), "lines from before the cut not lost");
ok("client timeout during until_done: task continues, next cc_wait gets it");

// restart: tasks persist, a running one becomes "interrupted", and can be resumed
r = await c.j("cc_start", { prompt: "LONG", title: "long one", wait_seconds: 0.5 });
const intId = r.task_id;
await c.close();
await new Promise((res) => setTimeout(res, 800));
assert.ok(existsSync(join(state, "tasks.json")));
c = await connect();
const list = (await c.j("cc_list")).tasks;
assert.equal(list.find((t) => t.task_id === intId).status, "interrupted");
assert.equal(list.find((t) => t.task_id === qid).status, "done");
r = await c.j("cc_reply", { task_id: intId, message: "continue", wait_seconds: 10 });
assert.equal(r.status, "done"); assert.equal(r.runs, 2);
ok("tasks survive a restart; interrupted task resumed");
await c.close();

// bypass allowed when enabled
c = await connect({ PONT_ALLOW_BYPASS: "true", PONT_PERMISSION_MODE: "${user_config.permission_mode}" });
r = await c.j("cc_start", { prompt: "x", permission_mode: "bypassPermissions", wait_seconds: 10 });
assert.equal(r.status, "done");
assert.equal((await c.j("cc_list")).setup.default_permission_mode, "acceptEdits");
await c.close();
c = await connect({ PONT_PERMISSION_MODE: "zzz" });
const s2 = (await c.j("cc_list")).setup;
assert.equal(s2.default_permission_mode, "acceptEdits"); assert.ok(s2.warnings.length);
await c.close();
ok("bypass when enabled; unfilled/invalid settings fall back safely");

// all child processes gone
await new Promise((res) => setTimeout(res, 1500));
const left = (readFileSync(pidFile, "utf8").match(/\d+/g) || []).map(Number).filter(alive);
assert.deepEqual(left, [], "no orphan processes");
ok("no orphan processes left");
console.log("ALL PASSED");
