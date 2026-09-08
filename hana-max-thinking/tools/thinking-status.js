// Agent-callable tool: thinking_status (read-only diagnostics).
import fs from "node:fs";
import { getState, getDiagnostics, getLogFile } from "../state.js";

export const name = "thinking_status";
export const description = "hana-max-thinking 插件状态查询：报告思考等级强制配置、degraded 状态、最近按会话的等级应用记录（before→after）与文件日志尾部。调用方式：mcp_call { server: \"hana-max-thinking\", tool: \"hana-max-thinking_thinking_status\", arguments: {} }。当用户询问思考等级 / thinking level / 推理档位 / Max / 深度推理状态时调用本工具，不要查询 MCP 连接器。";
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
  // The capability namespace differs by validation context (an upstream gap
  // for plugin tools used as deferred builtins):
  // - deferred path: the descriptor is normalized against the mcp_call bridge
  //   tool, so the registered catalog delegate accepts only
  //   <catalog entry name>.<action> = "hana-max-thinking_thinking_status.status"
  // - direct (live) load: the descriptor is normalized against this tool,
  //   where invocationToolName strips the plugin prefix, so the capability
  //   must be <local name>.<action> = "thinking_status.status"
  // The resolver is synchronous and context-free by contract; the call stack
  // is the only path discriminator available (the bridge's resolver frame lives
  // in tool-catalog-bridge). Default to the deferred/bridge form — deferred
  // sessions are the common case once any connector is enabled — and use the
  // local form only when the direct wrapper is clearly on the stack.
  resolveInvocation: () => {
    let capability = "hana-max-thinking_thinking_status.status";
    try {
      const stack = new Error().stack || "";
      if (/session-permission-wrapper|resolveToolInvocationPermission/i.test(stack)
        && !/tool-catalog-bridge/i.test(stack)) {
        capability = "thinking_status.status";
      }
    } catch {
      // Stack inspection unavailable: keep the deferred default.
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
