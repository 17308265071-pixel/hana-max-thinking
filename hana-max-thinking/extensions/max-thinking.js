// Pi SDK extension: force every chat turn to the highest supported thinking
// level for the current model.
//
// How it stays correct across Hana updates:
// - It never reads Hana's config JSON files. Config reaches it through the
//   shared state mirror (state.js), synced from ctx.config by the lifecycle.
// - It uses the Pi SDK runtime API (pi.getThinkingLevel / pi.setThinkingLevel)
//   instead of rewriting provider payloads. The SDK clamps the requested level
//   to whatever the current model supports (e.g. xhigh -> high on models
//   without an xhigh tier, or off on non-reasoning models), and Hana's own
//   provider-compat layer translates the level into each provider's wire
//   format. Upstream keeps owning the provider-specific JSON shape.
//
// Coverage: the factory is instantiated for every Pi session Hana builds —
// desktop sessions, phone/channel sessions (hub agent-executor), and bridge
// sessions all load the same ResourceLoader extension array.

import {
  appendLog,
  clearDegraded,
  getState,
  markDegraded,
  recordEnforcement,
} from "../state.js";

const TARGET_LEVELS = new Set(["xhigh", "high"]);

// Queued events can still arrive on an old extension runner right after the
// session was replaced/reloaded. That is expected and transient — not a
// plugin defect — so it is skipped silently instead of flagging degraded.
const STALE_CTX_PATTERN = /stale after session replacement or reload/i;

function normalizeTarget(state) {
  return TARGET_LEVELS.has(state?.targetLevel) ? state.targetLevel : "xhigh";
}

function isExcluded(patterns, modelId) {
  if (!Array.isArray(patterns) || patterns.length === 0 || !modelId) return false;
  const id = String(modelId).toLowerCase();
  for (const raw of patterns) {
    const pattern = String(raw || "").trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.endsWith("*")) {
      if (id.startsWith(pattern.slice(0, -1))) return true;
    } else if (id.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function sessionKey(ctx) {
  try {
    return ctx?.sessionManager?.getSessionFile?.() || "unknown";
  } catch {
    return "unknown";
  }
}

function isStaleContextError(err) {
  return STALE_CTX_PATTERN.test(String(err?.message || err));
}

function enforce(state, pi, ctx, reason) {
  if (!state?.enabled) return;
  if (typeof pi?.getThinkingLevel !== "function" || typeof pi?.setThinkingLevel !== "function") {
    markDegraded("Pi runtime thinking API unavailable (getThinkingLevel/setThinkingLevel missing)");
    return;
  }
  const model = ctx?.model || null;
  const modelId = model?.id ? String(model.id) : "";
  if (!modelId) return; // model not resolved yet; a later event will enforce
  if (isExcluded(state.excludeModels, modelId)) return;

  const target = normalizeTarget(state);
  let before = null;
  try {
    before = pi.getThinkingLevel();
  } catch (err) {
    if (isStaleContextError(err)) {
      appendLog("extension", "stale ctx skip (expected after session reload)", { session: sessionKey(ctx), reason });
      return;
    }
    markDegraded(`getThinkingLevel failed: ${err?.message || err}`);
    return;
  }
  try {
    // setThinkingLevel clamps to the model's supported levels and only
    // persists when the level actually changes, so this is idempotent.
    pi.setThinkingLevel(target);
  } catch (err) {
    if (isStaleContextError(err)) {
      appendLog("extension", "stale ctx skip (expected after session reload)", { session: sessionKey(ctx), reason });
      return;
    }
    markDegraded(`setThinkingLevel failed: ${err?.message || err}`);
    return;
  }
  let after = null;
  try {
    after = pi.getThinkingLevel();
  } catch (err) {
    if (isStaleContextError(err)) {
      appendLog("extension", "stale ctx skip during readback", { session: sessionKey(ctx), reason });
      return;
    }
  }
  clearDegraded();
  recordEnforcement(sessionKey(ctx), {
    model: modelId,
    before,
    after,
    target,
    reason,
    at: new Date().toISOString(),
  });
}

export default function maxThinking(pi) {
  // New or reloaded session: apply immediately so even the very first request
  // runs at the target level.
  pi.on("session_start", (event, ctx) => {
    enforce(getState(), pi, ctx, "session_start");
  });

  // Every user turn: re-assert. This catches model switches (the session
  // re-derives the level on switch), manual downgrades in the UI, and
  // hibernation restores that read an older level from session meta.
  pi.on("before_agent_start", (event, ctx) => {
    const state = getState();
    if (!state.enforceEveryTurn) return; // session_start already applied
    enforce(state, pi, ctx, "before_agent_start");
  });

  // Immediate re-assert when the level is changed mid-session (UI select,
  // model switch restore). The guard stops the echo of our own set from
  // chaining: setThinkingLevel only emits this event when the level actually
  // changed, and once we are at the clamped target it stops emitting.
  let reasserting = false;
  pi.on("thinking_level_select", (event, ctx) => {
    if (reasserting) return;
    const state = getState();
    if (!state.enabled || !state.enforceEveryTurn) return;
    if (event?.level === normalizeTarget(state)) return; // already at target
    reasserting = true;
    try {
      enforce(state, pi, ctx, "thinking_level_select");
    } finally {
      reasserting = false;
    }
  });
}
