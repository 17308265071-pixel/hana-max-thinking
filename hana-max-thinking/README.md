# Max Thinking (hana-max-thinking)

> 强制 HanaAgent 会话与频道中的**所有模型**默认运行在它支持的最高思考等级——修复 GLM 5.3 Flash 等模型在频道里"不说话"的痛点。

**作者：2990927961** · Hana 插件市场 ID：`hana-max-thinking`

## 解决什么痛点

GLM 5.3 Flash / DeepSeek V4 Flash 等模型的回答质量与**思考链（thinking）强相关**：

- **频道/群聊里 agent 失语**：GLM 系列在协议层思考是开/关制，思考等级被 Hana 以 agent 级配置或频道执行器硬编码的 `medium` 创建后，模型可能因思考不足而输出空回复、卡在"正在准备回复"（典型现象：`@某agent 为什么不说话`）。
- **界面档位不能表达最高档**：Hana 思考选择器只显示 关闭/中等/深度（GLM 无 Max 档），无法一键固定最高档。
- **手动改档不持久**：agent 级配置是静态值，会话休眠恢复、模型切换后回落，用户要点很多次。
- **Hana 更新会冲掉手工 JSON 修改**：改 `config.json` 的思考等级，一次更新就没了。

本插件在**请求管线内**每轮强制最高思考等级，并把结果同步进会话元数据，让前端选择器落实显示——不依赖任何 Hana 配置 JSON 字段，应用更新不影响。

## 功能

- **全表面覆盖**：桌面会话、频道/DM（Hana 内部硬编码 `thinkingLevel: "medium"` 的 agent-executor 路径也会被纠正）、Bridge 会话。
- **按模型自适应**：请求 Pi SDK 最高档 `xhigh`，SDK 自动按模型能力收敛——支持 Max 的模型（GPT-5.2+、Claude opus-5/sonnet-5、DeepSeek V4 Flash 等）→ Max；不支持的推理模型 → 该模型最高档（如深度）；非推理模型 → 无害保持。
- **创建即启用**：`session_created` 总线事件 → 新会话/频道立刻写入最高档；旧频道通过文件系统扫描逐个补齐。
- **前端落实**：通过总线 `session:update` 把强制等级写回会话元数据——思考档位选择器立即显示被强制的档位；点击低档位约 2 秒自动弹回。
- **每轮自我修复**：手动下调、模型切换回落、休眠恢复旧值都会在下一轮自动纠正。
- **只读诊断工具**：`thinking_status` 让 agent 直接报告真实运行时等级（非静态配置值）。
- **文件日志**：`plugin-data/hana-max-thinking/enforce.log`（JSONL）记录每次强制的会话/模型/before→after。
- **更新安全**：插件装在 `${HANA_HOME}/plugins/`（用户数据目录），配置持久化在 `plugin-data/`，不解析任何 Hana 内部配置 JSON，应用更新不会覆盖或破坏。

## 安装

**方式 A — 插件市场（推荐）**：Hana 设置 → 插件 → 打开插件市场 → 搜索 "Max Thinking" → 安装。

**方式 B — 手动**：把本仓库的 `hana-max-thinking/` 文件夹整个复制到 `<用户目录>\.hanako\plugins\`（macOS/Linux 为 `~/.hanako/plugins/`），重启 Hana。

安装后：设置 → 插件 → Max Thinking → 打开**全权（full-access）**开关。

## 配置项

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `targetLevel` | `xhigh` \| `high` | `xhigh` | 目标等级；`xhigh`=最高（界面"最高/Max"） |
| `enforceEveryTurn` | boolean | `true` | 每轮重新强制；关闭则只在新会话启动时应用一次 |
| `syncSessionMeta` | boolean | `true` | 前端适配：等级写回会话元数据（选择器立即落实） |
| `respectManualChoice` | boolean | `false` | 用户手动下调时 30 分钟内不强制该会话 |
| `excludeModels` | string[] | `[]` | 排除模型（模型 id 子串；`gpt-5*` 支持前缀通配） |

## 目录结构

```
hana-max-thinking/
├── manifest.json
├── state.js                    # 配置镜像 + 日志 + 应用记录（共享单例）
├── index.js                    # 生命周期：config 同步 + 元数据扫描下发（零 SDK 依赖）
├── extensions/
│   └── max-thinking.js         # Pi SDK 扩展：每轮强制最高思考等级
├── skills/
│   └── max-thinking/SKILL.md   # Agent 知识注入
├── tools/
│   └── thinking-status.js      # 只读状态查询工具
└── README.md
```

## 兼容性

- HanaAgent ≥ 0.158.0
- Windows / macOS / Linux
- 零 npm 依赖，跨平台无路径假设

## 作者

- **2990927961**
- 反馈/问题：在本仓库提 Issue
