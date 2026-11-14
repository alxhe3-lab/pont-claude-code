#!/usr/bin/env node
// Stand-in for the `claude` CLI, mimicking Claude Code 2.x in print mode:
// prompt on stdin, --output-format stream-json, --session-id / --resume, --append-system-prompt-file.
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const a = process.argv.slice(2);
const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);
if (a.includes("--help")) {
  console.log(`Usage: claude [options]\n  --permission-mode <mode>   Permission mode to use for the session\n                             (choices: "acceptEdits", "auto", "bypassPermissions", "manual",\n                             "dontAsk", "plan")\n  -p, --print  Print response and exit`);
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let prompt = "";
for await (const c of process.stdin) prompt += c;
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, promptLen: prompt.length, cwd: process.cwd() }) + "\n");
const rules = opt("--append-system-prompt-file");
if (!rules || !existsSync(rules) || !readFileSync(rules, "utf8").includes("BRIDGE_QUESTION:")) { console.error("rules file missing"); process.exit(3); }
const resume = opt("--resume");
if (resume === "00000000-dead-beef-0000-000000000000") { console.error("No conversation found with session ID: " + resume); process.exit(1); }
const sid = resume || opt("--session-id");
if (!sid) { console.error("no session id"); process.exit(2); }
out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), permissionMode: opt("--permission-mode") });
await sleep(200);
out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: "Je regarde le projet." }, { type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } });
out({ type: "assistant", session_id: sid, parent_tool_use_id: "toolu_x", message: { content: [{ type: "text", text: "SUBAGENT NOISE" }] } });
if (prompt.includes("RATE")) out({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } });
if (prompt.includes("LONG")) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" }); // e.g. a dev server launched by Claude Code
  if (process.env.FAKE_CHILD_PID_FILE) appendFileSync(process.env.FAKE_CHILD_PID_FILE, child.pid + "\n");
  await sleep(60000);
}
const slow = prompt.match(/SLOW(\d+)/); // a long task that keeps reporting progress, then finishes
if (slow) {
  const end = Date.now() + Number(slow[1]);
  for (let i = 1; Date.now() < end; i++) {
    out({ type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `src/part${i}.js` } }] } });
    await sleep(Math.min(400, Math.max(0, end - Date.now())));
  }
}
if (prompt.includes("CRASH")) { console.error("boom: something broke"); process.exit(1); }
await sleep(Number(process.env.FAKE_DELAY_MS || 800));
let result = `Fait. app.js modifié. (prompt ${prompt.length} car.: ${prompt.slice(0, 30)})`, denials = [], is_error = false;
if (!resume && prompt.includes("ASK")) result = "J'ai besoin d'une info.\nBRIDGE_QUESTION: Quel port utiliser ?\nBRIDGE_QUESTION: Quelle base de données ?";
if (prompt.includes("DENY")) denials = [{ tool_name: "Bash", tool_input: { command: "npm publish", description: "publish" } }];
if (prompt.includes("APIERR")) { is_error = true; result = "API Error: overloaded"; }
if (prompt.includes("QMARK")) result = "Tout est prêt. Tu veux que je déploie aussi ?";
out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: result }] } });
out({ type: "result", subtype: is_error ? "error_during_execution" : "success", is_error, session_id: sid, result, num_turns: 3, total_cost_usd: 0.01, permission_denials: denials });
