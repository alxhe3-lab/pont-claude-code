// Unit tests of server/lib.js (run with: node --test test/unit.mjs).
// Every file test works in a fresh temporary folder: the real ~/.pont-claude-code is never used.
// To also run the archive test on a copy of a real tasks.json, put a copy somewhere and set
// PONT_TASKS_COPY=/path/to/that/copy (the copy itself is copied again into a temp folder).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveModeSetting, parseSafetySetting, untilDoneBudget, waitFor, DEFAULT_SAFETY_S,
  saveTaskFiles, readTaskFile,
} from "../server/lib.js";

// ---------- 1. mistyped "Permission mode" setting ----------
const MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
const ALIASES = { default: "manual" };
const res = (v, allowBypass = false) => resolveModeSetting(v, MODES, { aliases: ALIASES, allowBypass });

test("mode: exact names and aliases are unchanged, without warning", () => {
  assert.deepEqual(res("plan"), { mode: "plan", warnings: [] });
  assert.deepEqual(res("default"), { mode: "manual", warnings: [] });
  assert.deepEqual(res(""), { mode: "acceptEdits", warnings: [] });
  assert.deepEqual(res(undefined), { mode: "acceptEdits", warnings: [] });
  assert.deepEqual(res("  dontAsk "), { mode: "dontAsk", warnings: [] });
});

test("mode: a value that contains one mode name uses that mode (and says so in the log)", () => {
  const r = res("Allow bypassPermissions", true);
  assert.equal(r.mode, "bypassPermissions");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Allow bypassPermissions.*bypassPermissions/);
  assert.equal(res("plan please").mode, "plan");
  assert.equal(res("mode: auto").mode, "auto");
  assert.equal(res("acceptedits").mode, "acceptEdits", "case ignored");
  assert.equal(res("'dontAsk'").mode, "dontAsk");
  assert.equal(res("acceptEdits (default)").mode, "acceptEdits", "an alias doesn't count as a second mode");
});

test("mode: bypassPermissions found that way still needs Allow bypassPermissions", () => {
  const r = res("Allow bypassPermissions", false);
  assert.equal(r.mode, "acceptEdits");
  assert.ok(r.warnings.some((w) => /needs "Allow bypassPermissions"/.test(w)));
  assert.equal(res("bypassPermissions", false).mode, "acceptEdits", "exact name: same rule as before");
});

test("mode: several modes or none → acceptEdits as before, written in the log", () => {
  let r = res("auto or plan");
  assert.equal(r.mode, "acceptEdits");
  assert.match(r.warnings[0], /several modes \(auto, plan\)/);
  r = res("zzz");
  assert.equal(r.mode, "acceptEdits");
  assert.match(r.warnings[0], /isn't supported/);
  assert.equal(res("automatically").mode, "acceptEdits", "a word that merely starts with a mode name doesn't count");
  assert.equal(res("plan plan").mode, "plan", "the same mode twice is one mode");
});

// ---------- 2. until_done safety return (70 s) ----------
test("safety: 70 s by default; setting parsed; 0 = off", () => {
  assert.equal(DEFAULT_SAFETY_S, 70);
  assert.deepEqual(parseSafetySetting("", { max: 7200 }), { seconds: 70 });
  assert.deepEqual(parseSafetySetting(undefined, { max: 7200 }), { seconds: 70 });
  assert.deepEqual(parseSafetySetting("45", { max: 7200 }), { seconds: 45 });
  assert.deepEqual(parseSafetySetting("0", { max: 7200 }), { seconds: 0 });
  assert.deepEqual(parseSafetySetting("99999", { max: 7200 }), { seconds: 7200 });
  for (const bad of ["abc", "-5"]) {
    const r = parseSafetySetting(bad, { max: 7200 });
    assert.equal(r.seconds, 70); assert.match(r.warning || "", /isn't a number/);
  }
});

test("safety: the until_done wait is cut at 70 s (safety) unless max_minutes is shorter or safety is off", () => {
  assert.deepEqual(untilDoneBudget({ maxMinutes: 60, safetySeconds: 70 }), { seconds: 70, limit: "safety" });
  assert.deepEqual(untilDoneBudget({ maxMinutes: 120, safetySeconds: 70 }), { seconds: 70, limit: "safety" });
  assert.deepEqual(untilDoneBudget({ maxMinutes: 0.5, safetySeconds: 70 }), { seconds: 30, limit: "max_minutes" });
  assert.deepEqual(untilDoneBudget({ maxMinutes: 60, safetySeconds: 0 }), { seconds: 3600, limit: "max_minutes" });
});

test("safety: a wait on a task that keeps running returns 'timeout' at 70 s, not before (simulated clock)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const t = { status: "running", waiters: new Set() };
    const { seconds } = untilDoneBudget({ maxMinutes: 60, safetySeconds: DEFAULT_SAFETY_S });
    let outcome = null;
    const p = waitFor(t, seconds).then((w) => { outcome = w; });
    mock.timers.tick(69_999);
    await Promise.resolve();
    assert.equal(outcome, null, "still waiting at 69.999 s");
    mock.timers.tick(1);
    await p;
    assert.equal(outcome, "timeout");
    assert.equal(t.status, "running", "the task itself is untouched");
    assert.equal(t.waiters.size, 0, "listener removed");
  } finally { mock.timers.reset(); }
});

