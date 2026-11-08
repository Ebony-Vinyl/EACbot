# EACbot Plugin Platform Implementation Plan

## Context

本轮先交付文档，不改运行代码、不建立公开仓库、不连接生产账户或部署。用户要求的插件架构、Muse 深度联动、独立平台 Bot 与共享记忆已纳入设计。本文是后续实施的有序工作清单，不是完成报告。

**Goal:** 在保持现有 Bot 可用的前提下，建立可安装、可授权、可卸载的插件生态，并让业务插件与同一 Bot 运行时深度协作。

**Architecture:** 稳定宿主负责安全与生命周期，一方功能渐进适配；社区模块经能力代理、事件和沙箱 UI 接入。平台安装、账户连接、Bot 与记忆空间分别建模。先完成真实安装调用闭环，再扩展业务。

**Tech Stack:** 保留 TypeScript/Node 24、React/Vite、现有 SQLite/文件存储与测试体系；Tauri 为目标桌面宿主，Muse 保留可复用 .NET 实现，Pipecat 作为可选语音进程。

当前文档由主执行者编写。后续 Muse 的功能开发按用户要求由专门实现与独立验收智能体分工；不因此默认把其他任务全部委派。未经用户要求，不提交/push 或公开发行。

## 导航

- [总体架构](../../specs/2026-11-07-eac-plugin-platform-design.md)
- [产品体验](../../specs/2026-11-07-eac-product-experience.md)
- [业务集成](../../specs/2026-11-07-eac-integrations-design.md)
- [需求追踪](requirements.md)
- [M1–M3 合同、宿主与市场](01-platform.md)
- [M4–M6 记忆、UI、任务与模型媒体](02-experience-runtime.md)
- [M7–M10 平台、Muse、设备与宿主](03-integrations-hosts.md)
- [发布与恢复](04-release.md)
- [插件开发规范](../../../plugins/README.md)
- [验收入口](../../../verification/plugin-platform.md)

## 里程碑

| 阶段 | 交付 | 前置 | 验收门槛 |
| --- | --- | --- | --- |
| M0 | 架构、规范、子计划、需求映射、验收设计 | 已完成需求澄清 | 文档链接/保密/一致性检查，明确未实现状态 |
| M1 | Schema、SDK、testkit、注册与授权/隔离（Manifest、存储、生命周期、权限求交、API、进程 supervisor 与 `tools/call` 已落地；testkit 发布物未做） | M0 | PLAT-01/02/03/04/05/06 |
| M2 | 最小垂直闭环：主题、面板、工具安装与调用（工具可由授权 API 调用；尚未自动挂载到 Bot 的 MCP 工具列表） | M1 | PLAT-07/08/09；Bot 回归 |
| M3 | 扩展中心、渠道、升级回滚、发布模板（核心与外部仓库/默认签名渠道已上线） | M2 | REL-01/02/03/04/05/06 |
| M4 | 独立平台 Bot 合同、共享记忆、UI 插槽/面板（账户/身份/路由、记忆空间 ACL 与侧边栏标识已落地；UI 插槽/主题/布局与平台事件→Bot turn 未做） | M1/M2 | BOT-01/02/03/04、MEM-01/02/03/04、UI-01/02/03 |
| M5 | OFM/自定义模型、流式语音、音频焦点与桌宠（OFM 配置/目录、模态校验、音频焦点与序列合同已落地；真实流式 TTS 与桌宠联动未做） | M1/M2 | MODEL-01/02/03、VOICE-01/02/03、MEDIA-01 |
| M6 | Kanban、计划整合、统一用量（任务/运行/租约与用量聚合合同已落地；Kanban UI、调度器接入与现有账本联动未做） | M4/M5 的稳定合同 | TASK-01/02/03、USAGE-01/02 |
| M7 | QQ 可选桥接、B站与独立看板（QQ OneBot 工具适配器与 fake 测试已提交扩展仓库；宿主事件通路、SnowLuma/MaiBot/AstrBot 桥接与 B站未做） | M3/M4/M5 | QQ-01/02/03、BILI-01/02 |
| M8 | Muse 专项与国内平台逐个插件（未开始；能力矩阵已如实列出） | M3/M4/M5，QQ 联动依赖 M7 | MUSE-01…06、SOCIAL-01/02/03 |
| M9 | 健康/HA 插件、设备协议与模拟器（设备配对/能力/TTL/幂等回执与模拟器测试已落地；健康与 HA 插件未做） | M4/M6 | HEALTH-01/02、HOME-01、DEVICE-01 |
| M10 | Tauri、整体验收、预发布与恢复（HostAdapter 合同与测试已落地；Tauri 工程、整体验收与预发布未做） | 宿主合同先行，发行需前阶段通过 | HOST-01/02/03、REL-07/08/09 |

