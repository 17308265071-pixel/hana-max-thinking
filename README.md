# Max Thinking (hana-max-thinking)

> 强制 HanaAgent 会话与频道中的**所有模型**默认运行在它支持的最高思考等级——修复 GLM 5.3 Flash 等模型在频道里"不说话"的痛点。

**作者：2990927961** · 版本：v0.1.6 · HanaAgent >= 0.158.0

## 解决什么痛点

GLM 5.3 Flash / DeepSeek V4 Flash 等模型的回答质量与**思考链（thinking）强相关**：

- **频道/群聊里 agent 失语**：GLM 系列思考是开/关制，思考等级被 agent 级配置或频道执行器硬编码的 medium 创建后，模型可能因思考不足输出空回复、卡在"正在准备回复"。本插件在请求管线内每轮强制最高思考，频道立刻恢复活跃。
- **界面档位不能固定最高档**：思考选择器自动落实被强制的档位，点击低档位约 2 秒弹回。
- **手动改档不持久 / Hana 更新冲掉手工 JSON 修改**：干预点在请求管线与会话元数据，不解析任何 Hana 配置 JSON，更新安全。

## 功能

- 覆盖桌面会话 / 频道 / DM / Bridge，旧频道自动扫描补齐
- 按模型自适应（Max → 模型最高档 → 非推理模型无害保持）
- 前端思考档位选择器立即落实强制结果
- Agent 工具 thinking_status 查询真实运行时等级
- 文件日志 enforce.log（plugin-data 下）
- 零依赖，跨平台（Windows / macOS / Linux）

## 安装

1. 下载 [Releases 页面](https://github.com/17308265071-pixel/hana-max-thinking/releases)（选择最新版本，下载 hana-max-thinking.zip）
2. Hana 设置 → 插件 → 拖入 zip 安装（或解压到 ~/.hanako/plugins/ 后重启）
3. 打开 Max Thinking 的全权（full-access）开关

详细说明见 [hana-max-thinking/README.md](./hana-max-thinking/README.md)。