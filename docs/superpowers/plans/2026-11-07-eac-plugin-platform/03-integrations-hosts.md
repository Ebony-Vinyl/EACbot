# M7–M10：业务插件与桌面宿主 Implementation Plan

## Context

依赖已验证的插件安装、权限、平台 Bot、共享记忆、任务与媒体合同。所有模块可独立安装/禁用，核心只依赖合同，不依赖具体社区插件。

**Goal:** 交付真实可用且深入联动的 QQ、B站、Muse、国内平台及设备能力，并以 Tauri 支持本地运行。

**Architecture:** 复用上游适当实现，外部框架经薄桥接；平台 Bot 复用同一运行时；服务器控制和客户端设备分离。

**Tech Stack:** EAC TypeScript/React、Muse .NET 复用、可选 Pipecat/外部 Bot 服务、Tauri/Rust 宿主。

以下扩展仓库路径属于未来独立仓库，当前主仓库不创建同名实现副本。每个插件都附 manifest、LICENSE/NOTICE、配置 schema、合同测试、截图与迁移说明。

## Task 1：QQ 与可选 Bot 框架

**Files**
- External create: `plugins/eac/qq/` 的 official、onebot 和 framework bridge 适配及测试。
- Reuse: 已有账户/入站路由/工具注册合同、现有 Bot API/Webhook/MCP 可用接口。

- [ ] fake OneBot 服务模拟私聊/群聊、重复事件、回声、断线、鉴权失败和发送结果不明。
- [ ] SnowLuma 接口/许可固定 revision；官方 QQ 与个人号桥接分开标示，不承诺相同能力。
- [ ] MaiBot/AstrBot 定义外部主处理模式，与 EAC 主处理互斥，记录实际支持的取消/身份/回执能力。
- [ ] 验证群成员、主人、允许名单、账户 A/B 与本地设备控制范围。
- [ ] 独立 QQ Bot、看板、TTS/桌宠及 fake Muse 点歌串联，之后补真实 Muse 验收。

用 QQ-01…03 验收，真实消息仅发到获授权测试对象，不在生产群验证。

## Task 2：B站研究与受控操作

**Files**
- External create: `plugins/eac/bilibili/` 阅读/账号/报告/看板/工具及 fake 服务测试。

- [ ] 固定两份 DSH 参考源码与依赖状态，复用允许的字幕/报告/安全语义，不依赖未核实的停更接口。
- [ ] fake 覆盖完整字幕、缺字幕、分P、抽样帧、限频、登录过期与受限内容。
- [ ] 结果引用作者/链接/时间点和未覆盖范围；摘要写入任务产物，兴趣只写授权空间。
- [ ] 写操作按接口可用性逐项门控，测试配额、重复检查、回读与结果不明暂停。
- [ ] 边栏独立 B站 Bot 可和 QQ Bot 共享指定偏好，而不共享账户授权。

用 BILI-01/02 与 MEM-01 验收；无法使用的上游接口标记 unavailable，不写假实现。

## Task 3：EAC Muse 专项

**Files**
- External create: `plugins/eac/muse/` 的上游复用实现、薄服务桥、EAC 面板、工具、事件、测试与署名。
- Reuse: 音频焦点、设备、记忆、任务、Bot 工具和权限合同。

- [ ] 在 SDK/媒体合同通过后派专门实现智能体，任务明确“直接改造 KugouMusic.NET”，不引入其他后端。
- [ ] 固定上游 revision 与实际许可证，保留 .NET 音乐实现；隔离包构建与主应用安装，不执行不受控用户端 restore。
- [ ] 真实支持登录/搜索/歌单/歌词/队列/播放的路径逐项映射；服务器和客户端播放职责分开，原生/browser 播放分别验证。
- [ ] 对话“这首/刚才那首”使用 snapshot revision 与稳定 ID；偏好临时/长期区分，群成员不改主人偏好。
- [ ] 专注两小时/每天放松等任务复用调度，目标设备/勿扰/TTL/取消有约束。
- [ ] 实现焦点 lease 和条件恢复，手动暂停/切歌优先；桌宠和 QQ 使用同一真实播放状态。
- [ ] 未登录/VIP/下架/无手势/离线/结果不明有可恢复状态，不伪报成功或绕过付费。
- [ ] 派独立验收智能体跑 MUSE-01…06，失败回实现者修复；包含实际音频而非只有 JSON 回执。