test("safety: a task that ends before 70 s returns 'settled' right away", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const t = { status: "running", waiters: new Set() };
    const p = waitFor(t, 70);
    mock.timers.tick(5_000);
    t.status = "done";
    for (const w of [...t.waiters]) w();
    assert.equal(await p, "settled");
  } finally { mock.timers.reset(); }
});

// ---------- 3. tasks.json: 50 most recent kept, the others archived ----------
const tmp = () => mkdtempSync(join(tmpdir(), "pont-unit-"));
const day = (i) => new Date(Date.UTC(2026, 9, 1) + i * 3600_000).toISOString();
// A task as saveNow() writes it (about 2.9 KB each, like the ~145 KB / 50 tasks real file).
const fakeTask = (i, extra = {}) => ({
  id: `t${String(i).padStart(4, "0")}`, title: `tâche ${i}`, cwd: "/Users/x/projet", permissionMode: "acceptEdits",
  sessionId: `0000000${i % 10}-aaaa-bbbb-cccc-000000000000`, status: "done", cursor: 40, runs: 1,
  result: "Rapport. ".repeat(180), questions: [], denials: [], error: null, costUsd: 0.12, turns: 7,
  startedAt: day(i), runStartedAt: null, endedAt: day(i + 0.5), durationMs: 60000,
  events: Array.from({ length: 40 }, (_, k) => `🔧 Read: src/fichier${k}.js`), ...extra,
});
const files = (dir) => ({ file: join(dir, "tasks.json"), archiveFile: join(dir, "tasks-archive.json"), backupFile: join(dir, "tasks.before-0.3.1.json") });
const ids = (list) => list.map((t) => t.id);

test("archive: 60 tasks → tasks.json keeps the 50 most recent, the 10 oldest are moved unchanged; backup first", () => {
  const dir = tmp(); const f = files(dir);
  const all = Array.from({ length: 60 }, (_, i) => fakeTask(i));
  writeFileSync(f.file, JSON.stringify({ version: "0.3.0", tasks: all }, null, 1));
  const original = readFileSync(f.file, "utf8");
  assert.ok(original.length > 140_000, `realistic size (${original.length} bytes)`);

  const r = saveTaskFiles({ ...f, list: all, max: 50, version: "0.3.1" });
  assert.deepEqual(r, { kept: 50, archived: 10 });
  assert.equal(readFileSync(f.backupFile, "utf8"), original, "backup = tasks.json as it was before the first write");
  const kept = readTaskFile(f.file).tasks, arch = readTaskFile(f.archiveFile).tasks;
  assert.deepEqual(ids(kept), ids(all.slice(10)));
  assert.deepEqual(arch, all.slice(0, 10), "archived exactly as they were");
  assert.equal(kept.length + arch.length, 60, "nothing lost");
});

