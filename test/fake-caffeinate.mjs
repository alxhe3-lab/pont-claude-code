#!/usr/bin/env node
// Stand-in for macOS `caffeinate` in the tests: records its start and stop, honours -w <pid>.
import { appendFileSync } from "node:fs";
const log = (what) => process.env.FAKE_CAFFEINATE_LOG && appendFileSync(process.env.FAKE_CAFFEINATE_LOG, JSON.stringify({ what, pid: process.pid, args: process.argv.slice(2) }) + "\n");
log("start");
const a = process.argv.slice(2);
const w = a.includes("-w") ? Number(a[a.indexOf("-w") + 1]) : 0;
const bye = (what) => { log(what); process.exit(0); };
process.on("SIGTERM", () => bye("stop"));
process.on("SIGINT", () => bye("stop"));
setInterval(() => { if (w) { try { process.kill(w, 0); } catch { bye("parent gone"); } } }, 300);
