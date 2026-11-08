# EAC 插件开发规范

状态：设计 v1。Manifest、生命周期、权限、管理 API、本地安装、opt-in supervisor、授权后的 `tools/call`、签名渠道、有界下载/解包、安装/更新/回滚、扩展中心 UI、默认社区渠道与独立扩展仓库已落地；平台账户/独立平台 Bot 数据模型、共享记忆空间 ACL、OFM 配置、音频焦点、Kanban 与设备配对合同也已有实现。尚未实现：把插件工具自动挂载到 Bot 的 MCP 列表、平台入站事件→Bot turn、真实 OS 沙箱、可安装 SDK/testkit 包，以及 Muse/B站/国内平台/健康/HA 业务插件。本文定义后续实现合同，不是当前版本的功能清单。日期：2026-11-08。

## 阅读顺序

1. [总体架构](../superpowers/specs/2026-11-07-eac-plugin-platform-design.md)：宿主、插件、账户、Bot 和共享记忆边界。
2. [Manifest v1](manifest-v1.md)：可贡献的能力、包入口、版本与依赖。
3. [SDK 与运行协议](sdk.md)：调用、生命周期、事件和取消。
4. [权限](permissions.md)：唯一的授权决策规范。
5. [渠道](channels.md)：发现、信任、下载、更新与撤回。
6. [开发发布](publishing.md)：社区开发到签名制品的流程。
7. [安全审核](security-review.md)：PR 与发行门槛。
8. [兼容性](compatibility.md)：迁移、回滚和宿主能力。

[产品设计](../superpowers/specs/2026-11-07-eac-product-experience.md)规定扩展市场和平台看板；[业务集成](../superpowers/specs/2026-11-07-eac-integrations-design.md)规定 Muse、语音、QQ、B站等模块；[实施计划](../superpowers/plans/2026-11-07-eac-plugin-platform/README.md)规定交付顺序。

## 首个插件必须证明什么

不是“可以 import 一个包”，而是通过用户可见的流程完成：发现 → 查看来源/权限 → 安装 → 配置 → 授权给 Bot → 调用并获取真实结果 → 重启恢复 → 禁用/卸载。

主题与面板也走安装生命周期，但不为纯数据主题启动后端进程。连接账户不是安装插件；安装后默认禁用，权限和账号配置完成后才允许激活。

## 已实现的本地开发入口

`POST /api/plugins/local` 接受 `{ "path": "<absolute package directory>" }`，读取并校验 `eac-plugin.json` 和 manifest 声明的入口文件，安装后保持 `installed-disabled`。仅 owner/admin 可调用；路径必须绝对、manifest 与声明入口必须是包内普通文件，不能是链接。

进程插件还需要服务进程设置 `EAC_PLUGIN_PROCESS=1`，且 manifest 使用 `runtime.isolation: "none"` 或 `"preferred"`；supervisor 会收紧环境并在握手失败时清理进程，摘要里的 `runtime.enforced` 会显示它并未获得 OS 沙箱。`isolation: "required"` 在没有真实 OS 沙箱时仍然拒绝。本地安装不复制代码，也不是已审核市场渠道。

## 核心术语

| 名称 | 含义 |
| --- | --- |
| `pluginId` | 插件稳定身份，如 `eac.muse` |
| `installationId` | 工作区中的安装实例，绑定来源和版本 |
| `workspaceId` | 数据与权限隔离范围 |
| `accountId` | 平台授权连接，绝不是凭据本身 |
| `botId` | 现有 Bot 的身份 |
| `memorySpaceId` | 用户选择共享的记忆空间 |
| `taskId` / `requestId` / `traceId` | 任务、单次调用与跨模块因果链 |
| `deviceId` | 配对设备/播放目标 |
| 渠道 | 分发索引来源，不是 QQ 会话或模型供应商 |

## 最低约束

- 不直接 import 其他插件内部实现，不读其数据库，不在宿主组合根加入平台分支。
- 不把密钥、账号 Cookie、私人数据提交到扩展仓库、截图、测试或日志。
- 不将“可信来源”“签名有效”“权限已批准”混称为绝对安全。
- 子进程不等于安全沙箱；安装 UI 必须说明真实隔离级别。
- 第三方消息和网页内容始终是数据，不是主人授权。
- 真实外发、音频播放、账号修改等结果只有核实后才标记成功。
- 插件停止后撤销工具、事件订阅、授权令牌及定时任务入口，不能留下后台幽灵行为。

## 验收与发布

[平台验收](../verification/plugin-platform.md)、[业务联动验收](../verification/plugin-integrations.md)和[发布验收](../verification/plugin-release.md)列出必须提供的证据。规范中的新类型、API 和工具名尚未实现；实现时必须将示例转为 schema、合同测试和隔离测试，不允许只实现文档中的快乐路径。
