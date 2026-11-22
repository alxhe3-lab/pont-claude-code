#!/usr/bin/env node
// Stand-in for the `claude` CLI, mimicking Claude Code 2.x in print mode:
// prompt on stdin, --output-format stream-json, --session-id / --resume, --append-system-prompt-file.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, promptLen: prompt.length, prompt: prompt.slice(0, 300), cwd: process.cwd() }) + "\n");
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
// Usage limit. LIMITHIT: the real message of 20/11 (resets 3:10am Bucharest). LIMITN<k>: the first k
// runs of this session (the first one and k-1 resumes) end on a limit whose reset time can't be read.
const limitFile = process.env.FAKE_LIMIT_DIR ? join(process.env.FAKE_LIMIT_DIR, `limit-${sid}`) : null;
const ln = prompt.match(/LIMITN(\d+)/);
if (ln && limitFile) writeFileSync(limitFile, ln[1]);
const left = limitFile && existsSync(limitFile) ? Number(readFileSync(limitFile, "utf8")) : 0;
if (left > 0 || prompt.includes("LIMITHIT")) {
  if (left > 0 && limitFile) writeFileSync(limitFile, String(left - 1));
  const hit = prompt.includes("LIMITHIT");
  const text = hit ? "You've hit your 5-hour limit · resets 3:10am (Europe/Bucharest)" : "Claude usage limit reached.";
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", ...(hit ? { resetsAt: Math.floor(Date.now() / 1000) + 3600 } : {}) } });
  out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: true, session_id: sid, result: text, num_turns: 1, total_cost_usd: 0, permission_denials: [] });
  process.exit(0);
}
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
