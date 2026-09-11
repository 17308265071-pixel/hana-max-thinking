// hana-max-thinking lifecycle plugin (v0.2.0).
//
// Responsibilities:
// 1. Sync ctx.config (manifest configuration schema) into the shared state
//    mirror that the Pi SDK extension reads at event time.
// 2. Frontend adaptation: write the enforced level into session metadata
//    through the bus session:update capability, so the frontend thinking
//    selector reflects the forced level immediately and clicking a lower tier
//    gets corrected within seconds.
// 3. Creation-time enforcement: on session_created, apply to that session at
//    once. Channels are created outside the bus (agent-executor), so a
//    filesystem sweep discovers phone sessions (old and new) and applies to
//    them by legacy sessionPath.
// 4. File log (JSONL under ctx.dataDir) for every action, plus a slow
//    self-heal interval so config edits and missed events still apply after
//    future app updates.
//
// IMPORTANT: the plugin install response is JSON.stringify({...entry}) and the
// entry carries this instance. Timer objects (setTimeout/setInterval returns)
// hold circular _idlePrev/_idleNext links, so they must NEVER be stored on
// instance properties. All timers live in the onload closure instead.

import path from "node:path";
import fs from "node:fs";

// Versioned dynamic import (cache-busting): Hana keeps ESM module instances
// cached for the lifetime of the process, so after an in-place plugin update a
// static `import "./state.js"` resolves to the OLD module and an entry that
// uses new exports fails to load ("does not provide an export named ...",
// observed on 449 with beginApply). The ?v= query gives every release its own
// module graph, so updates install cleanly without a host restart.
const MODULE_VERSION = "0.2.0";
const {
  appendLog,
  beginApply,
  endApply,
  getState,
  initLogging,
  isApplying,
  isManualHold,
  levelBelowTarget,
  markApplied,
  markManualHold,
  recentlyApplied,
  setState,
} = await import(new URL("./state.js?v=" + MODULE_VERSION, import.meta.url).href);

// The level sent over the bus. Hana normalizes it per model on the server
// (max -> xhigh -> high when the model lacks a higher tier).
const BUS_LEVEL = "max";
const APPLY_THROTTLE_MS = 5 * 60_000;
const PHONE_THROTTLE_MS = 30 * 60_000;
// Phone/channel rounds are stored as per-round `时间戳_xxx.jsonl` files (not a
// single phone.jsonl), so the backstop sweep only touches rounds that changed
// recently; older history is left alone.
const PHONE_FRESH_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const SWEEP_STARTUP_DELAY_MS = 4_000;