M4/M5 可在合同稳定后并行；Muse 可在 M5 后提前开发，用 fake QQ 验证桥接，再在 M7 后验收真实组合。国内平台某接口未开放不应阻塞独立可用的其他插件，但必须明确缺失能力，不能把整批标记完成。

## 实施纪律

每个任务采用：新增失败测试 → 确认正确失败原因 → 最小实现 → 相关测试 → 隔离端到端 → 文档/证据。子计划列出具体文件、测试输入和观察值；实施时把尚未存在的文件转为真实路径和可执行脚本。文档内的合同示例不是整套生产实现，不提前假造所有适配器代码。

新文件原则上保持小而专一，遵守现有文件体积和路由棘轮；`server/index.ts` 只允许必要组合装配。测试失败先定位原因，不能删除断言或关闭守护规则。

实现第一批代码前再次检查 git 状态，不覆盖用户变更。开发分支与提交由用户选择的版本控制流程决定；当前文档不执行 commit/push。

## 基线与工具

已存在命令：

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm check:contrast
pnpm test
pnpm build
```

`pnpm test` 包含 Vitest 及额外 broker、Electron、打包服务测试；不能以单次 Vitest 代替全链通过。UI/桌面另做实际操作和截图/录屏。

服务/会话变化使用：

```sh
node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb doctor --url http://127.0.0.1:PORT
```

PORT 必须换为隔离启动器打印值，不能默认为用户 live app。假服务在独立临时目录，测试只影响自身资源。新命令只有在实现且加入帮助/测试之后才能写成可执行 recipe。

## 决策门槛而非空白待办

| 条件 | 若满足 | 若不满足 |
| --- | --- | --- |
| 宿主支持所需 OS 隔离 | 开放受限进程模式 | 拒绝该安全模式，单独显示显式可信模式及限制 |
| OFM 实际端点支持音视频 | 启用对应模态并记录合同/实测 | 标 unavailable，文本/视觉路径不受影响 |
| 酷狗适用许可与目标平台可验证 | 直接复用发行 | 保留未发布开发结果，阻止不明许可制品进入默认源 |
| 国内平台写接口及授权已核实 | 按分级授权开放 | 提供草稿/人工交接，不假称自动发布 |
| Tauri 目标能力矩阵通过 | 可成为推荐宿主 | 保留 Electron，不先移除旧能力 |

每个门槛有明确失败行为，不用空实现/假数据绕过。

## 报告格式

每个阶段记录 revision、环境、变更文件、用例 ID、命令、结果、日志与 UI 证据、未验证项、已知缺陷、恢复方法。状态仅使用未实施/阻断/通过/失败/跳过（注明原因），不将“计划支持”写成“已支持”。

发布必须无未解决阻断缺陷，并满足目标平台关键路径；“没有任何问题”不能作为不可证实承诺。当前文档完成后，下一步是 M1 的合同/testkit，不立即同时编码所有模块。

## 当前实现状态（2026-11-07）

已落地：
- `shared/plugins/manifest.ts`、`semver.ts`、`lifecycle.ts`、`permissions.ts`、`rpc.ts`、`events.ts`：运行时校验、版本范围、状态机、授权求交、调用/结果与事件线格式。
- `server/plugins/store.ts`、`registry.ts`、`manifest-digest.ts`：原子安装记录、依赖/冲突检查、异步生命周期、按安装串行化、启用/停用/撤销/删除。
- `server/plugins/local-install.ts`：本地包 manifest/入口校验与禁用安装；`POST /api/plugins/local` 仅 owner/admin。
- `server/plugins/supervisor.ts`：opt-in stdio JSON-RPC supervisor、环境收缩、握手超时、停止/强制终止、崩溃状态收敛；`isolation: required` 仍拒绝。
- `shared/plugins/catalog.ts`、`server/plugins/catalog.ts`、`catalog-source.ts`：Ed25519 签名目录、过期/回放/信任升级/撤回校验、HTTPS 有界拉取。
- `server/plugins/channel-store.ts`、`artifact.ts`、`market.ts`：渠道持久化、摘要校验、tar.gz 安全解包、安装/更新/回滚和撤回拦截。
- [ExtensionsCatalog.tsx](../../../src/components/ExtensionsCatalog.tsx)：扩展中心 UI，含渠道管理、目录、安装、更新、回滚和本地包入口。
- `server/routes/plugins.ts`、`server/host/plugins-host.ts`：owner/admin 管理 API；`server/index.ts` 只挂一个组合入口。
- `shared/plugins/*.test.ts`、`server/plugins/*.test.ts`、`server/routes/plugins*.test.ts`：15 个测试文件、84 个测试通过。
- 外部基础设施：公开仓库 `Ebony-Vinyl/eacbot-extensions`、默认渠道 `eac-community`、Ed25519 公钥/私钥分离、Actions 验证与签名发布工作流；已发布 signed catalog sequence 2，工作流成功。

进程插件需在服务环境设置 `EAC_PLUGIN_PROCESS=1`；supervisor 是故障隔离，不是 OS 沙箱。明确未落地：真实 OS 隔离、SDK 发布物、testkit、插件工具桥接到 Bot、平台 Bot/共享记忆，以及 QQ/B站/Muse 等业务插件。扩展中心和市场基础设施已可用，但社区插件生态仍需要实际插件与审核积累。

## M0 文档交付检查记录

2026-11-07，由主执行者亲自编写并检查。新增 21 份文档，修改 DEV 与验证入口两份文档；运行代码、依赖、生产服务和 `.zcode/` 未修改。

| 检查 | 结果 |
| --- | --- |
| 23 份交付相关文档、221 个相对链接、JSON 示例与代码围栏 | 静态检查通过；保留已有文件换行格式 |
| 31 项需求、63 个验收 ID | 唯一性与引用存在性检查通过；业务用例本身尚未实施 |
| 整个验证目录 129 份文档、374 个链接、1,562 处源码引用 | 静态检查通过 |
| 现有文档引用测试的 7 组断言 | 用 Node 内置模块与断言适配执行通过，包含命令、源文件、测试文件、路由、目录入口和锚点；不是正式 Vitest 运行 |
| `git diff --check` 与新增文档空白检查 | 通过；Git 对 DEV 提示 LF/CRLF 自动转换，不是错误 |
| 文档内秘密/部署信息模式扫描及人工核对 | 未发现写入生产连接信息、凭据或真实用户数据 |
| `pnpm exec vitest run scripts/testing/verification-docs.test.ts` | 未能运行：本地缺少 Vitest，报 Command "vitest" not found；未为文档任务安装整套依赖 |
| 全量 typecheck/lint/test/build、业务 fixture、真实账号/音频、部署 | 未运行；本次只交付文档，不作运行功能通过声明 |

Node 静态断言适配仅在内存中读取现有测试和 HELP 文本，未修改测试文件或导入服务运行入口。实施阶段仍必须安装受锁文件约束的依赖并跑正式测试链，不能拿本记录替代。
