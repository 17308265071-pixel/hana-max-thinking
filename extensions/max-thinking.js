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

// Versioned dynamic import (cache-busting): see index.js. A static import of
// ../state.js would bind this extension to the module instance cached by the
// running host process, breaking in-place plugin updates.
const MODULE_VERSION = "0.2.0";
const {
  appendLog,
  clearDegraded,
  getState,
  markDegraded,
  recordEnforcement,
} = await import(new URL("../state.js?v=" + MODULE_VERSION, import.meta.url).href);

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

// ── System-prompt guide injection (append-only, per-request idempotent) ──
// Skills and tool descriptions are easy for the model to skim past (observed
// in real channels: instructions sitting in the skill description were
// ignored). A compact block appended to the system prompt every request is
// the strongest plugin-level "must-read" channel and does not touch Hana.
const GUIDE_MARKER = "[max-thinking-guide]";
const GUIDE_BASE = [
  "思考档位由 hana-max-thinking 插件每轮自动强制为当前模型的最高支持档（UI 显示「最高/Max」；不支持 xhigh 的模型会落到其最高档，这是正常收敛，不是故障）。",
  "用户问「现在是什么档/为什么被改」：先按下面的方式查证再回答，禁止猜测，也不要让用户自己查；完整说明见技能 max-thinking。",
].join("\n");
const GUIDE_NATIVE = "查询思考状态：直接调用工具 thinking_status 或 hana-max-thinking_thinking_status（无参数；它已在你的工具列表里，不要先搜索）。";
const GUIDE_BRIDGE = "查询思考状态：经 mcp_call 调用（server: \"hana-max-thinking\", tool: \"hana-max-thinking_thinking_status\", 无参数；不要先搜索）。";
const GUIDE_FALLBACK = "思考状态兜底：read <HANA_HOME>/plugin-data/hana-max-thinking/enforce.log（JSONL，每行含 model/before/after/target）。";

function toolNameOf(tool) { return tool?.function?.name || tool?.name; }

function guideTextFor(tools) {
  const names = new Set((Array.isArray(tools) ? tools : []).map((t) => toolNameOf(t)).filter(Boolean));
  let queryLine;
  if (names.has("thinking_status") || names.has("hana-max-thinking_thinking_status")) queryLine = GUIDE_NATIVE;
  else if (names.has("mcp_call")) queryLine = GUIDE_BRIDGE;
  else queryLine = null;
  return queryLine ? `${GUIDE_BASE}\n${queryLine}\n${GUIDE_FALLBACK}` : `${GUIDE_BASE}\n${GUIDE_FALLBACK}`;
}

function stripMarker(text, marker) {
  if (typeof text !== "string") return text;
  const i = text.indexOf(marker);
  return i === -1 ? text : text.slice(0, i).replace(/\s+$/, "");
}

function appendBlock(text, marker, block) {
  if (typeof text !== "string" || !block) return text;
  const base = stripMarker(text, marker);
  return `${base.replace(/\s+$/, "")}\n\n${marker}\n${block}`;
}

function getSystemText(payload) {
  if (typeof payload?.system === "string") return payload.system;
  if (payload && Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m?.role !== "system") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) return m.content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("");
    }
  }
  return "";
}

function setSystemText(payload, text) {
  if (typeof payload?.system === "string") { payload.system = text; return; }
  if (!Array.isArray(payload.messages)) return;
  for (let i = 0; i < payload.messages.length; i += 1) {
    const m = payload.messages[i];
    if (m?.role === "system") { payload.messages[i] = { ...m, content: text }; return; }
  }
  payload.messages.unshift({ role: "system", content: text });
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

  // Plugin must-read guide: append a compact block to the system prompt of
  // every request (idempotent per request; the base prompt is rebuilt by the
  // host each turn, so this never accumulates in session history). Gated by
  // state.injectGuide so users can turn it off.
  pi.on("before_provider_request", (event) => {
    try {
      const state = getState();
      if (!state.enabled || state.injectGuide === false) return event?.payload;
      const p = event?.payload;
      if (!p || typeof p !== "object") return event?.payload;
      const system = getSystemText(p);
      const next = appendBlock(system, GUIDE_MARKER, guideTextFor(p.tools));
      if (next !== system) setSystemText(p, next);
      return p;
    } catch {
      // 非破坏铁律：注入失败绝不阻断 Hana 管道
      return event?.payload;
    }
  });
}
