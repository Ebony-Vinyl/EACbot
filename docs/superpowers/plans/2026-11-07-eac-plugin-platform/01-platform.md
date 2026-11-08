# M1–M3：合同、宿主与市场 Implementation Plan

## Context

先证明用户可从独立渠道安装真正有用的插件，而不是先写大量空接口。依照[总路线](README.md)执行；以下“新增”文件和命令属于后续代码阶段，当前尚未存在或运行。

**Goal:** 完成安装、授权、调用、禁用、卸载和更新恢复闭环。

**Architecture:** Schema → 注册/生命周期 → 权限代理与真实隔离 → 纵向样例 → 市场/发行。沿用已有 RouteHandler、MCP gate、原子写入和 app-frame。

**Tech Stack:** TypeScript、现有 schema 库与 Vitest、Node 子进程/平台隔离、React。

## Task 1：合同与测试夹具

**Files**
- Create: `shared/plugins/manifest.ts`、`shared/plugins/rpc.ts`、`shared/plugins/events.ts`、`shared/plugins/catalog.ts`。
- Create: `shared/plugins/manifest.test.ts`、`shared/plugins/catalog.test.ts`。
- Create: `packages/plugin-sdk/`、`packages/plugin-testkit/`，包管理接入先核对当前 workspace 配置。
- Reuse: `server/atomic.ts`、`shared/tool-scope.ts`、现有 zod/schema idiom。

- [ ] 将 manifest 文档示例转为合法/非法固定 fixture，先测试重复 key、非法版本、路径逃逸、未知权限、依赖环和 ID 冲突。
- [ ] 编写解析器和版本协商；不能只 TypeScript 类型检查而缺运行时校验。
- [ ] 定义请求/结果/取消/事件 codec，验证未知字段、超过 1 MiB、错误 requestId、乱序和取消后旧帧。
- [ ] testkit 提供可控制时钟、注册、授权、事件、存储、模型与设备；所有测试不依赖真实账户。
- [ ] 固定 schemaVersion/apiVersion/service version/stateVersion 的独立测试；导出 JSON Schema 给扩展仓库 CI。

实现后命令：`pnpm exec vitest run shared/plugins/manifest.test.ts shared/plugins/catalog.test.ts`。预期从解析器缺失或校验不完整的失败转为所有用例通过；不能仅新增空测试文件。

## Task 2：注册与生命周期

**Files**
- Create: `server/plugins/registry.ts`、`lifecycle.ts`、`storage.ts`、`dependencies.ts` 及同名测试。
- Create: `server/host/plugins-host.ts`、`server/routes/plugins.ts`。
- Modify: `server/request-auth.ts`、`server/routes/table.ts`，必要时 `server/index.ts` 仅一处组合注册。

- [ ] 使用临时 DATA_DIR 测试 installed-disabled 的持久化、重启恢复、损坏记录和并发更新 CAS。
- [ ] 建服务依赖图，测试缺强依赖 blocked、缺可选依赖降级、重复服务拒绝、卸载依赖提示。
- [ ] 实现 starting/active/stopping 等状态与 disposer 逆序清理；注入第二步激活失败证明第一步被撤销。
- [ ] 健康探测/崩溃退避、熔断和所属进程树终止；测试插件崩溃时另一插件和 Bot 心跳仍正常。
- [ ] 生命周期 API 走统一 auth，非管理员不能安装/更改来源；公开状态投影不返回秘密。

测试需观察无重复注册、无残留定时器/子进程、停用后旧请求拒绝。通过 PLAT-01/02/04 后再接真实进程。

## Task 3：权限、broker 与隔离

**Files**
- Create: `server/plugins/authorization.ts`、`broker.ts`、`tokens.ts`、`isolation.ts`、`egress.ts` 及对应测试。
- Modify: `server/mcp-gate.ts`、`server/drivers/turn-mcp.ts`；复用 `server/outbound-hold.ts` 与 `server/decision-log.ts`。

