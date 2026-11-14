# 第二批清洗独立复核（Reviewer）

- 仓库：`D:\workspace\EACbot-clean-core`
- 分支：`codex/clean-core`
- 复核 HEAD：`521754b`（第二批第 7 个提交）
- 第一批基线：`b5ca7fd`
- 复核时间：2026-11-14 12:43–12:50（Asia/Shanghai）
- 复核方式：独立读 `git show`、逐文件核对源码、运行 Node 运行时探针、独立执行 Vitest 和 `pnpm typecheck`
- 工作树状态：复核前 `git status --porcelain=v1 -b` 只有 `## codex/clean-core`，无源码改动；复核结束时仍保持该状态
- 约束：未修改源码，未 commit，未 push；只新增本报告

## 一、逐提交文件范围

| 编号 | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1.1 | `ee8a553` 首次运行跳过 Chief、桌面端 People/Activity | 通过 | `git show --stat ee8a553`：6 个文件，全部是 `SettingsModal`、`ChiefIntro`、`WelcomeFlow` 及对应测试；没有依赖、配置或无关模块。标题与范围一致。 |
| 1.2 | `b64165d` 前端统计默认关闭 | 通过 | `git show --stat b64165d`：4 个文件，只有 `src/lib/analytics.ts`、`usage-snapshot.ts` 及两份测试；没有后端、构建或依赖改动。 |
| 1.3 | `e8bb257` 未配置更新源时显示未检查 | 通过 | `git show --stat e8bb257`：6 个文件，包括 `server-update.ts`、`SidebarProfileMenu.tsx`、两份测试和 en/zh 文案；范围与标题一致。 |
| 1.4 | `7cac874` 七项配额改为 config.json 的 limits | 通过（范围略宽但同主题） | `git show --stat 7cac874`：16 个文件，全部是配额定义、调用点、config schema/index 接线和 `server/limits.test.ts`。除标题七项外还增加了 `roomPostsPerMinute`、`roomPostsWithoutReply`、`roomBreakerMinutes` 三个同属房间发言预算的键；没有无关改动。 |
| 1.5 | `201a728` 本机同源页面免登录 | 通过 | `git show --stat 201a728`：仅 `server/request-auth.ts`、`request-auth.test.ts`、`request-auth.e2e.test.ts` 三个文件，范围与鉴权改动一致。 |
| 1.6 | `a412d99` 自托管文档写清三项外连与同源边界 | 通过 | `git show --stat a412d99`：只有 `docs/self-hosting.md` 一个文件，+62/-18；没有代码夹带。文档 `:50-80` 的三项配置与 `server/update-check.ts:11-20`、`server/devs-report-send.ts:25-37`、`server/announcement-feed.ts:27-35,86-125` 的实际开关一致；`:561-580` 的同源描述与 `server/request-auth.ts:208-211` 一致。 |
| 1.7 | `521754b` 十二份审计报告与复核记录 | 通过（文件范围） | `git show --stat 521754b`：13 个文件，00–11 共 12 份报告加 `A-summary.md`；全部在 `docs/cleanse/`，无源码夹带。内容准确性问题见第 9 项。 |

另核对提交身份：`git log --format='%h %an <%ae>' b5ca7fd..521754b` 的 7 个提交全部为 `look-back-lysj <3597536534@qq.com>`，符合提交邮箱约定。

## 二、逐项检查