不把任意语言“抄过来”当作免测试；复用越多越需要明确源码/依赖/运行环境和协议边界。

## Task 4：国内运营连接器

**Files**
- External create: `plugins/eac/xianyu/`、`douyin/`、`xiaohongshu/`、`tieba/`，每个平台独立包与看板。

- [ ] 每个平台建立读取/草稿/回复/发布/改价/交易/指标的能力清单，记录公开接口或授权接入依据。
- [ ] 优先验证闲鱼可用消息→知识库草稿→授权回复；发布和交易单独 gate，不从爬虫功能推断。
- [ ] 抖音/小红书先内容研究与草稿/计划，发布按实际支持开放；贴吧先阅读/摘要/回复草稿。
- [ ] 每个平台 mock 覆盖登录过期、验证码暂停、重复事件、限频、外发不明、取消和账户串用。
- [ ] 类别/tag、独立 Bot 和看板通过贡献点自动出现，不为每个平台修改主导航。
- [ ] 逐包验收 SOCIAL-01…03；许可证/接口阻断只影响该能力，发行说明不把它列为已完成。

## Task 5：健康、家居与设备协议

**Files**
- External create: `plugins/eac/health/`、`plugins/eac/home-assistant/`。
- Create: `shared/plugins/devices.ts`、设备模拟器与合同测试；复用既有配对/设备连接机制。

- [ ] 健康支持手工/文件导入、数据校验、趋势、提醒、导出删除，不提供自动诊疗。
- [ ] 逐数据类型和模型出口授权；群聊/共享记忆不能读取默认私有健康数据。
- [ ] HA 先只读实体状态，再授权普通控制；门锁/安防按敏感操作独立确认。
- [ ] 设备模拟器测试配对/重连/撤销、能力不匹配、TTL 过期和重复命令回执。
- [ ] 写明 Health Connect/HealthKit/手表连接需要后续手机客户端，当前不交付原生移动 App。

完成 HEALTH-01/02、HOME-01、DEVICE-01。

## Task 6：HostAdapter 与 Tauri

**Files**
- Create: `src/lib/host-adapter.ts`、`hosts/tauri/`、跨宿主合同测试。
- Modify: `src/types/ogb.d.ts` 的兼容适配、现有宿主能力调用点；保留 Electron bridge 合同和原测试。
- Reuse: `electron/server-child-launch.mjs`、`electron/server-supervisor.mjs` 的行为要求，不直接假定 Rust 可复用 Node 模块。

- [ ] 为 Web/Electron 先建立同一能力接口和测试，确保现有功能不变。
- [ ] Tauri 托管同一 Node 服务，测试就绪、端口冲突、崩溃恢复、退出清理和单实例。
- [ ] Windows 验证托盘、透明置顶桌宠、音频/麦克风、系统凭据和签名更新；未实现能力明确 unsupported。
- [ ] 远端模式本地设备按配对授权，不能把 Node 服务权限和桌面壳权限混为一谈。
- [ ] Linux/macOS 分别记录真实安装/运行证据；没测则不标通过。
- [ ] HOST-01…03 与完整旧功能回归通过后才决定默认切换，不先删 Electron。

## 阶段收尾

每包完成独立安装/禁用/升级/卸载及 Bot 联动；将 fake 验证、真实服务验证、未验证三栏列出。生产发布依[发布计划](04-release.md)另行执行，不因模块完成自动部署。
