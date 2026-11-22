// Automatic resume after a usage limit, and keeping the Mac awake while work goes on.
// Pure helpers with an injectable clock and spawn, so that test/unit.mjs can simulate hours of
// waiting, a sleeping Mac or caffeinate without waiting or launching anything for real.

export const WAITING = "waiting_limit";
export const DEFAULT_RESUME_MESSAGE = "Ta limite d'usage est levée. Reprends exactement là où tu t'es arrêté, sans refaire ce qui est déjà fait. Les consignes, le feu vert et le compte rendu demandés au départ restent valables. FIN DU MESSAGE";
export const MAX_AUTO_RESUMES = 6;
export const RESUME_DELAY_MS = 2 * 60_000;      // resume 2 min after the announced reset time
export const RESUME_SPACING_MS = 20_000;        // between two automatic resumes
export const RESUME_CHECK_MS = 60_000;          // due resumes are checked at least this often
export const LIMIT_RETRY_MS = 30 * 60_000;      // reset time unreadable: try again in 30 min
export const PAST_GRACE_MS = 15 * 60_000;       // "resets 3:10am" read at 3:12 → still today, not tomorrow

// ---------- 1. Is this the end of a run by a usage limit? ----------

// Strong signs: enough on their own, even in a result that isn't flagged as an error.
const STRONG = [
  /\bhit your\b[^\n]{0,60}?\blimit\b/i,                       // You've hit your 5-hour limit
  /\busage limit (?:reached|hit|exceeded)\b/i,                // Claude AI usage limit reached|…
  /\blimit reached\b[^\n]{0,40}?\bresets?\b/i,                // 5-hour limit reached ∙ resets 2am
];
// Weaker signs: only when the run failed (an ordinary report may talk about "usage limits").
const WEAK = [/\busage limits?\b/i, /\blimit\b[^\n]{0,80}?\b(?:resets?|will reset)\b/i];
const SHORT_RESULT = 400; // a real limit message is one line; a long report is not one

/**
 * @param {{ text?: string | null, isError?: boolean, rejected?: boolean }} p
 *   text: result / error / stderr of the run; isError: the run failed (or gave no result);
 *   rejected: a "usage limit: rejected" progress line (rate_limit_event status "rejected") was seen.
 * @returns {boolean}
 */
export function isUsageLimitEnd({ text, isError = false, rejected = false }) {
  const s = String(text ?? "");
  if (rejected && (isError || !s.trim())) return true;
  if (s.length <= SHORT_RESULT && STRONG.some((r) => r.test(s))) return true;
  if (isError && (STRONG.some((r) => r.test(s)) || WEAK.some((r) => r.test(s)))) return true;
  return false;
}

// ---------- 2. When does the limit reset? ----------