test("archive: saving again adds nothing twice and doesn't redo the backup", () => {
  const dir = tmp(); const f = files(dir);
  const all = Array.from({ length: 60 }, (_, i) => fakeTask(i));
  writeFileSync(f.file, JSON.stringify({ version: "0.3.0", tasks: all }));
  const original = readFileSync(f.file, "utf8");
  saveTaskFiles({ ...f, list: all, max: 50, version: "0.3.1" });
  const archBefore = readFileSync(f.archiveFile, "utf8");
  // A new process: no memory of what was archived; memory still holds the 60 tasks + 1 new.
  const r = saveTaskFiles({ ...f, list: [...all, fakeTask(60)], max: 50, version: "0.3.1" });
  assert.equal(r.archived, 1, "only the task that just left tasks.json");
  const arch = readTaskFile(f.archiveFile).tasks;
  assert.deepEqual(ids(arch), ids(all.slice(0, 11)));
  assert.equal(new Set(ids(arch)).size, arch.length, "no duplicates");
  assert.ok(readFileSync(f.archiveFile, "utf8").length > archBefore.length);
  assert.equal(readFileSync(f.backupFile, "utf8"), original, "backup kept from the very first write");
  assert.deepEqual(ids(readTaskFile(f.file).tasks), ids([...all, fakeTask(60)].slice(-50)));
});

test("archive: an existing archive is appended to, its content kept", () => {
  const dir = tmp(); const f = files(dir);
  const old = [fakeTask(900, { id: "ancien1" }), fakeTask(901, { id: "ancien2" })];
  writeFileSync(f.archiveFile, JSON.stringify({ version: "0.3.1", tasks: old }));
  const all = Array.from({ length: 53 }, (_, i) => fakeTask(i));
  writeFileSync(f.file, JSON.stringify({ version: "0.3.0", tasks: all }));
  saveTaskFiles({ ...f, list: all, max: 50, version: "0.3.1" });
  assert.deepEqual(ids(readTaskFile(f.archiveFile).tasks), ["ancien1", "ancien2", "t0000", "t0001", "t0002"]);
});

test("archive: tasks leaving tasks.json are archived as they were in the file", () => {
  const dir = tmp(); const f = files(dir);
  const all = Array.from({ length: 51 }, (_, i) => fakeTask(i));
  const onDisk = all.map((t) => ({ ...t, extraFieldFromOlderVersion: true }));
  writeFileSync(f.file, JSON.stringify({ version: "0.2.0", tasks: onDisk }));
  saveTaskFiles({ ...f, list: all, max: 50, version: "0.3.1" });
  assert.deepEqual(readTaskFile(f.archiveFile).tasks, [onDisk[0]]);
});

test("archive: no file yet, ≤ 50 tasks → no archive, no backup", () => {
  const dir = tmp(); const f = files(dir);
  const r = saveTaskFiles({ ...f, list: [fakeTask(1), fakeTask(2)], max: 50, version: "0.3.1" });
  assert.deepEqual(r, { kept: 2, archived: 0 });
  assert.ok(!existsSync(f.archiveFile)); assert.ok(!existsSync(f.backupFile));
});

test("archive: an unreadable archive is never overwritten and nothing is dropped", () => {
  const dir = tmp(); const f = files(dir);
  writeFileSync(f.archiveFile, "{ pas du json");
  const all = Array.from({ length: 55 }, (_, i) => fakeTask(i));
  writeFileSync(f.file, JSON.stringify({ version: "0.3.0", tasks: all }));
  const r = saveTaskFiles({ ...f, list: all, max: 50, version: "0.3.1" });
  assert.match(r.warning || "", /could not read/);
  assert.equal(readFileSync(f.archiveFile, "utf8"), "{ pas du json");
  assert.equal(readTaskFile(f.file).tasks.length, 55);
});

test("archive: on a copy of a real tasks.json (only if PONT_TASKS_COPY is set)", { skip: !process.env.PONT_TASKS_COPY }, () => {
  const dir = tmp(); const f = files(dir);
  copyFileSync(/** @type {string} */ (process.env.PONT_TASKS_COPY), f.file);
  const original = readFileSync(f.file, "utf8");
  const before = readTaskFile(f.file).tasks;
  const r = saveTaskFiles({ ...f, list: before, max: 50, version: "0.3.1" });
  const kept = readTaskFile(f.file).tasks, arch = existsSync(f.archiveFile) ? readTaskFile(f.archiveFile).tasks : [];
  assert.equal(readFileSync(f.backupFile, "utf8"), original);
  assert.equal(kept.length, Math.min(50, before.length));
  assert.deepEqual([...arch, ...kept].map((t) => t.id), before.map((t) => t.id), "every task is in one of the two files");
  console.log(`  real copy: ${before.length} tasks, ${statSync(f.file).size} bytes kept, ${r.archived} archived`);
});

