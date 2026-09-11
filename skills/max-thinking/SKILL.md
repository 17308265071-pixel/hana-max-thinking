---
name: max-thinking
description: hana-max-thinking 插件使用指南。当用户询问思考等级、thinking level、推理档位、深度推理、Max、查询思考状态、为什么思考档位被改回最高、频道或会话思考配置时，把 thinking_status 当作普通原生工具直接调用（工具列表里名为 hana-max-thinking_thinking_status）读取真实状态；不要用 mcp_call 路由本插件，也不要查 MCP 连接器状态。工具通道失败则直接读 plugin-data/hana-max-thinking/enforce.log。
---

# Max Thinking 插件

本插件（`hana-max-thinking`）强制所有会话与频道中的模型运行在它支持的最高思考等级。

## Agent 行为约定

- 用户提到「思考等级 / thinking level / 推理档位 / Max / 深度 / 为什么被弹回」等话题时，按顺序尝试，**命中即停**：
  1. **直调原生工具**：工具列表里直接调用 `hana-max-thinking_thinking_status`（无参数）。HanaAgent ≥ 0.449.0 上插件工具直接加载，这是首选且通常一次成功。
  2. **旧版本（< 0.449）延迟挂载时**：直调不可用则走 `mcp_call`，参数 `{ "server": "hana-max-thinking", "tool": "hana-max-thinking_thinking_status", "arguments": {} }`（仅旧版本有效，新版本会报"找不到 server"）。
  3. **兜底（任何版本都可靠）**：用 read 工具直接读日志文件 `${HANA_HOME}/plugin-data/hana-max-thinking/enforce.log`（JSONL，每行 {ts, source, message, session, level, reason}），运行时真实等级以它为准。若第 1/2 步出现 capability / resolver 类报错，**不要换姿势重试**，直接走第 3 步。
- `thinking_status` 输出：当前强制配置、degraded 状态、最近 10 条按会话的 before→after 记录、文件日志尾部。
- 真实运行时等级以会话流水（JSONL `thinking_level_change`）和 `thinking_status` 输出为准；agent 级配置 `settings.agent.thinkingLevels` 只是静态偏好，不代表请求实际携带的等级。
- 档位名词对照：Pi SDK `xhigh` ↔ Hana 界面「最高/Max」；模型不支持 xhigh 时自动落到该模型最高档（如 `high`/深度）。GLM 系列在协议层只有思考开/关，深度即其真实上限。
- 强制逻辑：每轮 `before_agent_start` 由 Pi SDK 扩展调用 `pi.setThinkingLevel`；元数据由生命周期通过 `session:update` 同步（前端选择器读元数据，所以点击低档位会在 2 秒左右弹回最高档，这是 `respectManualChoice: false` 的默认行为）。
- 会话重载瞬间的少量 "stale ctx skip" 日志属正常现象（旧 runner 上的排队事件），不影响功能，也不计入 degraded。