/** The Mac's own time zone. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** @param {string} tz */
function validZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Wall-clock parts of instant `ts` in zone `tz`. @param {number} ts @param {string} tz */
function zoned(ts, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  /** @type {Record<string, number>} */
  const p = {};
  for (const x of f.formatToParts(ts)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** Offset of zone `tz` at instant `ts` (zone time − UTC), in ms. @param {number} ts @param {string} tz */
function offsetAt(ts, tz) {
  const z = zoned(ts, tz);
  return Date.UTC(z.y, z.mo, z.d, z.h, z.mi, z.s) - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant at which the clocks of zone `tz` show y-mo-d h:mi (day overflow allowed: d + 1).
 * @param {number} y @param {number} mo @param {number} d @param {number} h @param {number} mi @param {string} tz
 */
export function zonedTimeToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz); // second pass: right across a DST change
}

/** "HH:MM" of instant `ts` in zone `tz` (default: the Mac's). @param {number} ts @param {string} [tz] */
export function formatHM(ts, tz) {
  const z = zoned(ts, tz && validZone(tz) ? tz : localTimeZone());
  return `${String(z.h).padStart(2, "0")}:${String(z.mi).padStart(2, "0")}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESET_AT = new RegExp(
  String.raw`\b(?:resets?|will reset|reset)\s+(?:at\s+|on\s+)?` +
  String.raw`(?:(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?` +
  String.raw`(?<h>\d{1,2})(?:[:h.](?<mi>\d{2}))?\s*(?<ap>[ap]\.?m\.?)?(?![\d:])` +
  String.raw`(?:\s*\((?<tz>[^)]{1,40})\))?`, "i");
const RESET_IN = /\b(?:resets?|reset|try again)\s+in\s+(?:(?<h>\d+)\s*(?:h|hours?|hrs?))?\s*(?:(?<mi>\d+)\s*(?:m|min|mins|minutes?))?/i;
const EPOCH = /limit reached\|(?<epoch>\d{10,13})\b/i; // older Claude Code: "Claude AI usage limit reached|1763600000"

/**
 * Read the reset time from a limit message, with its time zone (default: the Mac's).
 * Today in that zone, or tomorrow if that time has already passed (by more than `graceMs`).
 * @param {string | null | undefined} text
 * @param {number} now ms since epoch
 * @param {{ localTz?: string, graceMs?: number }} [opts]
 * @returns {{ at: number, tz: string, how: string } | null}
 */
export function parseResetTime(text, now, { localTz = localTimeZone(), graceMs = PAST_GRACE_MS } = {}) {
  const s = String(text ?? "");
  let m = s.match(EPOCH);
  if (m?.groups) {
    const n = Number(m.groups.epoch);
    return { at: n < 1e12 ? n * 1000 : n, tz: "UTC", how: "epoch" };
  }
  m = s.match(RESET_IN);
  if (m?.groups && (m.groups.h || m.groups.mi)) {
    return { at: now + (Number(m.groups.h || 0) * 60 + Number(m.groups.mi || 0)) * 60_000, tz: localTz, how: "in" };
  }
  m = s.match(RESET_AT);
  if (!m?.groups) return null;
  const g = m.groups;
  let h = Number(g.h);
  const mi = Number(g.mi || 0);
  const ap = (g.ap || "").replace(/\./g, "").toLowerCase();
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === "pm" ? 12 : 0); }
  else if (!g.mi) return null; // a bare number ("resets 5") is too vague to be a time
  if (h > 23 || mi > 59) return null;
  let tz = (g.tz || "").trim();
  if (!tz || !validZone(tz)) tz = validZone(localTz) ? localTz : "UTC";
  const today = zoned(now, tz);
  if (g.mon) {
    const mo = MONTHS.indexOf(g.mon.toLowerCase().slice(0, 3));
    const d = Number(g.day);
    let at = zonedTimeToUtc(today.y, mo, d, h, mi, tz);
    if (at < now - 60 * 86400_000) at = zonedTimeToUtc(today.y + 1, mo, d, h, mi, tz); // "Jan 2" read in December
    return { at, tz, how: "date" };
  }
  let at = zonedTimeToUtc(today.y, today.mo, today.d, h, mi, tz);
  if (at < now - graceMs) at = zonedTimeToUtc(today.y, today.mo, today.d + 1, h, mi, tz);
  return { at, tz, how: "time" };
}

/**
 * What to do when a run ended on a usage limit.
 * @param {{ text?: string | null, resetsAt?: number | null, now: number, autoResumes?: number, enabled?: boolean,
 *   max?: number, retryMs?: number, localTz?: string }} p
 *   resetsAt: `rate_limit_info.resetsAt` of the "rejected" line, in seconds, if Claude Code gave one.
 * @returns {{ wait: true, resumeAt: number, how: string, tz: string } | { wait: false, reason: string }}
 */
export function planAfterLimit({ text, resetsAt, now, autoResumes = 0, enabled = true, max = MAX_AUTO_RESUMES, retryMs = LIMIT_RETRY_MS, localTz = localTimeZone() }) {
  if (!enabled) return { wait: false, reason: "automatic resume is off in the extension settings" };
  if (autoResumes >= max) return { wait: false, reason: `${max} automatic resumes already done for this task: no more automatic resume (cc_reply resumes it by hand)` };
  const r = parseResetTime(text, now, { localTz });
  if (r) return { wait: true, resumeAt: r.at, how: r.how, tz: r.tz };
  const n = Number(resetsAt);
  if (Number.isFinite(n) && n > 0) {
    const at = n < 1e12 ? n * 1000 : n;
    if (at > now - PAST_GRACE_MS) return { wait: true, resumeAt: at, how: "resetsAt", tz: "UTC" };
  }
  return { wait: true, resumeAt: now + retryMs, how: "retry", tz: localTz };
}

// ---------- 3. Resume scheduler ----------

/**
 * @typedef {{ now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(h: any): void }} Clock
 *   now() is wall-clock time (jumps forward after a sleep); timers may drift (they stop while the Mac sleeps).
 */

/** @type {Clock} */
export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
  clearTimeout: (h) => clearTimeout(h),
};

/**
 * Resumes waiting tasks when they are due (resumeAt + delayMs), one every spacingMs at most.
 * It never trusts a single long timer: it looks again at least every checkMs, comparing the
 * wall clock with each due time, so a resume due during a sleep happens within checkMs of waking.
 * `launch(t)` must take the task out of WAITING (or leave it there to be retried at the next check).
 * @param {{ clock?: Clock, getTasks: () => Iterable<any>, launch: (t: any) => unknown,
 *   delayMs?: number, spacingMs?: number, checkMs?: number, onTick?: () => void }} p
 */
export function createResumeScheduler({ clock = realClock, getTasks, launch, delayMs = RESUME_DELAY_MS, spacingMs = RESUME_SPACING_MS, checkMs = RESUME_CHECK_MS, onTick }) {
  let timer = null, running = false, lastLaunch = -Infinity;
  const launching = new Set();
  const dueAt = (/** @type {any} */ t) => Date.parse(t.resumeAt) + delayMs;
  const waiting = () => [...getTasks()].filter((t) => t.status === WAITING && t.resumeAt && !launching.has(t.id) && Number.isFinite(dueAt(t)));

  function tick() {
    if (!running) return;
    timer = null;
    const now = clock.now();
    if (now < lastLaunch) lastLaunch = -Infinity; // the clock went back: don't block resumes
    const due = waiting().filter((t) => dueAt(t) <= now).sort((a, b) => dueAt(a) - dueAt(b));
    if (due.length && now - lastLaunch >= spacingMs) {
      const t = due[0];
      lastLaunch = now;
      launching.add(t.id);
      Promise.resolve().then(() => launch(t)).catch(() => {}).finally(() => { launching.delete(t.id); });
    }
    try { onTick?.(); } catch {}
    arm();
  }

  function arm() {
    if (!running) return;
    if (timer) clock.clearTimeout(timer);
    const now = clock.now();
    let wait = checkMs;
    const next = Math.min(...waiting().map(dueAt));
    if (Number.isFinite(next)) {
      const spacingLeft = Math.max(0, lastLaunch + spacingMs - now);
      wait = Math.min(checkMs, Math.max(next - now, spacingLeft, 0));
    }
    timer = clock.setTimeout(tick, wait);
  }

  return {
    start() { if (running) return; running = true; tick(); },
    stop() { running = false; if (timer) clock.clearTimeout(timer); timer = null; },
    /** A task started or stopped waiting: re-plan the next check. */
    poke() { if (running) arm(); },
    tick,
    dueAt,
    /** Earliest due time among waiting tasks, or null. */
    nextDue() { const n = Math.min(...waiting().map(dueAt)); return Number.isFinite(n) ? n : null; },
  };
}

// ---------- 4. Keep the Mac awake (caffeinate -i) ----------

/**
 * One `caffeinate -i -w <our pid>` while there is work (a run going on or a task waiting for its
 * limit), none otherwise. `-w` ties it to the extension: it ends by itself if the extension dies.
 * @param {{ enabled?: boolean, platform?: string, spawn: (cmd: string, args: string[], opts: object) => any,
 *   bin?: string, pid?: number, log?: (msg: string) => void }} p
 */
export function createKeepAwake({ enabled = true, platform = process.platform, spawn, bin = "caffeinate", pid = process.pid, log = () => {} }) {
  /** @type {any} */
  let proc = null;
  let broken = "";
  const usable = () => enabled && platform === "darwin" && !broken;
  const ka = {
    get active() { return !!proc; },
    get status() { return { enabled, active: !!proc, ...(platform !== "darwin" ? { note: "macOS only" } : {}), ...(broken ? { error: broken } : {}) }; },
    /** @param {boolean} want there is work going on */
    update(want) {
      if (want && usable() && !proc) {
        let p;
        try { p = spawn(bin, ["-i", "-w", String(pid)], { stdio: "ignore", windowsHide: true }); }
        catch (e) { broken = /** @type {Error} */ (e).message; log(`keep awake: could not start ${bin}: ${broken}`); return; }
        proc = p;
        p.on?.("error", (/** @type {Error} */ e) => { broken = e.message; if (proc === p) proc = null; log(`keep awake: ${bin} failed: ${e.message}`); });
        p.on?.("exit", () => { if (proc === p) proc = null; });
        log(`keep awake: ${bin} -i started (pid ${p.pid})`);
      } else if (!want && proc) {
        const p = proc;
        proc = null;
        try { p.kill("SIGTERM"); } catch {}
        log("keep awake: caffeinate stopped (nothing running or waiting)");
      }
    },
    stop() { ka.update(false); },
  };
  return ka;
}
