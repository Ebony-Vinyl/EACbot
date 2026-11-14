# A 总结：四份模块审计的合并结论

采集日期：2026-11-14。审计对象：`D:/workspace/EACbot-clean-core`，分支 `codex/clean-core`，基线 `781c57e`。四份报告共 **329 条**：04 云依赖 95 条、05 许可计费 106 条、06 账号准入 75 条、07 配额上限 53 条。全程只读，未修改源码、未运行构建或测试。

## 三段总结

许可边界比表面看起来窄。仓库主体是 Apache-2.0，`enterprise/` 是单独的 source-available carve-out；`LICENSING.md:8-19` 明确允许删掉该目录走 OSS，`server/enterprise.ts:119-150` 在找不到层、没有 key、key 无效或层损坏时都只回落 `oss`，不会让服务崩溃。普通本地聊天、模型接入、工具和大部分配额保护不依赖 license（`server/enterprise.ts:193-195` 的 `entitled()` 只影响显式 gate）；真正的商业边界是 `admin`/hosted workspace、`whitelabel`、`budgets` 和 `billing`（`enterprise/FEATURES:1-6`）。最容易被误判的是预算和计费：`config.json` 可以保存 `budgets.monthlyUsd` 和 `billing.prices`，但没有对应 entitlement 时 `spendState()` 直接返回 null（`server/spend.ts:80-81`），预算静默不生效，售价列也不返回（`server/index.ts:1368`）。这不是代码 bug，但必须在界面和文档里明确显示“未授权、未生效”，否则运营方会以为成本已被限制。

云功能整体是“代码在启动图里、服务默认不连”。没有任何 `EAC_CLOUD_*`/`EAC_CONTROL_*` 时，`cloudHomeConfiguration()` 返回 null（`server/cloud-home.ts:49-51,69-71`），Cloud secrets 返回空对象（`server/cloud-secrets.ts:24-27`），control client 返回 `DISENGAGED` 且不发请求（`server/control-client.ts:60-65,96-103`），fleet 只做 `existsSync`，主服务仍能只绑 `127.0.0.1` 并完成本地回合（`server/index.ts:15506`）。真正的启动硬失败只有三类：静态 import 的文件缺失、Cloud/hosted 变量只配一半或值非法、`EAC_HOSTED_MODELS` 半配置；这些是配置完整性约束，不是“必须买云服务”。会发用户正文的路径也集中在显式功能：模型回合、Cloud Send/Move、Cloud Files、托管模型/试用 relay、Boat 文件与命令；健康报告、power、Team 规则、Connected Apps grant 只发固定代码、计数或签名元数据。Local VM、VPS 和 Fleet 的风险属于本机/运维权限面，不是厂商云后门。

账号不是本地使用的硬门槛，但“浏览器打开 UI”和“本地进程调 API”必须分开看。首次启动不强制建账号或填邮箱；桌面壳和 CLI 的非浏览器回环请求默认是 owner（HEAD 的 `server/request-auth.ts:604-636`），普通浏览器在 HEAD 会得到 401 并进入配对页（`:619`），当前工作树已增加“同源 own-page 才放行”的窄例外。Host/Origin/代理检查、session scope、常量时间比较、过期会话不回退 owner，是安全必需；hosted、邮箱 OTP、配对码属于商业账号层。配额多数是保护性的，真正会自动删除用户可见数据的是 thread 事件日志保留/裁剪和 MCP 大结果只保留 20 个；Starter 的 5 bot/1 线程是商业分层。当前工作树已把图片日上限、线程数、房间速率、MCP server 数、附件库上限等接入 `limits.*`，并把前端 analytics 改为默认关闭，但 `roomPostsPerTurn`、`botsPerWorkspace` 仍是半接线，且这些改动尚未编译或测试。

## 十条最该先处理