// ---------- 4. automatic resume after a usage limit (simulated clock) ----------
import {
  isUsageLimitEnd, parseResetTime, planAfterLimit, createResumeScheduler, createKeepAwake, formatHM,
  WAITING, MAX_AUTO_RESUMES, DEFAULT_RESUME_MESSAGE,
} from "../server/autoresume.js";
import { EventEmitter } from "node:events";

const Z = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();
const BUC = { localTz: "Europe/Bucharest" };
// 02:05 in Bucharest (UTC+2 in November), the night of 20/11.
const NIGHT = Z("2026-11-20T00:05:00Z");

test("limit: at least 6 forms of the limit message are recognised, with their reset time and zone", () => {
  const cases = [
    ["You've hit your 5-hour limit · resets 3:10am (Europe/Bucharest)", "2026-11-20T01:10:00.000Z", "Europe/Bucharest"],
    ["You’ve hit your weekly limit · resets Nov 24, 9am (Europe/Paris)", "2026-11-24T08:00:00.000Z", "Europe/Paris"],
    ["Claude usage limit reached. Your limit will reset at 5pm (America/New_York).", "2026-11-20T22:00:00.000Z", "America/New_York"],
    ["You have hit your usage limit. Resets at 14:30 (UTC).", "2026-11-20T14:30:00.000Z", "UTC"],
    ["5-hour limit reached ∙ resets 4am", "2026-11-20T02:00:00.000Z", "Europe/Bucharest"],           // no zone → the Mac's
    ["You've hit your Opus limit · resets 11:45pm (Pas/UneZone)", "2026-11-20T21:45:00.000Z", "Europe/Bucharest"], // unknown zone → the Mac's
    ["Claude AI usage limit reached|1763604000", "2025-11-20T02:00:00.000Z", "UTC"],                 // older format: epoch
    ["Usage limit reached, try again in 2h 15m", iso(NIGHT + 135 * 60_000), "Europe/Bucharest"],
  ];
  for (const [text, at, tz] of cases) {
    assert.ok(isUsageLimitEnd({ text, isError: true }), `recognised: ${text}`);
    assert.ok(isUsageLimitEnd({ text, isError: false }), `recognised even if not flagged as an error: ${text}`);
    const r = parseResetTime(text, NIGHT, BUC);
    assert.ok(r, `time read: ${text}`);
    assert.equal(iso(r.at), at, text);
    assert.equal(r.tz, tz, text);
  }
});

test("limit: the 'usage limit: rejected' progress line counts even without a readable message", () => {
  assert.ok(isUsageLimitEnd({ text: "", isError: true, rejected: true }));
  assert.ok(isUsageLimitEnd({ text: "API Error: something", isError: true, rejected: true }));
  assert.ok(isUsageLimitEnd({ text: "Error: usage limit for this organization", isError: true }), "weak sign on a failed run");
  // Not limits: an ordinary report, an ordinary failure, a warning that let the run finish.
  assert.ok(!isUsageLimitEnd({ text: "Fait. J'ai ajouté un test sur la usage limit de l'API. ".repeat(10), isError: false }));
  assert.ok(!isUsageLimitEnd({ text: "API Error: overloaded", isError: true }));
  assert.ok(!isUsageLimitEnd({ text: "Fait.", isError: false, rejected: true }), "rejected then finished normally");
});

