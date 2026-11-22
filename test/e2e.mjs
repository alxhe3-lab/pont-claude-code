// End-to-end tests of the MCP server against a fake Claude Code.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const state = mkdtempSync(join(tmpdir(), "pont-state-"));
const proj = realpathSync(mkdtempSync(join(tmpdir(), "pont-proj-")));
const logFile = join(state, "fake.log"), pidFile = join(state, "child.pid"), cafLog = join(state, "caffeinate.log");
const CLAUDE = process.env.REAL_CLAUDE ? undefined : join(here, "fake-claude.mjs");

async function connect(extraEnv = {}) {
  const env = {
    ...process.env, PONT_STATE_DIR: state, PONT_DEFAULT_CWD: proj, FAKE_LOG: logFile, FAKE_CHILD_PID_FILE: pidFile,
    // automatic resume with short delays (in use: +2 min, 20 s apart, checked every 60 s, retry 30 min)
    FAKE_LIMIT_DIR: state, PONT_RESUME_DELAY_MS: "300", PONT_RESUME_SPACING_MS: "600", PONT_RESUME_CHECK_MS: "250", PONT_LIMIT_RETRY_MS: "500",
    // a stand-in for caffeinate: never keeps the Mac awake for real during the tests
    PONT_CAFFEINATE_BIN: join(here, "fake-caffeinate.mjs"), FAKE_CAFFEINATE_LOG: cafLog,
    ...extraEnv,
  };
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
assert.equal(setup.until_done_safety_s, 70);
ok("permission modes read from claude --help; until_done safety 70 s by default");

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

// until_done safety limit (70 s by default; shortened here): the call comes back by itself with "running"
r = await c.j("cc_start", { prompt: "LONG", wait_seconds: 0.2 });
const safeId = r.task_id;
t0 = Date.now();
r = await c.j("cc_wait", { task_id: safeId, until_done: true, safety_seconds: 1.5 });
let tookS = Date.now() - t0;
assert.equal(r.status, "running"); assert.match(r.note, /1\.5 s safety limit/);
assert.ok(tookS >= 1400 && tookS < 8000, `cc_wait returned at the safety limit (${tookS} ms)`);
assert.equal((await c.j("cc_stop", { task_id: safeId })).status, "stopped");
r = await c.j("cc_reply", { task_id: safeId, message: "LONG encore", until_done: true, safety_seconds: 1 });
assert.equal(r.status, "running"); assert.match(r.note, /safety limit/);
assert.equal((await c.j("cc_stop", { task_id: safeId })).status, "stopped");
ok("until_done safety limit: cc_wait and cc_reply come back with running, task untouched");

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

// mistyped "Permission mode" setting: one mode name inside → that mode; several → acceptEdits
c = await connect({ PONT_PERMISSION_MODE: "Allow bypassPermissions", PONT_ALLOW_BYPASS: "true", PONT_UNTIL_DONE_SAFETY_S: "2" });
let s3 = (await c.j("cc_list")).setup;
assert.equal(s3.default_permission_mode, "bypassPermissions"); assert.ok(s3.warnings.some((w) => /contains "bypassPermissions"/.test(w)));
assert.equal(s3.warnings[0], "mode par défaut dangereux, préférez acceptEdits", "cc_list warns about a bypassPermissions default");
r = await c.j("cc_start", { prompt: "x", wait_seconds: 10 });
assert.equal(r.permission_mode, "bypassPermissions");
assert.equal(s3.until_done_safety_s, 2);
r = await c.j("cc_start", { prompt: "LONG", wait_seconds: 0.2 });
t0 = Date.now();
r = await c.j("cc_wait", { task_id: r.task_id, until_done: true });
tookS = Date.now() - t0;
assert.equal(r.status, "running"); assert.ok(tookS >= 1900 && tookS < 8000, `setting used (${tookS} ms)`);
await c.j("cc_stop", { task_id: r.task_id });
await c.close();
c = await connect({ PONT_PERMISSION_MODE: "Allow bypassPermissions" }); // bypass not allowed
s3 = (await c.j("cc_list")).setup;
assert.equal(s3.default_permission_mode, "acceptEdits"); assert.ok(s3.warnings.some((w) => /needs "Allow bypassPermissions"/.test(w)));
await c.close();
c = await connect({ PONT_PERMISSION_MODE: "plan or auto" });
s3 = (await c.j("cc_list")).setup;
assert.equal(s3.default_permission_mode, "acceptEdits"); assert.ok(s3.warnings.some((w) => /several modes/.test(w)));
await c.close();
ok("mistyped mode setting: one mode inside → used; bypass still gated; several → acceptEdits + warning; safety setting");

// tasks.json: 50 most recent kept, older ones moved to tasks-archive.json, backup before the first write
const state2 = mkdtempSync(join(tmpdir(), "pont-state-archive-"));
const seed = Array.from({ length: 60 }, (_, i) => ({ id: `old${i}`, title: `t${i}`, cwd: proj, permissionMode: "acceptEdits", sessionId: null, status: "done", events: ["x"], runs: 1, startedAt: new Date(2026, 0, 1, 0, i).toISOString(), endedAt: new Date(2026, 0, 1, 0, i, 30).toISOString() }));
writeFileSync(join(state2, "tasks.json"), JSON.stringify({ version: "0.3.0", tasks: seed }, null, 1));
const seedText = readFileSync(join(state2, "tasks.json"), "utf8");
c = await connect({ PONT_STATE_DIR: state2 });
r = await c.j("cc_start", { prompt: "nouvelle", wait_seconds: 10 });
assert.equal(r.status, "done");
const newId = r.task_id;
await c.close();
await new Promise((res) => setTimeout(res, 800));
const kept = JSON.parse(readFileSync(join(state2, "tasks.json"), "utf8")).tasks;
const arch = JSON.parse(readFileSync(join(state2, "tasks-archive.json"), "utf8")).tasks;
assert.equal(kept.length, 50); assert.equal(kept[kept.length - 1].id, newId);
assert.deepEqual(arch, seed.slice(0, 11), "11 oldest moved unchanged");
assert.equal(readFileSync(join(state2, "tasks.before-0.3.1.json"), "utf8"), seedText, "backup of the original file");
assert.equal(readFileSync(join(state2, "tasks.before-0.4.0.json"), "utf8"), seedText, "0.4.0 backup too");
ok("tasks.json capped at 50, older tasks archived unchanged, backup made");

// ---------- usage limit → waiting_limit → automatic resume ----------
const { DEFAULT_RESUME_MESSAGE, formatHM } = await import("../server/autoresume.js");
const fakeRuns = (sid) => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.args.includes(sid));
const modeOf = (run) => run.args[run.args.indexOf("--permission-mode") + 1];
const cafEvents = () => (existsSync(cafLog) ? readFileSync(cafLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleepMs = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(c, id, pred, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await c.j("cc_wait", { task_id: id, seconds: 0.3 });
    if (pred(r) || Date.now() > end) return r;
    await sleepMs(150);
  }
}
const MAC = process.platform === "darwin";

// the real message of 20/11: waiting_limit until 3:10 (Bucharest), visible in cc_wait and cc_list; caffeinate on
c = await connect();
if (MAC) assert.equal((await c.j("cc_list")).setup.keep_awake.active, false, "no caffeinate while nothing runs");
const cafBefore = cafEvents().length;
r = await c.j("cc_start", { prompt: "Travail de nuit. LIMITHIT", permission_mode: "plan", wait_seconds: 10 });
assert.equal(r.status, "waiting_limit");
assert.equal(formatHM(Date.parse(r.resume_at), "Europe/Bucharest"), "03:10", "reset time read with its zone");
assert.ok(Date.parse(r.resume_at) > Date.now() && Date.parse(r.resume_at) - Date.now() <= 24 * 3600_000, "today or tomorrow");
assert.ok(r.progress.some((l) => l.includes("usage limit: rejected")) && r.progress.some((l) => l.startsWith("⏸ usage limit")));
assert.equal(r.auto_resumes, "0/6"); assert.match(r.next_step, /resumes this same session by itself/);
let L = await c.j("cc_list");
const lt = L.tasks.find((x) => x.task_id === r.task_id);
assert.equal(lt.status, "waiting_limit"); assert.equal(lt.resume_at, r.resume_at);
assert.equal(L.setup.auto_resume.enabled, true); assert.equal(L.setup.auto_resume.waiting, 1);
if (MAC) {
  assert.equal(L.setup.keep_awake.active, true, "caffeinate on while a task waits");
  const st = cafEvents().slice(cafBefore).filter((e) => e.what === "start");
  assert.ok(st.length >= 1); assert.deepEqual(st[0].args.slice(0, 2), ["-i", "-w"]);
}
r = await c.j("cc_stop", { task_id: r.task_id });
assert.equal(r.status, "stopped"); assert.equal(r.resume_at, undefined);
await sleepMs(400);
L = await c.j("cc_list");
if (MAC) {
  assert.equal(L.setup.keep_awake.active, false, "caffeinate off when nothing runs or waits");
  assert.ok(cafEvents().slice(cafBefore).some((e) => e.what === "stop"), "caffeinate stopped");
}
ok("limit message read (3:10 Europe/Bucharest) → waiting_limit in cc_wait/cc_list; cc_stop cancels; caffeinate on then off");

// unreadable time: new try after the retry delay; resumed by itself, same session, same mode, default message
r = await c.j("cc_start", { prompt: "Gros chantier. LIMITN2", permission_mode: "plan", wait_seconds: 10 });
assert.equal(r.status, "waiting_limit");
const autoId = r.task_id, autoSid = r.session_id;
r = await until(c, autoId, (x) => x.status === "done");
assert.equal(r.status, "done", "resumed twice by itself, then finished");
assert.equal(r.runs, 3); assert.equal(r.session_id, autoSid); assert.equal(r.auto_resumes, "2/6");
assert.equal(r.auto_resume_history.length, 2);
assert.match(r.auto_resume_history[0], /^reprise automatique n°1 à \d\d:\d\d$/);
assert.match(r.auto_resume_history[1], /^reprise automatique n°2 à \d\d:\d\d$/);
let fr = fakeRuns(autoSid);
assert.equal(fr.length, 3);
assert.deepEqual(fr.map(modeOf), ["plan", "plan", "plan"], "same permission mode for the automatic resumes");
assert.ok(fr[1].args.includes("--resume") && fr[2].args.includes("--resume"));
assert.equal(fr[1].prompt, DEFAULT_RESUME_MESSAGE); assert.ok(DEFAULT_RESUME_MESSAGE.startsWith("Ta limite d'usage est levée."));
ok("limit without a readable time → retried, resumed by itself (same session, same mode, the resume message), then done");

// at most 6 automatic resumes per task
r = await c.j("cc_start", { prompt: "Sans fin. LIMITN20", wait_seconds: 10 });
const capSid = r.session_id;
r = await until(c, r.task_id, (x) => x.status === "error", 40000);
assert.equal(r.status, "error"); assert.match(r.error, /6 automatic resumes already done/);
assert.equal(r.runs, 7); assert.equal(r.auto_resumes, "6/6"); assert.equal(r.auto_resume_history.length, 6);
assert.equal(fakeRuns(capSid).length, 7);
await c.close();
ok("at most 6 automatic resumes, then error");

// restart: waiting tasks from tasks.json (a copy of the real one if PONT_TASKS_COPY is set) are re-armed;
// a past one resumes right away; a future one stays armed; a bypass one isn't resumed once bypass is off
const state3 = mkdtempSync(join(tmpdir(), "pont-state-rearm-"));
let base = [];
if (process.env.PONT_TASKS_COPY) base = JSON.parse(readFileSync(process.env.PONT_TASKS_COPY, "utf8")).tasks || [];
else base = Array.from({ length: 10 }, (_, i) => ({ id: `vieux${i}`, cwd: proj, permissionMode: "acceptEdits", sessionId: null, status: "done", events: [], runs: 1 }));
const sidDue = "11111111-2222-3333-4444-555555555555", sidLater = "66666666-2222-3333-4444-555555555555", sidBy = "77777777-2222-3333-4444-555555555555";
const w = (id, sid, resumeAt, extra = {}) => ({ id, title: id, cwd: proj, permissionMode: "auto", sessionId: sid, status: "waiting_limit", events: ["⏸ usage limit"], runs: 1, resumeAt, autoResumes: 1, autoResumeHistory: ["reprise automatique n°1 à 03:12"], startedAt: new Date().toISOString(), ...extra });
writeFileSync(join(state3, "tasks.json"), JSON.stringify({ version: "0.4.0", tasks: [...base,
  w("echu", sidDue, "2026-11-20T01:10:00.000Z"),
  w("plustard", sidLater, new Date(Date.now() + 3 * 3600_000).toISOString()),
  w("bypass", sidBy, "2026-11-20T01:10:00.000Z", { permissionMode: "bypassPermissions" }),
] }, null, 1));
const runsBefore = readFileSync(logFile, "utf8").trim().split("\n").length;
c = await connect({ PONT_STATE_DIR: state3, PONT_AUTO_RESUME_MESSAGE: "Limite levée, reprends. FIN DU MESSAGE" });
r = await until(c, "echu", (x) => x.status === "done");
assert.equal(r.status, "done", "past resume time → resumed at start-up");
assert.equal(r.auto_resumes, "2/6"); assert.equal(r.auto_resume_history[1].slice(0, 26), "reprise automatique n°2 à ");
fr = fakeRuns(sidDue);
assert.equal(fr.length, 1); assert.equal(modeOf(fr[0]), "auto"); assert.equal(fr[0].prompt, "Limite levée, reprends. FIN DU MESSAGE", "message setting used");
r = await until(c, "bypass", (x) => x.status === "error");
assert.equal(r.status, "error"); assert.match(r.error, /Automatic resume impossible: bypassPermissions is disabled/);
assert.equal(fakeRuns(sidBy).length, 0, "never resumed with a mode the settings no longer allow");
L = await c.j("cc_list");
assert.equal(L.tasks.find((x) => x.task_id === "plustard").status, "waiting_limit", "future one still armed");
if (MAC) assert.equal(L.setup.keep_awake.active, true, "caffeinate on while a task waits");
const newRuns = readFileSync(logFile, "utf8").trim().split("\n").slice(runsBefore).map((l) => JSON.parse(l)).filter((x) => !x.args.includes("--help"));
assert.equal(newRuns.length, 1, "nothing else from the copied tasks.json was launched");
await c.close();
await sleepMs(800);
const saved3 = JSON.parse(readFileSync(join(state3, "tasks.json"), "utf8")).tasks;
assert.equal(saved3.find((x) => x.id === "plustard").status, "waiting_limit", "still waiting in tasks.json after closing");
assert.equal(saved3.length, Math.min(50, base.length + 3));
ok(`restart${process.env.PONT_TASKS_COPY ? " (copy of the real tasks.json)" : ""}: waiting tasks re-armed, past one resumed at once with the message setting, future one kept, bypass not resumed`);

// automatic resume off: a limit ends the run as before (error), with the reason
c = await connect({ PONT_AUTO_RESUME: "false" });
r = await c.j("cc_start", { prompt: "LIMITHIT", wait_seconds: 10 });
assert.equal(r.status, "error"); assert.match(r.error, /hit your 5-hour limit.*automatic resume is off/);
assert.equal((await c.j("cc_list")).setup.auto_resume.enabled, false);
await c.close();
ok("setting off: limit → error, no automatic resume");

// all child processes gone
await new Promise((res) => setTimeout(res, 1500));
const left = (readFileSync(pidFile, "utf8").match(/\d+/g) || []).map(Number).filter(alive);
assert.deepEqual(left, [], "no orphan processes");
const cafLeft = [...new Set(cafEvents().map((e) => e.pid))].filter(alive);
assert.deepEqual(cafLeft, [], "no caffeinate left");
ok("no orphan processes left");
console.log("ALL PASSED");