1. **先修 hosted 配置的死锁（05 C20、06 C06/C07）。** 只要设置了任意一个 `EAC_ADMIN_*`，`HOSTED_WORKSPACE` 就为真；如果 `enterprise/` 被删或配置不完整，配对和邮箱路由会被前置 403，hosted 登录又 503，浏览器没有可用的本地登录路径（本地 CLI 仍只能走 service 白名单）（`server/index.ts:755,12670-12678`；`server/enterprise.ts:71-87`）。方案 A：启动时校验 `EAC_ADMIN_URL`、`EAC_ADMIN_WORKSPACE`、`EAC_ADMIN_MEMBERSHIP` 和 `EAC_PUBLIC_URL`，不完整就拒绝启动并打印修复项（推荐，fail closed）；方案 B：删 `enterprise/` 前先移除所有 `EAC_ADMIN_*`；方案 C：缺层时回退本地配对（不采用，会绕过已配置的托管登录权威）。

2. **明确本机回环的授权边界（06 L15/L10、11）。** 默认自建、未启用桌面 mutation token 时，任何不带 `Sec-Fetch-*` 的本地进程都直接成为 `admin+client`，包括 bot 的工具 shell；`SERVICE_ALLOW` 还允许 guarded 发送、停止请求和拒绝卡片（`server/request-auth.ts:32-52,604-636`）。方案 A：保持现状，桌面/CLI 最省事，但本机其他 OS 用户和 bot shell 也拥有管理员权限；方案 B：桌面/CLI 保留 owner，浏览器只信任本服务同源页面，bot shell 走 service 或 turn capability（推荐；11 已给出 `provesSameOrigin` 的窄实现，工作树已落地但未测试）；方案 C：所有 `/api` 都要 token，安全但会破坏桌面和 CLI 的免登录体验，适合共享机器或 hosted。不要只删第 619 行的浏览器判断，那会把任意回环端口的页面也变成 owner。

3. **让 budgets/billing 的“未授权”可见（05 L03/L05/A11）。** 没有 `budgets` entitlement 时，`monthlyUsd` 仍能保存但永远不拦回合；没有 `billing` 时，售价表和 billable 列直接消失，用户可能把 provider 成本当成售价成本。方案 A：启动日志和 Usage 页明确显示“预算保护未授权，未生效”（推荐，不改变商业边界）；方案 B：无 entitlement 时隐藏预算/价格字段，避免误配；方案 C：在 OSS 强制预算（不采用，等于绕过商业许可）。另外 05 L05 推断并发回合可能在记账前都通过预算检查，建议派发前做成本预留；这是推断，需动态验证。

4. **自动 quota failover 改为明示同意（05 Q05/Q11）。** `quotaSwitchEnabled()` 默认开启（`server/quota-switch.ts:74-78`），限额或掉登录后会把 thread 切到备份 AI 并重发用户消息（`:154-191`）；备份可以是另一个付费 API，或同一 engine 的 pay-per-use 实例（`server/limit-failover.ts:22-31`），会真实产生账单。方案 A：同一订阅内的账号/engine 自动切换，切到 pay-per-use 前要一次确认（推荐）；方案 B：默认关闭，用户显式开启；方案 C：保持现状，最方便但费用不可预期。

5. **Local VM 手动 setup 命令不要输出固定密码（04 C37/L03）。** 自动创建使用 `randomBytes(6)` 随机 VNC 密码（`server/container-computer.ts:973-975`），但 `setupCommands()` 展示给用户的手动命令仍写死 `CHANGE_ME`（`:1177-1219`）；用户复制命令建容器时才会形成可预测密码。方案 A：展示命令改成生成随机密码的占位命令或要求先设置密码（推荐）；方案 B：删除手动命令，只允许应用自动创建；方案 C：保留并加显著警告（最省事，但风险留在文档里）。

6. **VPS alias 等于远端 Docker daemon 权限（04 A10/C38）。** `-H ssh://alias` 使用用户自己的 SSH 配置，代码不限制 alias 指向的主机或账号（`server/vps-computer.ts:182-186`；`server/vps-ssh.ts:47-62`）；如果 alias 是 root 或 docker 组，容器外的宿主也受控。方案 A：增加主机/用户 allowlist，并在首次使用前确认（推荐）；方案 B：默认关闭 VPS 目的地，只保留显式配置；方案 C：保持自由填写并在 UI 说明“alias 的权限就是宿主的权限”。

