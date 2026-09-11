// Agent-callable tool: thinking_status (read-only diagnostics).
import fs from "node:fs";

// Versioned dynamic import (cache-busting): see index.js.
const MODULE_VERSION = "0.2.0";
const { getState, getDiagnostics, getLogFile } = await import(new URL("../state.js?v=" + MODULE_VERSION, import.meta.url).href);

export const name = "thinking_status";
export const description = "hana-max-thinking 插件状态查询：报告思考等级强制配置、degraded 状态、最近按会话的等级应用记录（before→after）与文件日志尾部。HanaAgent >= 0.449 直接作为原生工具调用（无参数）；旧版本 < 0.449 可经 mcp_call { server: \"hana-max-thinking\", tool: \"hana-max-thinking_thinking_status\" } 调用；均失败则读 plugin-data/hana-max-thinking/enforce.log。当用户询问思考等级 / thinking level / 推理档位 / Max / 深度推理状态时调用本工具。";
export const parameters = { type: "object", properties: {} };

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "plugin_config",
    summary: "Read hana-max-thinking enforcement status (no writes).",
  }),
  // Required for the deferred-builtin mcp_call path: without a resolveInvocation
  // descriptor the bridge's permission resolver fails closed and every call is
  // rejected with TOOL_INVOCATION_RESOLVER_FAILED. kind: "read" keeps this
  // tool approval-free.
  //
  // The descriptor capability namespace depends on the validation context of
  // the executing tool (an upstream gap for plugin tools):
  // - direct (live) load: validated against this tool with the plugin prefix
  //   stripped -> capability must be "thinking_status.status"
  // - deferred bridge (older hosts): validated against the mcp_call tool with a
  //   catalog delegate that accepts "hana-max-thinking_thinking_status.status"
  // On Hana >= 0.449.0 plugin tools are live-loaded (direct semantics) and the
  // deferred bridge no longer routes plugin tools, so the LOCAL form is the
  // correct default. Only switch to the catalog form when a bridge frame is
  // positively present on the stack; opaque stacks stay on the local form.
  resolveInvocation: () => {
    let capability = "thinking_status.status";
    try {
      const stack = new Error().stack || "";
      if (/tool-catalog-bridge|resolveBuiltinInvocation/i.test(stack)) {
        capability = "hana-max-thinking_thinking_status.status";
      }
    } catch {
      // Stack inspection unavailable: keep the local form.
    }
    return { action: "status", kind: "read", capability };
  },
};

export async function execute() {
  const state = getState();
  const diag = getDiagnostics();
  const logFile = getLogFile();
  let logTail = [];
  if (logFile) {
    try {
      const raw = fs.readFileSync(logFile, "utf-8");
      logTail = raw.trim().split("\n").filter(Boolean).slice(-12);
    } catch {
      logTail = [];
    }
  }
  const lines = [
    `enabled: ${state.enabled}`,
    `targetLevel (Pi tier; Hana UI shows xhigh as 最高/Max): ${state.targetLevel}`,
    `enforceEveryTurn: ${state.enforceEveryTurn}`,
    `syncSessionMeta (frontend adaptation): ${state.syncSessionMeta}`,
    `respectManualChoice: ${state.respectManualChoice}`,
    `excludeModels: ${state.excludeModels.length > 0 ? state.excludeModels.join(", ") : "(none)"}`,
    `degraded: ${diag.degraded ? `yes - ${diag.degraded.message} @ ${diag.degraded.at}` : "no"}`,
    `log file: ${logFile || "(unavailable)"}`,
    `recent applications (${diag.recent.length}):`,
    ...diag.recent.slice(0, 10).map((entry) => (
      `- ${entry.ts} ${entry.model || ""}: ${entry.before ?? "?"} -> ${entry.after ?? "?"} (target ${entry.target}, ${entry.reason})`
    )),
    `log tail (${logTail.length}):`,
    ...logTail.map((line) => `  ${line}`),
  ];
  return lines.join("\n");
}
