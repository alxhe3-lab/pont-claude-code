// Pure helpers of Pont Claude Code, kept apart from server/index.js (which starts the MCP
// server as soon as it is imported) so that they can be unit-tested (test/unit.mjs).

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, constants } from "node:fs";

// ---------- 1. "Permission mode" setting ----------

/**
 * Turn the "Permission mode" setting into a mode this Claude Code accepts.
 * - exact mode name (or alias such as "default") → that mode;
 * - otherwise, if the value contains exactly one mode name as a word, case ignored
 *   (e.g. "Allow bypassPermissions") → that mode, with a warning for the log;
 * - several mode names, or none → `fallback`, with a warning for the log;
 * - bypassPermissions is still refused unless `allowBypass`.
 * Aliases only count on an exact match: "acceptEdits (default)" is acceptEdits, not two modes.
 * @param {string | undefined | null} raw
 * @param {string[]} modes
 * @param {{ aliases?: Record<string, string>, allowBypass?: boolean, fallback?: string }} [opts]
 * @returns {{ mode: string, warnings: string[] }}
 */
export function resolveModeSetting(raw, modes, { aliases = {}, allowBypass = false, fallback = "acceptEdits" } = {}) {
  const value = String(raw ?? "").trim();
  /** @type {string[]} */
  const warnings = [];
  if (!value) return { mode: fallback, warnings };
  let mode = aliases[value] || value;
  if (!modes.includes(mode)) {
    const byLower = new Map(modes.map((m) => [m.toLowerCase(), m]));
    const found = [...new Set(value.split(/[^A-Za-z]+/).map((w) => byLower.get(w.toLowerCase())).filter(Boolean))];
    if (found.length !== 1) {
      warnings.push(found.length
        ? `Permission mode setting "${value}" contains several modes (${found.join(", ")}); using ${fallback}.`
        : `Default mode "${value}" isn't supported by this Claude Code; using ${fallback}.`);
      return { mode: fallback, warnings };
    }
    mode = /** @type {string} */ (found[0]);
    warnings.push(`Permission mode setting "${value}" isn't exactly a mode name; it contains "${mode}", so using ${mode}.`);
  }
  if (mode === "bypassPermissions" && !allowBypass) {
    warnings.push(`Default mode bypassPermissions needs "Allow bypassPermissions"; using ${fallback}.`);
    return { mode: fallback, warnings };
  }
  return { mode, warnings };
}

// ---------- 2. Safety return of until_done waits ----------

export const DEFAULT_SAFETY_S = 70; // remote sessions cut tool calls after about 80 s

/**
 * Parse the "until_done safety limit" setting (seconds; 0 = no safety limit).
 * @param {string | undefined | null} raw
 * @param {{ def?: number, max: number }} opts
 * @returns {{ seconds: number, warning?: string }}
 */
export function parseSafetySetting(raw, { def = DEFAULT_SAFETY_S, max }) {
  const value = String(raw ?? "").trim();
  if (!value) return { seconds: def };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { seconds: def, warning: `until_done safety limit "${value}" isn't a number of seconds; using ${def} s.` };
  return { seconds: Math.min(n, max) };
}

export const LIVE = new Set(["starting", "running"]);

/**
 * Wait until the task leaves LIVE, `seconds` elapse or the client aborts the request.
 * Resolves with "settled" (the run ended), "timeout" or "aborted". Waiting never touches the
 * task itself: an aborted wait just stops listening. `t.waiters` is called when the run ends.
 * @param {{ status: string, waiters: Set<() => void> }} t
 * @param {number} seconds
 * @param {AbortSignal} [signal]
 * @returns {Promise<"settled" | "timeout" | "aborted">}
 */