- [ ] 用账户 A/B、Bot A/B、owner/guest、群/私聊组成权限矩阵，先验证未授权和交叉身份拒绝。
- [ ] grant 绑定批准参数摘要、目标、期限和 epoch；测试批准后改参数、撤销后队列派发、重复消费 allow-once。
- [ ] broker 提供网络/存储/模型受控调用及 secret refs；记录 allow/deny，不记录正文和密钥。
- [ ] 实现 Linux 可用隔离后端及能力探测；Windows/macOS 返回真实级别。必须用恶意测试进程尝试越界，而非仅断言传入了某个 flag。
- [ ] 验证 required isolation 不可用时拒绝，可信本地模式需另行确认且 UI 正确标识。
- [ ] 外发结果不明返回 indeterminate，测试网络断在派发前、派发后、回执前的不同重试行为。

完成 PLAT-03/05/06。任何跨账号泄漏、明文秘密、越界或 silent fallback 都是阻断缺陷。

## Task 4：最小真实闭环

**Files**
- Create: `plugins/builtin/` 中一个现有能力适配；`packages/plugin-testkit/fixtures/` 内主题、PanelSpec、无外发示例工具包。
- Create: `src/features/extensions/InstalledPlugins.tsx`、对应测试。
- Reuse: `src/components/app/app-frame-host.ts`、`shared/app-frame/`。

- [ ] 使用临时签名测试源安装示例包，状态先 disabled；用户授权后 Bot 才看到工具。
- [ ] 工具返回可观察结果，面板读取同一结果，主题可应用；不在核心增加 fixture 专用分支。
- [ ] 重启恢复安装/配置，卸载清贡献，Bot 仍能聊天；卸载当前主题回退内置。
- [ ] 选择一个现有适配器迁入注册表，回归其旧配置和调用，不进行整个驱动目录搬迁。
- [ ] 使用隔离 control:omb fixture 运行用户路径，保存调用与状态结果。

完成 PLAT-07/08/09/10 后，才认为插件平台具有可用基础。

## Task 5：渠道、制品与事务更新

**Files**
- Create: `server/plugins/sources.ts`、`signatures.ts`、`downloads.ts`、`installer.ts`、`updates.ts` 及对应测试。
- Create: `server/testing/fake-plugin-channel.ts`。
- Reuse: 有界下载/摘要模式与 `writeFileAtomic`；不一次替换所有旧社区库。

- [ ] 用固定测试密钥生成已知签名 fixture，测试验签、错 key、摘要篡改、过期、旧 sequence 和同 ID 跨源覆盖。
- [ ] 恶意归档测试绝对路径、traversal、symlink/junction、过大展开；不执行包内脚本。
- [ ] 模拟下载取消、磁盘满、断电/进程退出在各事务阶段，重启后只存在一个 active 版本。
- [ ] 更新先停旧实例，数据工作副本迁移，新版探测失败恢复对应代码和数据；不可逆升级拒绝自动回滚。
- [ ] 新增权限/换源/换 key 触发重新确认；撤回后禁用调用和启动，保留用户数据。

完成 REL-03/04/05/06，测试用源只监听 loopback，不接真实市场。

## Task 6：扩展中心与社区发行模板

**Files**
- Create: `src/features/extensions/` 的 Market、Details、Sources、InstallFlow 组件和测试。
- Modify: `src/components/PluginsPanel.tsx`、`src/lib/app-catalog.ts`、相关 state/API 与 locales。
- Later external repository: `eacbot-extensions` 的模板、CI、CODEOWNERS、catalog；创建/公开前确认。

- [ ] 保留旧 Connected apps/MCP 入口，新市场区分安装与账户连接。
- [ ] 实现发现/已安装/更新/渠道管理及真实进度、空/错/离线状态；同源缓存不盖住错误。
- [ ] 权限、来源、隔离级别、许可证和支持平台在安装前可见；窄屏与键盘流程可完成。
- [ ] 生成开发模板与实际 SDK 使用步骤，验证陌生开发者从干净 fixture 能复现。
- [ ] CI 分离无秘密 PR 检查与受保护签名发布，完成 REL-01/02；不在验证阶段公开推送。

## 收尾门槛

运行相关测试、typecheck/lint/i18n/contrast、既有路由和文件体积棘轮、完整 test/build；新增验证 recipe 仅引用实际已有文件和命令。记录 UI 截图/录屏和未验证平台。此阶段不允许借“架构先行”留下不可卸载或只注册不使用的演示系统。