test("limit: today, or tomorrow if the time has passed; across a DST change", () => {
  const msg = "You've hit your 5-hour limit · resets 3:10am (Europe/Bucharest)";
  assert.equal(iso(parseResetTime(msg, Z("2026-11-20T00:05:00Z"), BUC).at), "2026-11-20T01:10:00.000Z", "02:05 → today 03:10");
  assert.equal(iso(parseResetTime(msg, Z("2026-11-20T02:00:00Z"), BUC).at), "2026-11-21T01:10:00.000Z", "04:00 → tomorrow 03:10");
  assert.equal(iso(parseResetTime(msg, Z("2026-11-20T01:12:00Z"), BUC).at), "2026-11-20T01:10:00.000Z", "read 2 min late → still today");
  assert.equal(iso(parseResetTime("resets 3:10am (Europe/Paris)", Z("2026-03-29T00:30:00Z"), BUC).at), "2026-03-29T01:10:00.000Z", "summer time starts that night");
  assert.equal(iso(parseResetTime("resets 12am (UTC)", Z("2026-11-20T10:00:00Z"), BUC).at), "2026-11-21T00:00:00.000Z", "12am = midnight");
  assert.equal(iso(parseResetTime("resets 12pm (UTC)", Z("2026-11-20T10:00:00Z"), BUC).at), "2026-11-20T12:00:00.000Z", "12pm = noon");
  assert.equal(parseResetTime("Claude usage limit reached.", NIGHT, BUC), null);
  assert.equal(formatHM(Z("2026-11-20T01:12:00Z"), "Europe/Bucharest"), "03:12");
});

test("limit: plan — reset time from the message, else resetsAt, else a new try in 30 min", () => {
  const p1 = planAfterLimit({ text: "You've hit your 5-hour limit · resets 3:10am (Europe/Bucharest)", now: NIGHT, ...BUC });
  assert.equal(p1.wait, true); assert.equal(p1.wait && iso(p1.resumeAt), "2026-11-20T01:10:00.000Z");
  const p2 = planAfterLimit({ text: "Claude usage limit reached.", resetsAt: NIGHT / 1000 + 3600, now: NIGHT, ...BUC });
  assert.equal(p2.wait && p2.how, "resetsAt"); assert.equal(p2.wait && p2.resumeAt, NIGHT + 3600_000);
  const p3 = planAfterLimit({ text: "Claude usage limit reached.", now: NIGHT, ...BUC });
  assert.equal(p3.wait && p3.how, "retry"); assert.equal(p3.wait && p3.resumeAt, NIGHT + 30 * 60_000);
  assert.equal(planAfterLimit({ text: "x", now: NIGHT, enabled: false }).wait, false, "setting off");
  assert.equal(DEFAULT_RESUME_MESSAGE.endsWith("FIN DU MESSAGE"), true);
});

/** Simulated clock: `wall` is what Date.now() would say, `mono` drives the timers (frozen during a sleep). */
function fakeClock(start) {
  let wall = start, mono = 0, seq = 0;
  const timers = new Map();
  const c = {
    now: () => wall,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: mono + Math.max(0, ms), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    /** Let `ms` pass while awake: timers fire in order. */
    async advance(ms) {
      const end = mono + ms;
      for (let i = 0; i < 5; i++) await Promise.resolve(); // launches already queued run first
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        wall += next[1].at - mono; mono = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve(); // let the launch run
      }
      wall += end - mono; mono = end;
    },
    /** The Mac sleeps `ms`: the wall clock jumps, timers don't move. */
    sleep(ms) { wall += ms; },
    pending: () => timers.size,
  };
  return c;
}

/**
 * Tasks + a launch() that records the resume like the server does (same mode, history line).
 * @param {number} start @param {any[]} list @param {{ onLaunch?: (t: any, clock: any) => void }} [opts]
 */
function harness(start, list, { onLaunch } = {}) {
  const clock = fakeClock(start);
  const tasks = new Map(list.map((t) => [t.id, { autoResumes: 0, autoResumeHistory: [], permissionMode: "acceptEdits", ...t }]));
  const launches = [];
  const launch = (t) => {
    t.autoResumes += 1;
    t.autoResumeHistory.push(`reprise automatique n°${t.autoResumes} à ${formatHM(clock.now(), "Europe/Bucharest")}`);
    launches.push({ id: t.id, at: clock.now(), mode: t.permissionMode });
    t.status = "running"; t.resumeAt = null;
    onLaunch?.(t, clock);
  };
  const s = createResumeScheduler({ clock, getTasks: () => tasks.values(), launch });
  return { clock, tasks, launches, s };
}
const waitingTask = (id, resumeAt, extra = {}) => ({ id, status: WAITING, resumeAt: iso(resumeAt), sessionId: `sess-${id}`, ...extra });