| 编号 | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 2a | 不配置 `limits` 时七项默认值保持原值 | 通过 | bot 默认 100：`server/config.ts:636-638`；线程上限默认 16：`server/bot-thread-limits.ts:8,18`；图片日 50：`server/image-daily-cap.ts:11,31`；附件 512MB：`server/attachments.ts:25,41-49`；工具 128：`server/tool-count-limit.ts:134`；MCP 20：`server/mcp-registry.ts:81-83`；房间每回合 3：`server/room-post-budget.ts:36-40`。`server/limits.test.ts` 5/5 通过。线程的“16”是上限，不是任何机器都立即跑 16 条；未启用内存门时仍沿用原来的内存公式。独立探针在 8GB 主机得到 `plain:4, none:4`，与基线逻辑一致；内存门开启时为 16。 |
| 2b | 配置 limits 后能放大 | 通过（主要路径；有启动期快照） | `server/limits.test.ts` 的 “accepts a limits section and raises each cap” 已验证 bot 250、MCP 40、房间每回合 6、工具 256、图片 120、附件 2GB。独立 Node 探针输出 `{"bots":250,...}`；`botThreads:32` 在内存门主机上输出 32，默认仍为 16。注意：`threads.maxConcurrentPerBot` 仍优先于 `limits.botThreads`，且自动线程数仍受原内存公式约束；这是原行为，不是本批回归。`server/index.ts:9317` 的 TeamSetupRequestService 在构造时捕获 `maxBots`，`server/index.ts:12271` 的 sidebar schema 也在构造时捕获；修改 limits 后这两条路径需要重启或改成 getter，其他“每次调用读取”的配额可即时生效。 |
| 2c | 非法配额值被拒 | 通过 | `server/config.ts:325-336` 使用整数范围 schema；`limits.test.ts` 对 0、负数、1.5、字符串、未知键和 0 字节附件均断言抛错；`roomPostsWithoutReply: 0` 作为明确合法的“零容忍”例外。独立探针输出：`bots REJECTED`、`thread REJECTED`、`bytes REJECTED`、`mcp REJECTED`。 |
| 3a | 同源页面免登录与跨站、其他端口、file、null、导航、DNS rebinding 拒绝 | 通过（核心矩阵） | `server/request-auth.ts:208-211` 的 `provesSameOrigin`：有 Origin 时与 `requestOrigin(req)` 做完整协议/主机/端口字符串比较；无 Origin 时只接受 `Sec-Fetch-Site: same-origin`，两者都没有则失败。独立探针结果：本服务同源 -> `loopback/admin,client`；跨站 -> 403；`127.0.0.1:3000` -> 401；`Origin: null` -> 403；`file://` -> 403；地址栏导航 `sec-fetch-site:none` -> 401；非回环 Host -> 403；`evil.example` DNS rebinding -> 403；`127.0.0.1.nip.io` -> 403。 |
| 3b | 代理头必须仍然拒绝，非回环来源不能取得 owner | 不通过 | `server/request-auth.ts:180-183` 的 `isProxied` 用 `Boolean(header)` 判断，空字符串会当成“没有代理”；且只列了 `x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`、`forwarded`，没有 `x-real-ip` 等常见代理头。独立探针：带 `x-forwarded-for: ""`、`forwarded: ""` 或仅 `x-real-ip: 203.0.113.9` 的同源请求都返回 `loopback` 与 `admin,client`。另外，`resolveRequestAuth` 的回环判断只看 Host/Origin，不看 TCP peer；用 `socket.remoteAddress=203.0.113.9` 加回环 Host/Origin 的探针也得到 `loopback`。当前服务默认只监听 `127.0.0.1`（`server/index.ts:15508`），所以直连远程不是正常部署路径；但一旦监听地址或代理配置变化，闸门本身不会兜住。 |
| 4 | 埋点默认不加载 posthog、不发请求、不排队 | 通过 | `src/lib/analytics.ts:22-28` 只有 localStorage 显式写入 `0` 才返回 true，异常也返回 false；`initAnalytics` 在 `client || !analyticsEnabled()` 时直接返回，不会执行动态 import 或 init（`:76-87`）；`whenReady` 在未 opt-in 时不把事件放入 `pending`（`:198-201`）；日快照在 `:223` 的早退早于 claim day 和数据采集。`analytics.test.ts` 新增的 never-chosen 用例断言 `ph.loads === 0`、`ph.calls === []`、没有 `omb-installed`；`usage-snapshot.test.ts` 新增用例断言各数据源均未被调用。显式 `setAnalyticsEnabled(true)` 写 `0` 后仍能启动，说明 opt-in 路径保留。 |
| 5a | 跳过 Chief 不写入 `MET_CHIEF_HINT` | 通过 | `WelcomeFlow.tsx:99` 对 `reason === "skipped"` 使用 `completionPatch()`；`onboarding.ts:60-62` 的 completion 只包含 `completedAt/version`，不包含 hints。测试 `WelcomeFlow.test.ts:151-161` 断言保存对象没有 `hintsSeen`；`ChiefIntro.tsx:102-105` 的 Set up later 走 `onLater`，不调用 `onDone`。 |
| 5b | People 只对 ownerOrAdmin 显示 | 不通过 | `src/components/SettingsModal.tsx:205` 的过滤条件只检查 `state.config?.cloudHome !== true`，没有检查 `ownerOrAdmin`；因此普通成员在非 Cloud 自托管页面仍会看到 People 入口。`PeopleSection.tsx:259` 的 `canPairDevices` 会让内容渲染为空，所以不是数据泄漏，但不满足“入口只对 ownerOrAdmin 显示”。`SettingsModal.groups.test.ts:110` 在“every desktop page”用例前直接把 `fixture.ownerOrAdmin` 设为 true，未覆盖非管理员场景。 |
| 5c | Activity 只对 ownerOrAdmin 显示 | 通过 | `src/components/SettingsModal.tsx:206` 明确使用 `ownerOrAdmin === true`；没有发现另一条绕过该过滤的入口。 |
| 6 | 未配置更新源时显示未检查，服务端缺字段时向后兼容 | 通过 | 服务端无 `EAC_UPDATE_CHECK_URL` 时在 fetch 前返回 `checked:false`：`server/update-check.ts:110`；前端只把严格的 `checked === false` 映射成 `not-checked`：`src/lib/server-update.ts:23-28`；缺字段时继续走旧判断（可用/已最新/需刷新）：`:29-31`；文案在 `:41-44`。测试还覆盖 `checked:false + available:true` 时“已报告的版本优先”，以及中文“未检查更新”。 |
| 7 | 测试是否被改弱（断言数量、skip/only/todo、expect 改 console） | 通过（机械检查） | 对比 `b5ca7fd..521754b` 的测试：SettingsModal 17->17 个 expect、ChiefIntro 42->45、WelcomeFlow 54->58、analytics 74->78、usage-snapshot 72->76、SidebarProfileMenu.server-update 4->5、server-update 23->29、config 574->574、request-auth 226->234、request-auth.e2e 10->15。没有新增 `.skip/.only/.todo`，没有把 expect 换成 console.log。被删除的旧断言均被更严格或多场景断言替代（例如旧的 WebSocket 401 变成 own 不 401 + foreign 401）。覆盖缺口：People 非管理员入口没有测试，代理空头/X-Real-IP 也没有测试，导致上述回归未被现有套件发现。 |
| 8 | 独立跑受影响测试与 typecheck | 通过 | `pnpm exec vitest run --reporter=dot` 跑 limits、request-auth、request-auth.e2e、analytics、usage-snapshot、server-update、ChiefIntro、WelcomeFlow、SettingsModal.groups、room-post-budget、mcp-registry、attachments、image-daily-cap、tool-count-limit、SidebarProfileMenu.server-update：**15 个文件、294 条测试全部通过，exit 0，21.23s**。`pnpm typecheck` 执行 `tsc -b && tsc -p tsconfig.server.json`，**exit 0，约 53.4s**。额外跑了 `server/config.test.ts`：506 条通过、1 条失败在 `:1991` 的 `omb_cloud_ready_token` 断言；该测试的断言、`server/credential-env.ts` 和失败逻辑在 `b5ca7fd` 已完全相同（`git diff b5ca7fd..HEAD -- server/credential-env.ts` 无输出），属于基线已有的 Windows 令牌清理缺口，不是本批提交引入的回归。 |
| 9 | 文档提交内容是否与最终代码一致 | 不通过（文档准确性与时间戳） | `521754b` 的提交时间是 `2026-11-14 12:40:59 +0800`，但 `docs/cleanse/08-evidence-audit.md:3` 写“抽查时间 12:13–13:05”，`docs/cleanse/09-blindspots.md:3` 写“扫描时间 12:25–13:05”；截至复核时（12:48）13:05 尚未发生，报告不可能已完成到该时间。另有事实漂移：`07-quota.md:32,42,48,132` 和 `A-summary.md:11,29` 说 `roomPostsPerTurn`、`botsPerWorkspace` 仍为硬编码/半接线，但当前 `server/index.ts:14023` 已调用 `roomPostsPerTurn()`，`:14214,14254` 已调用 `maxBotsPerWorkspace(cfg)`。这些报告把“当时的工作树”写成当前状态，且没有醒目的快照截止标识，会误导后续维护者。 |

