// Shared in-memory state between the plugin lifecycle, the status tool, and
// the Pi SDK extension. Persistent config lives in ctx.config (backed by
// plugin-data/{id}/config.json, which Hana updates never touch); this module
// is the runtime mirror the extension reads at event time.
//
// Also owns the file log (JSONL under ctx.dataDir) and the enforcement
// bookkeeping (recently-applied keys, manual-choice holds) shared by the
// lifecycle sweep and the extension.

import path from "node:path";
import fs from "node:fs";

// Pi SDK thinking levels (@earendil-works/pi-ai EXTENDED_THINKING_LEVELS is
// ["off","minimal","low","medium","high","xhigh"]). The top level "xhigh" is
// what Hana's UI labels "最高/Max"; Session.setThinkingLevel clamps to the
// current model's best supported level automatically.
const TARGET_LEVELS = ["xhigh", "high"];

// Rank used to compare a reported level against the target.
const LEVEL_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 };

let current = {
  enabled: true,
  targetLevel: "xhigh",
  enforceEveryTurn: true,
  syncSessionMeta: true,
  respectManualChoice: false,
  excludeModels: [],
};

const recent = [];
const RECENT_LIMIT = 50;
let degraded = null;

// ── File log (JSONL under ctx.dataDir) ──
const LOG_MAX_BYTES = 256 * 1024;
let logFile = null;
let logWrites = 0;

export function initLogging(dataDir) {
  try {
    if (!dataDir) return;
    fs.mkdirSync(dataDir, { recursive: true });
    logFile = path.join(dataDir, "enforce.log");
  } catch {
    logFile = null;
  }
}

export function getLogFile() {
  return logFile;
}

function trimLogIfNeeded() {
  if (!logFile) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size <= LOG_MAX_BYTES) return;
    const raw = fs.readFileSync(logFile, "utf-8");
    const lines = raw.split("\n");
    fs.writeFileSync(logFile, lines.slice(Math.floor(lines.length / 2)).join("\n"), "utf-8");
  } catch {
    // Best effort only.
  }
}

export function appendLog(source, message, fields = {}) {
  recent.unshift({ ts: new Date().toISOString(), source, message, ...fields });
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  if (!logFile) return;
  try {
    const entry = { ts: new Date().toISOString(), source, message, ...fields };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf-8");
    logWrites += 1;
    if (logWrites % 50 === 0) trimLogIfNeeded();
  } catch {
    // Never let logging break enforcement.
  }
}

// ── Enforcement bookkeeping ──

// key (sessionId or sessionPath) -> Date.now() of the last write WE made.
const appliedAt = new Map();
// sessionPath -> expiry Date.now() while the user's manual choice is respected.
const manualUntil = new Map();
const APPLIED_TTL_MS = 30 * 60_000;
const APPLIED_MAP_MAX = 400;

function sweepMapTtl(map) {
  if (map.size <= APPLIED_MAP_MAX) return;
  const cutoff = Date.now() - APPLIED_TTL_MS;
  for (const [k, v] of map) {
    if (v < cutoff) map.delete(k);
  }
}

export function markApplied(keys, when = Date.now()) {
  for (const key of keys) {
    if (!key) continue;
    appliedAt.set(String(key), when);
  }
  sweepMapTtl(appliedAt);
}

export function recentlyApplied(key, windowMs = 15_000) {
  if (!key) return false;
  const at = appliedAt.get(String(key));
  return typeof at === "number" && Date.now() - at < windowMs;
}

export function isManualHold(key) {
  if (!key) return false;
  const until = manualUntil.get(String(key));
  if (!until) return false;
  if (Date.now() > until) {
    manualUntil.delete(String(key));
    return false;
  }
  return true;
}

export function markManualHold(key, ms = 30 * 60_000) {
  if (!key) return;
  manualUntil.set(String(key), Date.now() + ms);
}

function rankOf(level) {
  const key = String(level || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, key) ? LEVEL_RANK[key] : -1;
}

export function levelBelowTarget(level) {
  return rankOf(level) >= 0 && rankOf(level) < rankOf(getState().targetLevel);
}

// ── Config mirror ──

function normalizeExcludeModels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function getState() {
  return current;
}

export function setState(next) {
  const prev = current;
  current = {
    enabled: typeof next?.enabled === "boolean" ? next.enabled : prev.enabled,
    targetLevel: TARGET_LEVELS.includes(next?.targetLevel) ? next.targetLevel : "xhigh",
    enforceEveryTurn: typeof next?.enforceEveryTurn === "boolean" ? next.enforceEveryTurn : prev.enforceEveryTurn,
    syncSessionMeta: typeof next?.syncSessionMeta === "boolean" ? next.syncSessionMeta : prev.syncSessionMeta,
    respectManualChoice: typeof next?.respectManualChoice === "boolean" ? next.respectManualChoice : prev.respectManualChoice,
    excludeModels: Array.isArray(next?.excludeModels) ? normalizeExcludeModels(next.excludeModels) : prev.excludeModels,
  };
  return current;
}

export function recordEnforcement(sessionKey, record) {
  appendLog("extension", "enforced", { session: String(sessionKey || "unknown"), ...record });
}

export function markDegraded(message) {
  degraded = { at: new Date().toISOString(), message: String(message || "unknown") };
  appendLog("extension", `degraded: ${message}`);
}

// A successful enforcement proves the runtime API is alive again (e.g. after
// a stale-ctx window during session reload), so the degraded flag clears.
export function clearDegraded() {
  if (degraded) {
    appendLog("extension", "degraded cleared after successful enforcement");
  }
  degraded = null;
}

export function getDiagnostics() {
  return {
    degraded,
    recent: recent.slice(0, RECENT_LIMIT),
  };
}