test("resume: at resume_at + 2 min exactly, not before", async () => {
  const reset = Z("2026-11-20T01:10:00Z");
  const h = harness(NIGHT, [waitingTask("a", reset)]);
  h.s.start();
  await h.clock.advance(reset + 2 * 60_000 - NIGHT - 1000);
  assert.equal(h.launches.length, 0, "1 s before: still waiting");
  await h.clock.advance(1000);
  assert.equal(h.launches.length, 1);
  assert.equal(iso(h.launches[0].at), "2026-11-20T01:12:00.000Z");
  assert.deepEqual(h.tasks.get("a").autoResumeHistory, ["reprise automatique n°1 à 03:12"]);
  h.s.stop();
});

test("resume: the Mac sleeps 8 h through the reset time → resumed within 60 s of waking", async () => {
  const reset = Z("2026-11-20T01:10:00Z");
  const h = harness(NIGHT, [waitingTask("a", reset)]);
  h.s.start();
  await h.clock.advance(30_000);
  h.clock.sleep(8 * 3600_000); // lid closed 02:05 → 10:05, timers frozen
  const woke = h.clock.now();
  assert.equal(h.launches.length, 0);
  await h.clock.advance(60_000);
  assert.equal(h.launches.length, 1, "the 60 s check catches it");
  assert.ok(h.launches[0].at - woke <= 60_000, `resumed ${(h.launches[0].at - woke) / 1000} s after waking`);
  h.s.stop();
});

test("resume: several waiting tasks resume 20 s apart, earliest first", async () => {
  const reset = Z("2026-11-20T01:10:00Z");
  const h = harness(reset + 5 * 60_000, [waitingTask("b", reset + 1000), waitingTask("a", reset), waitingTask("c", reset + 2000)]);
  h.s.start();
  await h.clock.advance(90_000);
  assert.deepEqual(h.launches.map((l) => l.id), ["a", "b", "c"]);
  const at = h.launches.map((l) => l.at - h.launches[0].at);
  assert.deepEqual(at, [0, 20_000, 40_000]);
  h.s.stop();
});

test("resume: after a restart, from a copy of tasks.json: due tasks resume at once, others stay armed", async () => {
  const dir = tmp(); const f = join(dir, "tasks.json");
  if (process.env.PONT_TASKS_COPY) copyFileSync(process.env.PONT_TASKS_COPY, f);
  else writeFileSync(f, JSON.stringify({ version: "0.3.1", tasks: Array.from({ length: 45 }, (_, i) => fakeTask(i)) }));
  const base = readTaskFile(f).tasks;
  const now = Z("2026-11-20T09:45:00Z");
  const saved = [...base,
    { ...fakeTask(100), id: "due1", status: WAITING, resumeAt: iso(Z("2026-11-20T01:10:00Z")), autoResumes: 0, permissionMode: "plan" },
    { ...fakeTask(101), id: "due2", status: WAITING, resumeAt: iso(Z("2026-11-20T01:10:00Z")), autoResumes: 2, permissionMode: "auto" },
    { ...fakeTask(102), id: "later", status: WAITING, resumeAt: iso(now + 3600_000), autoResumes: 0 }];
  saveTaskFiles({ file: f, archiveFile: join(dir, "a.json"), backupFile: join(dir, "b.json"), list: saved, max: 50, version: "0.4.0" });
  // "restart": read the file back, as loadTasks() does
  const loaded = readTaskFile(f).tasks;
  assert.ok(loaded.some((t) => t.id === "later"), "waiting tasks are in tasks.json");
  const h = harness(now, loaded.filter((t) => t.status === WAITING || base.some((b) => b.id === t.id)));
  h.s.start();
  await h.clock.advance(1);
  assert.deepEqual(h.launches.map((l) => l.id), ["due1"], "first due task right away");
  await h.clock.advance(20_000);
  assert.deepEqual(h.launches.map((l) => l.id), ["due1", "due2"], "second one 20 s later");
  assert.equal(h.tasks.get("due2").autoResumes, 3, "count kept across the restart");
  await h.clock.advance(3600_000 + 2 * 60_000);
  assert.deepEqual(h.launches.map((l) => l.id), ["due1", "due2", "later"]);
  assert.equal(h.launches.filter((l) => !["due1", "due2", "later"].includes(l.id)).length, 0, "the other tasks of the copy are untouched");
  h.s.stop();
});