## 三、测试与探针证据摘要

- `server/limits.test.ts` 单独运行：1 个文件、5 条测试通过，exit 0。
- 15 个受影响测试文件：`Test Files 15 passed (15)`，`Tests 294 passed (294)`，exit 0。
- `pnpm typecheck`：`tsc -b && tsc -p tsconfig.server.json`，两次命令行完成，exit 0。
- 鉴权探针（直接调用 `resolveRequestAuth`，固定 `loopbackTrust: "owner"`）：
  - 本服务同源：`own loopback`
  - 跨站：`403 cross-origin`
  - 其他端口：`401 unauthorized`
  - `Origin: null` / `file://`：`403 cross-origin`
  - 地址栏导航：`401 unauthorized`
  - 非回环 Host / DNS rebinding / `127.0.0.1.nip.io`：`403 loopback host required`
  - 非空 `x-forwarded-for` / `Forwarded`：`403 proxied`
  - `x-forwarded-for: ""` / `Forwarded: ""` / 仅 `x-real-ip`：`loopback admin,client`（失败点）
  - 仅 TCP peer 非回环、Header 全部伪造：`loopback admin,client`（当前只绑 127.0.0.1 时不可由公网直连，仍是防御缺口）
- 配额探针：默认 bot 100、线程上限 16、图片 50、附件 512MB、工具 128、MCP 20、房间每回合 3；配置后 bot 250、MCP 40、房间 6、工具 256、图片 120、附件 2GB、内存门线程 32。

