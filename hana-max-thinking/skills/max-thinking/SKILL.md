---
name: max-thinking
description: hana-max-thinking 插件使用指南。当用户询问思考等级、thinking level、推理档位、深度推理、Max、查询思考状态、为什么思考档位被改回最高、频道或会话思考配置时，调用 thinking_status 工具（mcp_call 参数 server="hana-max-thinking", tool="hana-max-thinking_thinking_status"）读取真实状态；工具通道失败则直接读 plugin-data/hana-max-thinking/enforce.log。这是 Hana 插件，不是 MCP 连接器，不要查连接器状态。
---

# Max Thinking 插件

本插件（`hana-max-thinking`）强制所有会话与频道中的模型运行在它支持的最高思考等级。

## Agent 行为约定

- 用户提到「思考等级 / thinking level / 推理档位 / Max / 深度 / 为什么被弹回」等话题时，**首选调用 `thinking_status` 工具**，不要读 agent 配置文件里的静态值——那不是运行时真实值，也不要把本插件当成 MCP 连接器去查连接状态。
- 正确调用方式（按 mcp_describe_tool 给出的示例）：`mcp_call`，参数 `{ "server": "hana-max-thinking", "tool": "hana-max-thinking_thinking_status", "arguments": {} }`。server 必须是 `hana-max-thinking`，tool 必须是 `hana-max-thinking_thinking_status`，不要传别的名字。
- 如果工具通道失败，**回退方案**：用 read 工具直接读日志文件 `${HANA_HOME}/plugin-data/hana-max-thinking/enforce.log`（JSONL，每行 {ts, source, message, session, level, reason}），运行时真实等级以它为准。
- `thinking_status` 输出：当前强制配置、degraded 状态、最近 10 条按会话的 before→after 记录、文件日志尾部。
- 真实运行时等级以会话流水（JSONL `thinking_level_change`）和 `thinking_status` 输出为准；agent 级配置 `settings.agent.thinkingLevels` 只是静态偏好，不代表请求实际携带的等级。
- 档位名词对照：Pi SDK `xhigh` ↔ Hana 界面「最高/Max」；模型不支持 xhigh 时自动落到该模型最高档（如 `high`/深度）。GLM 系列在协议层只有思考开/关，深度即其真实上限。
- 强制逻辑：每轮 `before_agent_start` 由 Pi SDK 扩展调用 `pi.setThinkingLevel`；元数据由生命周期通过 `session:update` 同步（前端选择器读元数据，所以点击低档位会在 2 秒左右弹回最高档，这是 `respectManualChoice: false` 的默认行为）。
- 会话重载瞬间的少量 "stale ctx skip" 日志属正常现象（旧 runner 上的排队事件），不影响功能，也不计入 degraded。
