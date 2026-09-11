# Max Thinking (hana-max-thinking)

> 强制 HanaAgent 会话与频道中的**所有模型**默认运行在它支持的最高思考等级——修复 GLM 5.3 Flash 等模型在频道里"不说话"的痛点。

**作者：2990927961** · Hana 插件市场 ID：`hana-max-thinking`

## v0.2.0 修复（0.449 覆盖安装失败）

- **现象**：运行中的 Hana 里直接安装新版本 zip 报 `插件安装失败: The requested module './state.js' does not provide an export named 'beginApply'`。
- **根因**：宿主进程在整个生命周期内缓存 ESM 模块实例；旧版 `index.js` 用静态 `import "./state.js"` 载入，覆盖安装后解析到的仍是**旧 state.js**（没有新导出），入口加载失败。
- **修复**：与极简模式同样的 **cache-busting 版本化动态导入**——`index.js`、`extensions/max-thinking.js`、`tools/thinking-status.js` 全部改为 `await import(new URL("./state.js?v=" + MODULE_VERSION, import.meta.url).href)`，每个版本拥有独立模块图，覆盖安装/热重载不再撞缓存；新增版本一致性回归测试（MODULE_VERSION 三处 == manifest.version）。

## v0.1.12 新增（插件必读说明注入）

- **问题**：频道实测（ch_0434b9）证明"指望模型自觉去读 skill/文档"不可靠——工具描述与 skill 描述里的关键约定（如"勿经 mcp_call"）都会被模型忽略。
- **方案（插件层级，不动 Hana）**：扩展在 `before_provider_request` 往**系统提示**末尾追加一个紧凑的 `[max-thinking-guide]` 必读块（每请求幂等，宿主每轮重建基础提示所以不会累积）：说明档位被强制的机制、查询口径（原生 `thinking_status` 直调，勿包 mcp_call）、兜底日志路径、"先查证再回答，不要猜测/不要让用户自己查"。
- **这是插件能拿到的最强通道**：系统提示是注意力最高的位置；工具描述/skill 描述仍保留作为深层文档。
- **可关**：设置里新增 `injectGuide`（默认开）。关闭即回到纯工具/技能描述形态。

## v0.1.11 修复（元数据回声竞态）

- **现象**：真实日志（0.449.0）里同一桌面会话在 46ms 内被连续写入 **10 次** `session:update`（`metadata_downgrade`），00:32:30 的周期 sweep 甚至出现同会话 300ms 内 ~20 次；前端选择器闪烁、总线与磁盘无谓写入。
- **根因**：`session:update` 的**回声事件**（`session_metadata_updated`）有时在本插件的 `bus.request` Promise 解决**之前**送达；此时"最近已写"标记尚未落下，回声被误判为用户下调 → 再写一次 → 又产生回声，形成竞态窗口内的连写。
- **修复**：新增「写入中（in-flight）」登记——请求在途期间该 key 的回声一律忽略；配合原有 15 秒回声窗口，每次真实事件**恰好写 1 次**。sweep 也跳过在途 key，避免重复请求。
- **回归测试**：B11 模拟"回声先于请求解决"的时序，断言恰好 1 次写入（修复前为 2 次，红绿可验）。
- **附带的诚实化修正**：`session:update` 外层回包恒为 `ok:true`，此前 phone sweep 对 hub 管理的频道会话报"applied"实为假阳性（0.449.0 实测：所有 phone 会话 `thinking_level` 仍为 `null`，且 `bus.request` 内层为 `session not found`）。现在只有宿主确实解析到已加载会话才记 `applied`，否则记 `ineffective`——频道目录兜底扫描降级为**尽力而为**，频道真正的强制路径是每轮扩展。

## v0.1.10 修复（频道兜底扫描）

- **根因**：phone/频道会话按轮次落盘为 `<convDir>/<时间戳>_xxx.jsonl`，而兜底扫描写死查找 `<convDir>/phone.jsonl`——永远找不到 → `phone sweep applied: 0`；叠加热重载窗口里扩展对忙碌会话的 `stale ctx skip`，频道会短暂停留在宿主初始的 `medium`（实测频道 ch_a34e29 只留下一条 `medium`，而旧样本正常形态是启动后毫秒级 `medium→high`）。
- **修复**：扫描改为匹配 `<convDir>/*.jsonl`，并加 **15 分钟新鲜度门槛**（只补最近活跃的轮次文件，不改写历史）；每文件仍受 30 分钟节流保护。插件加载后 4 秒的启动扫描即可把最近活跃频道顶到最高档，之后每 10 分钟兜底。
- **验收口径**：落地值以该模型最高支持档为准——不支持 `xhigh` 的模型（如 deepseek-v4.1-flash / GLM 系列）由 SDK 收敛为 `high`，`enforce.log` 中 `target: xhigh, after: high` 即正确。

## 兼容性说明（v0.1.9）

- **HanaAgent ≥ 0.449.0**：`thinking_status` 作为原生工具直接调用（capability 本地命名空间，免审批）。
- **HanaAgent < 0.449.0**：插件工具可能被延迟挂载到 mcp_call 桥——此时经 `mcp_call { server: "hana-max-thinking", tool: "hana-max-thinking_thinking_status" }` 调用（解析器检测到桥接帧时自动切换目录命名空间 capability）。
- **任何版本通用的兜底**：直接 read `${HANA_HOME}/plugin-data/hana-max-thinking/enforce.log`（JSONL），运行时真实等级以它为准。SKILL.md 已向 agent 注入这套"直调 → 旧版 mcp_call → 日志兜底"的三段式约定。

## v0.1.9 修复

- **关键回归修复**：v0.1.8 闭包重构时遗漏了 `this._ctx = ctx` 镜像赋值，导致生命周期所有总线操作（元数据 sweep、session_created 即时应用、降级纠正）报 `Cannot read properties of undefined (reading 'bus')`。已恢复赋值并对未激活场景加了防御日志。
- **stale ctx 兜底**：热重载时忙碌会话跳过扩展重绑（宿主设计），该会话的每轮强制跳过属预期——由恢复后的生命周期 sweep（每 10 分钟全量 + session_created + 降级事件即时纠正）继续兜底，重启 Hana 不是必需的。

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