## 四、结论

**第二批不能进入下一批。** 不是测试数量或类型检查挡住了它：两个代码行为要求没有满足，另有一处文档事实/时间戳问题：

1. **People 入口没有 `ownerOrAdmin` 门。** 修改 `src/components/SettingsModal.tsx:205`，让 `people` 与 `activity` 一样要求 `ownerOrAdmin === true`；补一条非管理员渲染断言，确认 People/Activity 都不在 rail 中。People 内容虽然会被 `PeopleSection.tsx:259` 拒绝渲染，但入口可见仍违反本次验收条件。
2. **代理边界仍能取得 owner。** 修改 `server/request-auth.ts:180-183`：用键是否存在判断转发头，不要用非空字符串的布尔值；同时把 `x-real-ip`、`cf-connecting-ip`、`true-client-ip` 等常见代理头纳入 fail-closed 集合。建议在回环分支再核对 TCP peer 是否为本机，或至少用测试锁死“当前只允许 127.0.0.1 监听”的前提。补测试覆盖空 `x-forwarded-*`、仅 `X-Real-IP`，以及同源但构造了这些头的请求。
3. **`521754b` 的审计元数据与最终代码不一致。** 把 `08/09` 的时间改成真实完成时间（或明确标注“计划/快照时间”），并把 `07-quota.md` 与 `A-summary.md` 中“roomPostsPerTurn、botsPerWorkspace 仍未接线”的当前状态句更新为最终代码，或明确标注这些是 12:22 快照而非 HEAD 事实。否则这批文档不能作为可信复核记录合并。

建议但不阻断的补强：给 `limits.botThreads` 增加一条明确的默认值/放大测试，并在文档中说明“线程上限”和“按内存计算出的实际并发数”不是同一个数。