test("resume: at most 6 automatic resumes per task; the permission mode never changes", async () => {
  // Each resume hits the limit again at once (the limit isn't really lifted).
  const start = Z("2026-11-20T01:10:00Z");
  const h = harness(start, [waitingTask("a", start, { permissionMode: "plan" })], {
    onLaunch: (t, clock) => {
      const p = planAfterLimit({ text: "Claude usage limit reached.", now: clock.now(), autoResumes: t.autoResumes, ...BUC });
      if (p.wait === true) { t.status = WAITING; t.resumeAt = iso(p.resumeAt); } else { t.status = "error"; t.error = p.reason; }
    },
  });
  h.s.start();
  await h.clock.advance(24 * 3600_000);
  const t = h.tasks.get("a");
  assert.equal(h.launches.length, MAX_AUTO_RESUMES);
  assert.equal(t.status, "error"); assert.match(t.error, /6 automatic resumes already done/);
  assert.deepEqual(new Set(h.launches.map((l) => l.mode)), new Set(["plan"]), "same mode for every resume");
  assert.deepEqual(t.autoResumeHistory.map((l) => l.replace(/ à .*/, "")), [1, 2, 3, 4, 5, 6].map((k) => `reprise automatique n°${k}`));
  // 30 min between tries (+2 min after each announced time)
  const gaps = h.launches.slice(1).map((l, i) => (l.at - h.launches[i].at) / 60_000);
  assert.deepEqual(gaps, [32, 32, 32, 32, 32]);
  h.s.stop();
});

test("resume: a task stopped or replied to meanwhile isn't resumed; the clock going back doesn't block", async () => {
  const reset = Z("2026-11-20T01:10:00Z");
  const h = harness(reset, [waitingTask("a", reset), waitingTask("b", reset + 60_000)]);
  h.s.start();
  h.tasks.get("a").status = "stopped";
  await h.clock.advance(5 * 60_000);
  assert.deepEqual(h.launches.map((l) => l.id), ["b"]);
  h.s.stop();
  assert.equal(h.clock.pending(), 0, "no timer left after stop()");
});

test("keep awake: caffeinate -i started when work begins, stopped when nothing runs (simulated)", () => {
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    /** @type {any} */
    const p = new EventEmitter();
    Object.assign(p, { pid: 4242 + spawned.length, killed: "", kill(/** @type {string} */ sig) { p.killed = sig; p.emit("exit", 0); } });
    spawned.push({ cmd, args, opts, p });
    return p;
  };
  const logs = [];
  const ka = createKeepAwake({ enabled: true, platform: "darwin", spawn: fakeSpawn, pid: 999, log: (m) => logs.push(m) });
  ka.update(false);
  assert.equal(spawned.length, 0, "nothing to do: not started");
  ka.update(true); ka.update(true);
  assert.equal(spawned.length, 1, "one caffeinate only");
  assert.deepEqual([spawned[0].cmd, spawned[0].args], ["caffeinate", ["-i", "-w", "999"]], "tied to the extension's pid");
  assert.equal(ka.active, true);
  ka.update(false);
  assert.equal(spawned[0].p.killed, "SIGTERM"); assert.equal(ka.active, false);
  ka.update(true);
  assert.equal(spawned.length, 2, "started again for the next run");
  spawned[1].p.emit("exit", 1); // caffeinate died on its own
  ka.update(true);
  assert.equal(spawned.length, 3, "restarted at the next check");
  ka.stop();
  assert.equal(ka.active, false);
  assert.ok(logs.some((l) => /started/.test(l)) && logs.some((l) => /stopped/.test(l)));
  // setting off, or not a Mac: never started
  const off = createKeepAwake({ enabled: false, platform: "darwin", spawn: fakeSpawn });
  off.update(true);
  const linux = createKeepAwake({ enabled: true, platform: "linux", spawn: fakeSpawn });
  linux.update(true);
  assert.equal(spawned.length, 3);
  // caffeinate missing: a warning, no crash, no retry loop
  const broken = createKeepAwake({ enabled: true, platform: "darwin", spawn: () => { throw new Error("ENOENT"); } });
  broken.update(true); broken.update(true);
  assert.equal(broken.active, false); assert.match(broken.status.error || "", /ENOENT/);
});