7. **Cloud Connected Apps 改成按需注册（04 C08/C09）。** Cloud home 启动后会向 broker 先 `POST /v1/installations`，再 `PUT /v1/installation/cloud`，失败按 30 秒到 30 分钟退避重试（`server/cloud-connected-apps.ts:20,114-168`；`electron/managed-composio.mjs:4,76-91`）；只发安装注册和 grant，不发聊天正文，但仍是默认厂商外连。方案 A：首次打开 Connected Apps 时再注册（推荐）；方案 B：保留启动注册但增加显式关闭开关；方案 C：OSS 完全禁用 broker。

8. **完成 `limits.*` 的接线（07 A4/A12）。** 工作树新增了 `limits.roomPostsPerTurn`，但 `server/index.ts:1630,14024-14025` 仍用硬编码 3；`limits.botsPerWorkspace` 只接入了普通 `/api/bots` 创建（`server/routes/bots-create.ts:188-190`），内部 create-bot 和 teamSetup 仍用 100（`server/index.ts:9318,14214-14215`）。方案 A：把两个调用点全部接到配置读取，保留旧默认值（推荐）；方案 B：暂时移除半成品键，等接线完成再发布；方案 C：保留并在文档标注“只对部分入口生效”（不推荐，配置会假生效）。

9. **数据删除类默认保持关闭并加提示（07 L1/L2/C15）。** `threads.eventLogRetentionDays` 会删除关闭/归档线程的 `events/` 和 `native/` NDJSON，`eventLogMaxBytes` 会静默裁到最新一半（`server/thread-retention.ts:1,22-47`；`server/thread-log-rotation.ts:18-27`）；两者默认关闭，且不删 SQLite 聊天记录。MCP 大结果每个工作目录只保留最新 20 个，旧的直接 unlink（`server/drivers/chat-mcp-tools.ts:319-330`），这一项默认启用。方案 A：L1/L2 保持默认关闭，开启时 UI 明示并支持 dry-run/导出（推荐）；方案 B：完全改成手动清理；方案 C：保留自动清理但先写审计事件和备份。

10. **账号卫生三项（06 A09/A20/A22）。** `openPairing()` 不传 scopes 时默认给全部 scope（`server/sessions.ts:357`），`eacbot pair` 不加 `--client` 就是完整 owner 码；admin 的 `GET /api/auth/sessions` 返回所有会话，没有按 tenant/person 过滤（`server/index.ts:12941-12942`）；普通配对+cookie 不撤销旧 cookie 会话，只有 browser sign-in 会撤（`:12732-12735`）。方案 A：配对默认 client、管理员显式 `--admin`，会话列表按人过滤，所有 cookie 签发都撤销旧会话（推荐，三项都是小改动）；方案 B：保留 admin 默认但增加二次确认；方案 C：单独拆出审计/运维角色。

## 口径与已落地变化

审计基线是 `781c57e`；审计期间主线程已提交 `b5ca7fd`（默认关闭更新检查、问题上报和公告三项外连），当前 HEAD 已不等于基线，但本总结仍以四份报告的原始口径为准。04 的云文件未被主线程改动，行号按当前工作树；05 以 HEAD `781c57e` 为主，`config.ts` 的并行漂移另注；06 按 HEAD 并在文末单列工作树漂移；07 按 2026-11-14 12:27 左右的当前工作树引用。当前工作树已出现的未提交变化包括：新增 `server/limits.ts` 与 `config.limits`，`server/request-auth.ts` 的同源浏览器例外，`src/lib/analytics.ts` 的默认关闭，`ChiefIntro` 的“稍后设置”，以及 People/Activity 的桌面可见性修复。这些变化只经过静态阅读，没有编译、启动或测试；合并前应按符号名重新核对报告行号，并补跑 `pnpm typecheck`、相关 Vitest 和本机浏览器/桌面冒烟。