function fileExistsSafe(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function dirExistsSafe(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

async function readConfig(ctx) {
  const config = ctx?.config;
  const get = async (key, fallback) => {
    try {
      const value = await config?.get?.(key);
      return value === undefined ? fallback : value;
    } catch {
      // Config store API changed across an app update: fall back to the
      // default rather than breaking enforcement.
      return fallback;
    }
  };
  return {
    enabled: await get("enabled", true),
    targetLevel: await get("targetLevel", "xhigh"),
    enforceEveryTurn: await get("enforceEveryTurn", true),
    syncSessionMeta: await get("syncSessionMeta", true),
    respectManualChoice: await get("respectManualChoice", false),
    excludeModels: await get("excludeModels", []),
    injectGuide: await get("injectGuide", true),
  };
}

export default class HanaMaxThinkingPlugin {
  async onload() {
    const ctx = this.ctx;
    const register = (disposable) => {
      if (typeof this.register === "function") this.register(disposable);
    };
    // The host assigns instance.ctx before onload; instance methods (_applyNow,
    // _sweep, _agentsDir, ...) resolve the context through this._ctx, so the
    // mirror MUST be written here — missing this assignment leaves every bus
    // path (session:update sweeps, event handlers) crashing with
    // "Cannot read properties of undefined (reading 'bus')".
    this._ctx = ctx;
    // Closure-scoped runtime state: JSON-safe on the instance (no timers).
    const timers = [];
    let pendingSweepTimer = null;
    let sweepBusy = false;
    let sweepTimer = null;

    initLogging(ctx.dataDir);
    appendLog("lifecycle", "onload start", { dataDir: ctx.dataDir || null, pluginId: ctx.pluginId || null });

    this._sync = async () => {
      try {
        setState(await readConfig(ctx));
      } catch (err) {
        appendLog("lifecycle", `config sync failed: ${err?.message || err}`);
      }
    };
    await this._sync();

    // Re-sync when the user edits plugin settings; slow fallback interval in
    // case a future update renames the change event.
    try {
      const unsub = ctx.bus?.subscribe?.((event) => {
        if (event?.type === "plugin_config_changed" && event?.pluginId === ctx.pluginId) {
          void this._sync();
        }
      });
      if (typeof unsub === "function") register(unsub);
    } catch (err) {
      appendLog("lifecycle", `config event subscribe unavailable: ${err?.message || err}`);
    }
    const cfgTimer = setInterval(() => void this._sync(), 60_000);
    if (typeof cfgTimer?.unref === "function") cfgTimer.unref();
    timers.push(cfgTimer);

    // Session/channel lifecycle events.
    try {
      const unsubEvents = ctx.bus?.subscribe?.((event, sessionPath) => {
        this._onBusEvent(event, sessionPath);
      });
      if (typeof unsubEvents === "function") register(unsubEvents);
    } catch (err) {
      appendLog("lifecycle", `bus subscribe unavailable: ${err?.message || err}`);
    }

    // Initial sweep (delayed so the server finishes wiring up), then a slow
    // self-heal sweep.
    const initialTimer = setTimeout(() => void this._sweep("startup"), SWEEP_STARTUP_DELAY_MS);
    if (typeof initialTimer?.unref === "function") initialTimer.unref();
    timers.push(initialTimer);
    sweepTimer = setInterval(() => void this._sweep("interval"), SWEEP_INTERVAL_MS);
    if (typeof sweepTimer?.unref === "function") sweepTimer.unref();
    timers.push(sweepTimer);

    register(() => {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.length = 0;
      if (pendingSweepTimer) clearTimeout(pendingSweepTimer);
    });

    appendLog("lifecycle", "loaded: enforcement active for all sessions and channels");
    ctx.log?.info?.("[hana-max-thinking] lifecycle loaded: every session/channel will run at the highest supported thinking level");
  }

  _onBusEvent(event, sessionPath) {
    const state = getState();
    if (!state.enabled) return;
    if (event?.type === "session_created") {
      // Immediate enforcement for brand-new sessions/channels.
      const created = event?.session || {};
      const sessionId = created.sessionId || created.sessionRef?.sessionId || null;
      const createdPath = created.sessionPath || created.path || sessionPath || null;
      void this._applyNow({ sessionId, sessionPath: createdPath }, "session_created");
      return;
    }
    if (event?.type === "session_metadata_updated") {
      const level = event?.metadata?.thinkingLevel;
      if (typeof level !== "string") return;
      const key = sessionPath || event?.sessionPath || null;
      if (!key) return;
      if (recentlyApplied(key, 15_000)) return; // echo of our own write
      if (isApplying(key)) return; // echo arrived while our write is in flight
      if (state.respectManualChoice) {
        markManualHold(key);
        appendLog("lifecycle", "manual choice respected (hold 30m)", { session: key, level });
        return;
      }
      if (!levelBelowTarget(level)) return;
      // Direct targeted fix, throttle-exempt: clicking a lower tier in the
      // frontend is corrected within this turn.
      void this._applyNow({ sessionPath: key }, "metadata_downgrade", { ignoreThrottle: true });
    }
  }

  async _applyNow(target, reason, { ignoreThrottle = false } = {}) {
    if (!this._ctx) {
      appendLog("lifecycle", "apply skipped: lifecycle ctx unavailable (plugin not fully activated)");
      return false;
    }
    const key = target.sessionId || target.sessionPath;
    if (!key) return false;
    if (isApplying(key)) return false; // a write for this key is already in flight
    if (!ignoreThrottle && (recentlyApplied(key, APPLY_THROTTLE_MS) || isManualHold(String(key)))) return false;
    beginApply(key);
    try {
      const payload = { thinkingLevel: BUS_LEVEL };
      if (target.sessionId) {
        payload.sessionId = target.sessionId;
        if (target.sessionPath) payload.sessionRef = { sessionId: target.sessionId, sessionPath: target.sessionPath };
      } else {
        payload.sessionPath = target.sessionPath;
      }
      const result = await this._ctx.bus.request("session:update", payload);
      markApplied([key, result?.sessionId, result?.session?.path]);
      // The host shell always answers ok:true; the truth is whether it could
      // resolve a loaded session for the path. Hub-run phone sessions are not
      // engine-managed on 0.449.0, so the update is a silent no-op for them —
      // log that honestly instead of claiming success (phone channels are
      // enforced by the per-turn extension; this sweep is best-effort).
      const effective = result?.ok !== false && (result?.session != null || result?.sessionId != null);
      if (effective) {
        appendLog("lifecycle", "session:update applied", {
          session: String(key),
          level: BUS_LEVEL,
          reason,
          ok: true,
        });
      } else {
        appendLog("lifecycle", "session:update ineffective: host has no loaded session for this path", {
          session: String(key),
          level: BUS_LEVEL,
          reason,
        });
      }
      return effective;
    } catch (err) {
      appendLog("lifecycle", `session:update failed (${reason})`, {
        session: String(key),
        error: err?.message || String(err),
      });
      return false;
    } finally {
      endApply(key);
    }
  }

  async _sweep(reason) {
    const state = getState();
    if (!this._ctx) {
      appendLog("lifecycle", `sweep skipped (${reason}): lifecycle ctx unavailable (plugin not fully activated)`);
      return;
    }
    if (!state.enabled || !state.syncSessionMeta || this._sweepBusy) return;
    this._sweepBusy = true;
    try {
      await this._sweepDesktopSessions(reason);
      await this._sweepPhoneSessions(reason);
    } catch (err) {
      appendLog("lifecycle", `sweep failed (${reason}): ${err?.message || err}`);
    } finally {
      this._sweepBusy = false;
    }
  }

  async _sweepDesktopSessions(reason) {
    const ctx = this._ctx;
    if (typeof ctx.bus?.request !== "function") return;
    let list = [];
    try {
      const result = await ctx.bus.request("session:list", { includePluginPrivate: true });
      list = Array.isArray(result?.sessions) ? result.sessions : (Array.isArray(result) ? result : []);
    } catch (err) {
      appendLog("lifecycle", `session:list failed (${reason}): ${err?.message || err}`);
      return;
    }
    let applied = 0;
    for (const item of list) {
      if (!item || item.agentDeleted) continue;
      const owner = item?.ownerPluginId;
      if (owner && owner !== ctx.pluginId) continue;
      const sessionId = item?.sessionId || null;
      const sessionPath = item?.path || item?.sessionPath || null;
      if (!sessionId && !sessionPath) continue;
      if (recentlyApplied(sessionId || sessionPath, APPLY_THROTTLE_MS) || isApplying(sessionId || sessionPath)) continue;
      if (isManualHold(String(sessionId || sessionPath))) continue;
      const target = sessionId ? { sessionId } : { sessionPath };
      const ok = await this._applyNow(target, reason);
      if (ok) applied += 1;
    }
    appendLog("lifecycle", `sweep(${reason}) done`, { total: list.length, applied });
  }

  // Phone/channel sessions are domain "phone" and excluded from session:list,
  // so discover them on disk under ${HANA_HOME}/agents/<agent>/phone/sessions
  // and apply through the legacy sessionPath input.
  async _sweepPhoneSessions(reason) {
    const agentsDir = this._agentsDir();
    if (!agentsDir || !dirExistsSafe(agentsDir)) {
      appendLog("lifecycle", `phone sweep skipped (${reason}): agents dir unavailable`);
      return;
    }
    let agentDirs;
    try {
      agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(agentsDir, entry.name));
    } catch (err) {
      appendLog("lifecycle", `phone scan failed (${reason}): ${err?.message || err}`);
      return;
    }
    let applied = 0;
    for (const agentDir of agentDirs) {
      const sessionsDir = path.join(agentDir, "phone", "sessions");
      let convDirs;
      try {
        convDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(sessionsDir, entry.name));
      } catch {
        continue; // agent without phone sessions
      }
      for (const convDir of convDirs) {
        let roundFiles;
        try {
          roundFiles = fs.readdirSync(convDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => path.join(convDir, entry.name));
        } catch {
          continue;
        }
        for (const roundFile of roundFiles) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(roundFile).mtimeMs;
          } catch {
            continue;
          }
          if (Date.now() - mtimeMs > PHONE_FRESH_MS) continue;
          if (recentlyApplied(roundFile, PHONE_THROTTLE_MS) || isApplying(roundFile)) continue;
          const ok = await this._applyNow({ sessionPath: roundFile }, "phone");
          if (ok) applied += 1;
        }
      }
    }
    appendLog("lifecycle", `phone sweep(${reason}) done`, { applied });
  }

  _agentsDir() {
    // dataDir = ${HANA_HOME}/plugin-data/<pluginId> → home is two levels up.
    const dataDir = this._ctx?.dataDir;
    if (!dataDir) return null;
    try {
      return path.resolve(path.dirname(path.dirname(dataDir)), "agents");
    } catch {
      return null;
    }
  }

  async onunload() {
    appendLog("lifecycle", "onunload");
    this.ctx?.log?.info?.("[hana-max-thinking] lifecycle unloaded");
  }
}
