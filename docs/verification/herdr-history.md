# Herdr 原生 CLI 与对话记录

本次改动影响范围是 Herdr 会话管理、终端元数据读取、原生会话记录与前端提示模块。

## 设计与决定

按用户确认的 Alma 工作方式实现，依据 https://alma.now/docs/zh/features/herdr ：
Herdr 托管本机 CLI，图形界面读取其原生记录，消息发送到同一个终端。

- 新会话仅执行本机 Agent 可执行文件，不增加 `app-server`、`--remote`、`thread/start` 或 `turn/start`。
- 输入使用已有 `TerminalService.send` / `terminal.send`，停止使用原生 interrupt。
- Codex 对话记录通过所属终端 PID 及子进程的打开文件匹配。禁止按“目录相同”或“最新文件”猜会话；多候选明确报错。
- 文件读取校验真实路径位于 Codex home 内，session_meta ID 匹配，仅解析完整 JSONL 行；注入的项目说明不冒充用户消息。
- 新建后先展示原生终端；登录、目录信任、模型提示、审批由用户在终端完成。未实现结构化审批按钮。
- Claude 等其他已发现工具继续提供原生终端；本轮结构化对话读取范围为 Codex。
- 沿用本机登录配置、现有 device 授权；不改用户 Codex 数据、不向实际会话发送验收消息。
- 原 RPC 记录保留，不静默迁移、替换或重启。旧实现备份在相邻 EACbot-backups/20261116-before-native-herdr/herdr-rpc.tar.gz。
- 当前主要面向本机 macOS；进程文件定位依赖 ps/lsof。Windows 的对话记录定位未实现，不能宣称跨平台对话验收通过。

## 已完成验证

- core/bootstrap/herdr.test.ts 与 herdr-history.test.ts：5 项通过，覆盖原生启动、输入转发、重载不重启、旧记录保留、授权边界及 JSONL 解析。
- HerdrPage.test.ts 与 TerminalSurface.test.ts：11 项通过。
- core 与前端类型检查通过；相关源码 oxlint、git diff --check 通过。

## 原生完整链路验收

`node --experimental-strip-types scripts/verify-herdr-history.mjs` 已通过。使用本机真实 Codex 0.169.0-alpha.11.1 与 Herdr、临时 HOME/CODEX_HOME/HC_SOCKET，模型请求只发向回环伪服务。

- 原生 TUI 启动并输出终端画面。
- 两轮用户消息通过 Herdr 发送，两个回复由 CLI 接收并写入原生记录。
- 精确读回两条用户消息与两条助手回复；重新创建应用会话管理对象后原绑定、历史仍在。
- 原生 `item_completed / UserMessage` 记录已覆盖；环境说明不会被渲染成用户消息。
- Codex 会发起额外后台模型请求，断言针对对话记录中的两轮，而非假定总 HTTP 请求数恰好为二。本次回环服务收到四次请求。
- fixture 只在自己的临时配置中使用 gpt-6-sol，避免旧模型升级提示抢占输入；没有修改用户模型设置。
- fixture 清理专属终端、Herdr 服务和临时目录。

## 桌面加载

已备份用户的 Herdr 会话与终端映射到相邻 EACbot-backups/20261116-native-herdr-activation，重载 EACbot 自己托管的 core 子进程。
通过桌面 UI 在原 Downloads 项目新建 `Downloads · codex`，实际画面显示原生 Codex 启动页，旧 `1` 会话保留。没有向真实模型发送测试消息。

本轮共 16 项定向测试通过，core/前端类型检查、相关源码 lint 与 diff 检查通过。真实账号模型生成没有单独测试；隔离两轮收发已完成。

## 已有回复但对话页为空

空闲终端未持有 rollout 文件时，单靠 lsof 无法定位历史。现优先读取该终端
`alma.session` 标签中的精确 `codex:id:<UUID>`，仅在配置 home 的 sessions 目录
匹配同一 UUID 的文件，并校验文件内 session_meta ID；无标签时保留进程树定位。
不会按工作目录或最近修改时间猜测会话。找不到记录的提示不再断言需要登录。

- 隔离测试覆盖空闲无 PID/文件句柄、同目录无关文件、非法标签及文件 ID 不匹配。
- 6 项 core 测试、10 项 TerminalSurface 测试及类型/lint 检查通过。
- 重载应用托管 core 后，实际桌面对话页显示用户现有的一条消息和一条回复；
  未重启其 Codex、未新建会话、未发送测试消息。
- xterm 设置 minimumContrastRatio=4.5，隔离真实渲染的深灰输入背景与文字
  对比度为 4.595:1；[对比度截图](evidence/herdr-design/terminal-contrast.png)。

## 原生回复中的本地图片

Herdr 消息不属于旧聊天附件库，因此不能直接套用旧聊天的图片 URL。
现在通过认证的 session/message/source-offset 图片接口读取原始回复，复用
messageImageTargetAt 与 openMessageFile：只读取该回复明确嵌入、位于当前项目内的
栅格图片，保留路径、符号链接、私密目录及文件大小限制，不提供任意路径读取接口。
前端复用 MarkdownImagePreview 的图片展示和预览，普通聊天保持原有附件路径。

- core 图片边界和会话测试 4 项通过；Markdown 回归测试 145 项通过。
- core 与前端类型检查、相关源码 lint、diff 检查通过。
- 隔离 Electron 中用合成会话与 PNG 验证真实 HerdrMessageMarkdown，img 完成解码。
- 重载托管 core 后，桌面既有回复中的 JPEG 已显示为图片并出现预览按钮；
  未重发消息、未改动原图、未向真实模型发送验证请求。
