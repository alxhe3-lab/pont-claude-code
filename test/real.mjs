// Live check against the real Claude Code (uses your Claude Code quota a little).
// Usage: node test/real.mjs   (creates a scratch project in the system temp folder)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const here = dirname(fileURLToPath(import.meta.url));
const proj = mkdtempSync(join(tmpdir(), "pont-real-"));
const state = mkdtempSync(join(tmpdir(), "pont-real-state-"));
const t = new StdioClientTransport({ command: process.execPath, args: [process.env.PONT_SERVER ? join(here, "..", process.env.PONT_SERVER) : join(here, "../server/index.js")],
  env: { ...process.env, PONT_STATE_DIR: state, PONT_DEFAULT_CWD: proj }, stderr: "inherit" });
const c = new Client({ name: "real", version: "0" }); await c.connect(t);
const j = async (n, a) => { const r = await c.callTool({ name: n, arguments: a }); return JSON.parse(r.content[0].text); };
const until = async (r) => { while (r.status === "running") r = await j("cc_wait", { task_id: r.task_id, seconds: 45 }); return r; };
const show = (label, r) => console.log(`\n== ${label}: ${r.status} (${r.elapsed_s}s)\n progress: ${JSON.stringify(r.progress)}\n questions: ${JSON.stringify(r.questions)}\n denials: ${JSON.stringify(r.permission_denials)}\n report: ${(r.report || r.error || "").slice(0, 400)}`);
console.log((await j("cc_list", {})).setup);

let r = await until(await j("cc_start", { title: "real test", prompt:
  "Crée le fichier hello.txt contenant exactement le mot bonjour. Ensuite, pour un deuxième fichier hello2.txt, tu dois savoir dans quelle langue écrire la salutation : c'est une information que seul le pilote a, ne la devine pas, pose la question au format prévu et arrête-toi." }));
show("start", r);
assert.equal(r.status, "needs_input"); assert.ok(r.questions.length >= 1);
assert.equal(readFileSync(join(proj, "hello.txt"), "utf8").trim(), "bonjour");
const sid = r.session_id;
r = await until(await j("cc_reply", { task_id: r.task_id, message: "Anglais : écris hello dans hello2.txt." }));
show("reply", r);
assert.equal(r.status, "done"); assert.equal(r.session_id, sid);
assert.match(readFileSync(join(proj, "hello2.txt"), "utf8"), /hello/i);

r = await until(await j("cc_start", { prompt: "Exécute la commande shell `curl -sI https://example.com` et donne le code HTTP.", permission_mode: "acceptEdits" }));
show("permission", r);
assert.equal(r.status, "needs_permission");
await c.close();
console.log("\nREAL TEST PASSED in", proj);