export function waitFor(t, seconds, signal) {
  if (!LIVE.has(t.status)) return Promise.resolve("settled");
  if (signal?.aborted) return Promise.resolve("aborted");
  if (seconds <= 0) return Promise.resolve("timeout");
  return new Promise((res) => {
    const check = () => { if (!LIVE.has(t.status)) done("settled"); };
    const onAbort = () => done("aborted");
    const timer = setTimeout(() => done("timeout"), seconds * 1000);
    /** @param {"settled" | "timeout" | "aborted"} why */
    function done(why) {
      clearTimeout(timer); t.waiters.delete(check); signal?.removeEventListener("abort", onAbort); res(why);
    }
    t.waiters.add(check);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * How long an until_done call may wait, and which limit applies.
 * The safety limit (if > 0) wins when it is shorter than max_minutes.
 * @param {{ maxMinutes: number, safetySeconds: number }} p
 * @returns {{ seconds: number, limit: "safety" | "max_minutes" }}
 */
export function untilDoneBudget({ maxMinutes, safetySeconds }) {
  const cap = maxMinutes * 60;
  if (safetySeconds > 0 && safetySeconds < cap) return { seconds: safetySeconds, limit: "safety" };
  return { seconds: cap, limit: "max_minutes" };
}

// ---------- 3. tasks.json: keep the most recent tasks, archive the others ----------

/**
 * Read a { tasks: [...] } file. A missing file is an empty list; an unreadable one is `ok: false`.
 * @param {string} path
 * @returns {{ ok: boolean, tasks: any[], error?: string }}
 */
export function readTaskFile(path) {
  if (!existsSync(path)) return { ok: true, tasks: [] };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return { ok: true, tasks: Array.isArray(j?.tasks) ? j.tasks : [] };
  } catch (e) {
    return { ok: false, tasks: [], error: /** @type {Error} */ (e).message };
  }
}

/** @param {string} path @param {unknown} obj */
export function writeJsonAtomic(path, obj) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  renameSync(tmp, path);
}

/**
 * Copy `file` to `backup` once: only if `file` exists and `backup` doesn't yet.
 * @param {string} file @param {string} backup
 * @returns {boolean} true if a copy was made
 */
export function backupOnce(file, backup) {
  if (!existsSync(file) || existsSync(backup)) return false;
  try { copyFileSync(file, backup, constants.COPYFILE_EXCL); return true; } catch { return false; }
}

/** Identifies one state of a task in the archive (same task, same run, same end). */
export const archiveKey = (/** @type {any} */ t) => `${t?.id}|${t?.runs}|${t?.endedAt}`;

/**
 * Write tasks.json with the `max` most recent tasks of `list` (ordered oldest → newest).
 * The others are not lost: they are appended, unchanged, to `archiveFile` (created if needed).
 * Tasks that leave tasks.json are archived as they were in tasks.json; tasks never written
 * there are archived as they are in `list`. A task state already archived (same id, runs and
 * endedAt) isn't added twice. Before the first write ever, tasks.json is copied to `backupFile`.
 * If the archive can't be read, nothing is dropped: tasks.json keeps every task this time.
 * @param {{ file: string, archiveFile: string, backupFile: string, list: any[], max: number,
 *   version: string, archivedKeys?: Set<string> }} p
 *   archivedKeys: task states known to be in the archive already (filled in; saves re-reading it).
 * @returns {{ kept: number, archived: number, warning?: string }}
 */
export function saveTaskFiles({ file, archiveFile, backupFile, list, max, version, archivedKeys = new Set() }) {
  backupOnce(file, backupFile);
  const keep = list.slice(-max);
  const keepIds = new Set(keep.map((t) => t.id));
  const current = readTaskFile(file).tasks;
  const inFile = new Set(current.map((t) => t?.id));
  const dropped = [
    ...current.filter((t) => !keepIds.has(t?.id)),
    ...list.slice(0, Math.max(0, list.length - max)).filter((t) => !inFile.has(t.id)),
  ].filter((t) => !archivedKeys.has(archiveKey(t)));

  let archived = 0;
  if (dropped.length) {
    const arch = readTaskFile(archiveFile);
    if (!arch.ok) {
      writeJsonAtomic(file, { version, tasks: [...dropped, ...keep] });
      return { kept: dropped.length + keep.length, archived: 0, warning: `could not read ${archiveFile} (${arch.error}); kept every task in tasks.json` };
    }
    const seen = new Set(arch.tasks.map(archiveKey));
    const toAdd = [];
    for (const t of dropped) {
      const k = archiveKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      toAdd.push(t);
    }
    // Archive first: if the process dies in between, a task is at worst in both files, never in none.
    if (toAdd.length) writeJsonAtomic(archiveFile, { version, tasks: [...arch.tasks, ...toAdd] });
    for (const k of seen) archivedKeys.add(k);
    archived = toAdd.length;
  }
  writeJsonAtomic(file, { version, tasks: keep });
  return { kept: keep.length, archived };
}
