# 08 证据抽查

抽查开始时间：2026-11-14 12:13（Asia/Shanghai）；报告定稿时间：2026-11-14（具体时刻未单独记录；不晚于本文件提交时间 12:40:59）  
抽查对象：`docs/cleanse/00-baseline.md` 与 01~07 号报告；报告产出前先抽查了 `docs/plan/01~05`。每份来源抽 10 条，共 13 份、130 条。
代码口径：`D:\workspace\EACbot-clean-core`，分支 `codex/clean-core`，基线 `781c57e`。抽查期间仓库新增了提交 `b5ca7fd`（12:18“默认关闭三项外连”），工作树还有多项并行修改（`request-auth.ts`、`mcp-registry.ts`、`bot-thread-limits.ts`、`image-daily-cap.ts`、`SettingsModal.tsx`、`ChiefIntro.tsx` 等），因此涉及这些文件的行号会同时给出基线/当前口径；落地前必须按符号名复核。  
方法：每份来源报告抽 10 条最具体、可验证的结论，逐条回到源码核对文件、行号和描述。只读，不修改代码。  
说明：`00-baseline.md` 在抽查期间仍被编辑，本表以其 SHA256 `06B7FB04B7F5EB08DDD1458FE420B3EF52741D34202D415248C2B0B3E2406769` 的版本为准。
补记：`01`、`04`、`05`、`06`、`07` 在本表完成后（12:35–12:36）又有更新。其中 `01` 的修订版已经修正了 E-07 的“Cloud Admin 回退”说法；其余报告的更新未逐条重跑，本表保留抽查当时版本的判断，落地前请以最新版为准。
章节按抽查完成顺序排列，不按报告编号顺序；每节标题都写了来源文件。

## 一、`00-baseline.md`

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 00-baseline.md | B01 | 基线 BLOCKED：当前工作树缺少 `node_modules`，本地 `tsc`/`vitest` 不存在，类型检查、构建和测试都在启动前失败。 | `package.json:38-40`；实际目录 `node_modules`、`node_modules/.pnpm`、`apps/docs/node_modules`、`cloudflare/control-plane/node_modules` 均存在 | 不成立（已过时） | 目录创建时间为 2026-11-14 12:07:37，`node_modules/.bin/tsc.cmd` 与 `vitest.cmd` 创建于 12:07:47；报告最后保存于 12:09:15，仍用现在时写“缺少依赖”。依赖已由其它小组安装，BLOCKED 结论不再代表当前状态，应重新采集基线。 |
| 00-baseline.md | B02 | 根 `typecheck` 是 `tsc -b && tsc -p tsconfig.server.json`（`package.json:39`）。 | `package.json:39` | 成立 | 行号与命令逐字一致。 |
| 00-baseline.md | B03 | 根 `build` 是 `tsc -b && tsc -p tsconfig.server.json && vite build`（`package.json:38`）。 | `package.json:38` | 成立 | 行号与命令逐字一致。 |
| 00-baseline.md | B04 | 根 `test` 是四段链：`vitest run && pnpm broker:test && pnpm test:electron && pnpm test:packaged-server`（`package.json:40`）。 | `package.json:40`；`test:electron` 在 `:41`；`test:packaged-server` 在 `:80`；`broker:test` 在 `:83` | 成立 | 四段名称、顺序与被调脚本行号一致。 |
| 00-baseline.md | B05 | pnpm workspace 只有根 `.`、`apps/docs`、`cloudflare/control-plane` 三个成员（`pnpm-workspace.yaml:4-7`）。 | `pnpm-workspace.yaml:4-7`（成员值在 `:5-7`）；`cloudflare/composio-broker/package.json` 不存在 | 成立 | 成员数量和名称一致；`:4` 是 `packages:` 键，成员值实际在 `:5-7`，属行号范围的小偏差。 |
| 00-baseline.md | B06 | Vitest 发现范围含 `evals`、`server`、`electron`、`src`、`shared`、`companion`、`enterprise`、`connector`、`scripts` 九类目录（`vite.config.ts:34-44`）。 | `vite.config.ts:34-45`（条目 `:35-44`）；`test.environment` 在 `:56`，`setupFiles` 在 `:60` | 成立 | 九类目录均存在；数组实际闭合于 `:45`，且 `scripts` 由 `:43` 的 `*.test.mjs` 和 `:44` 的 `*.test.ts` 两条 glob 组成。 |
| 00-baseline.md | B07 | 根 `typecheck` 覆盖 `src`、`vite.config.ts` 以及 `server`、`companion`、`enterprise`、`connector`（`tsconfig.json:23`、`tsconfig.server.json:24-28`）。 | `tsconfig.json:23`；`tsconfig.server.json:24-32`（四个目录条目在 `:25-28`，排除项在 `:30-32`） | 部分成立 | 四个目录条目实际在 `:25-28`，`:24` 是 `include` 键；且 `tsconfig.server.json:30-32` 排除了 `server/drivers/pi-mcp-extension.ts`，“覆盖 server”并非全目录覆盖，原结论省略了排除条件。 |
| 00-baseline.md | B08 | update-check 两个测试文件共有 6+3=9 条静态声明（`server/update-check.test.ts:9`、`server/routes/update-check.test.ts:31`）。 | HEAD 的 `server/update-check.test.ts` 为 6 条；当前工作树 `:10` 起为 8 条；`server/routes/update-check.test.ts:31` 为 3 条 | 部分成立 | 6+3=9 与 HEAD `781c57e` 一致；但该测试文件当前有未提交修改，describe 由 `:9` 移到 `:10`，`it` 由 6 条增至 8 条，引用行号已不对应当前工作树。 |
| 00-baseline.md | B09 | config 域有 174 条测试声明，范围为 `server/config.test.ts:55` 至 `:2358` 的多组 describe。 | `server/config.test.ts:55`（首个 describe）、`:2358`（最后一组 describe 起点）、`:2359` 与 `:2375`（最后两条 it），文件止于 `:2379` | 部分成立 | 静态 `it` 共 173 条，不是 174；`:2358` 只是最后一组 describe 的开头，未覆盖 `:2359` 与 `:2375` 两条用例，文件实际到 `:2379`。 |
| 00-baseline.md | B10 | 9 个测试文件合计 230 条静态声明。 | 逐文件计数：6+3+2+3+13+19+3+7+173=229（HEAD）；当前工作树 update-check 为 8，合计 231 | 不成立 | 报告自己的分项求和是 230，但源码实际计数 HEAD 为 229、当前工作树为 231。差异来自 config 多计 1 条，以及 update-check 未提交修改新增 2 条。 |

小结：10 条中成立 5 条、部分成立 3 条、不成立 2 条。主要问题不是行号漂移，而是“依赖缺失”的现在时结论已被并发安装推翻，以及测试声明计数存在 1 条误差。

## 二、`docs/plan/01-boot-chain.md` 与 `02-minimal-features.md`

这两份计划文档分析的是原仓库 `D:\workspace\EACbot`。与 `EACbot-clean-core` 的基线代码相比，多处行号后移或前移，但启动顺序、调用关系和核心判断基本一致。下表同时给出计划文档的原始引用与当前代码的实际位置。

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| plan/01-boot-chain.md | 01-1 | Node >= 24，根包必须保留 `"type": "module"`，用 `--experimental-strip-types` 直接运行 `.ts`、不生成 `dist`。 | `package.json:14`、`:16-18`；脚本 `:31-33` | 成立 | `"type": "module"` 在 :14，`engines.node` 在 :16-18；仓库没有直接启动 `server/index.ts` 的脚本。 |
| plan/01-boot-chain.md | 01-2 | 首个 import 是 `cloud-secrets-boot.ts`，只依赖 `node:fs`，在其它模块可能拉起子进程前读取并关闭 Cloud 密钥 FD。 | `server/index.ts:2`、`cloud-secrets-boot.ts:3`、`cloud-secrets.ts:2`、`:24-42` | 成立 | 顺序和依赖关系均成立；FD 校验、读取与关闭在 `cloud-secrets.ts:24-42`。 |
| plan/01-boot-chain.md | 01-3 | `server/index.ts:2-645` 是完整静态导入区，`:647` 才开始读端口。 | `server/index.ts:2-649`、`:651` | 部分成立 | 导入区实际到 :649，:646-649 仍有 4 条 import；端口读取在 :651，整体后移 4 行。 |
| plan/01-boot-chain.md | 01-4 | 读端口和静态目录后调用 `ensureDirs()`，创建数据根、`events/`、`native/`。 | `server/index.ts:651-656`、`config.ts:716-730` | 部分成立 | 端口与 `STATIC_DIR` 在 :651-654，`ensureDirs()` 在 :656，比引用晚 4 行；`config.ts:716-730` 完全命中。 |
| plan/01-boot-chain.md | 01-5 | 读取持久身份、会话、配置、Store 之前先取得 `eacbot-server.lease`，活进程持有时拒绝启动。 | `server/index.ts:657-658`、`:660-669`、`electron/data-dir-lease.mjs:520-527` | 部分成立 | 取租约在 :657-658；:653-656 已是端口与 `ensureDirs()`；拒绝分支实际到 :527，引用少 1 行。 |
| plan/01-boot-chain.md | 01-6 | `environment-id` 不存在时自动创建；已存在但非合法 UUID 或不可读时拒绝替换并中止。 | `server/index.ts:680`、`environment.ts:67-81`、`:86-113` | 部分成立 | `loadEnvironmentId(DATA_DIR)` 在 :680，比引用晚 4 行；`environment.ts` 两段完全命中。 |
| plan/01-boot-chain.md | 01-7 | 创建 `SessionRegistry`，先写 `sessions.json.open` 守卫再载入；上次留下 `.open` 时只恢复非账号会话。 | `server/index.ts:685-692`、`sessions.ts:243-252`、`:265` | 部分成立 | 构造在 :685-692，比引用晚 4 行；open 标记在 :243/:247，`load(!unclean)` 在 :252，非账号过滤在 :265。 |
| plan/01-boot-chain.md | 01-8 | 主 HTTP 服务之前先监听 `127.0.0.1:${WEBHOOK_PORT}`，失败被捕获并只记录 “receiver unavailable”。 | `server/index.ts:9581-9598`、`webhook-ingress.ts:172-205` | 部分成立 | 引用 9555-9567 现为 `WebhookManager` 构造；`listenWebhookIngress` 在 :9584，catch 与提示在 :9590-9592。 |
| plan/01-boot-chain.md | 01-9 | 主端口 `server.listen(PORT, "127.0.0.1")` 在 15544，回调里才启动 waits、browser sweep、upkeep、routines 等后台任务。 | `server/index.ts:15506-15524`、`compose.yaml:18` | 部分成立 | `listen` 在 :15506，比引用早 38 行；15469-15470 现为 follow-up 恢复循环；后台任务从 :15509 起。 |
| plan/01-boot-chain.md | 01-10 | `skills/` 不参与启动，可以最后再加。 | `server/index.ts:1418`、`skill-library.ts:78-79` | 部分成立 | `skills/` 启动时就被 `loadBundledSkills()` 读取；目录缺失只返回空数组。因此“缺失不阻塞”成立，“不参与启动”不成立。 |
| plan/02-minimal-features.md | 02-1 | 驱动表 `BUILT_IN_DRIVERS` 在 `drivers/builtIn.ts:29`，`OpenAICompatDriver` 在 `:44`。 | `server/drivers/builtIn.ts:29`、`:19`、`:44` | 成立 | 驱动数组在 :29，`OpenAICompatDriver` 数组项在 :44，import 在 :19。 |
| plan/02-minimal-features.md | 02-2 | `index.ts:809` 创建 `ProviderRegistry`，`:1415` 执行 `registry.load(...)`，`:1510` 用 `bus.attach(...)` 接事件。 | `server/index.ts:815`、`:1417`、`:1512` | 部分成立 | 三处分别后移 6、2、2 行；三件事本身都在，但原引用行已指向别的语句。 |
| plan/02-minimal-features.md | 02-3 | `POST /api/bots` 在 `routes/bots-create.ts:90`，`:182` 调 `checkedModelSelection(...)`，`:201` 调 `store.createBot(...)`。 | `server/routes/bots-create.ts:90`、`:182`、`:201` | 成立 | 三处全部命中；`createBot` 调用在 :201-204。 |
| plan/02-minimal-features.md | 02-4 | `store.ts:1310` 的 `createBot()` 生成 `bot.id`、`bot.threadId` 和初始 task，`:1361` 的 `saveBots(...)` 先写 `bots.json` 再发内存事件。 | `server/store.ts:1308`、`:1325-1326`、`:1348-1357`、`:1359`、`:1367` | 部分成立 | `createBot(` 头在 :1308（-2），`saveBots` 在 :1359（-2）；id/threadId 在 :1325-1326，初始 task 在 :1348-1357，emit 在 :1367。 |
| plan/02-minimal-features.md | 02-5 | `POST /api/bots/:id/messages` 在 `routes/bot-messages.ts:187`，`:332` 调 `acceptDirectSend(...)`，`:340` 返回 202 接收凭据，不是模型回复。 | `server/routes/bot-messages.ts:187`、`:332`、`:340`；回复回写在 `index.ts:6417-6423`、`:6454-6456` | 成立 | 三处全部命中；202 响应体是 receipt，助手文本由事件异步写入。 |
| plan/02-minimal-features.md | 02-6 | `index.ts:7237` 的 `acceptDirectSend()` 与 `:7189-7211` 的 `startOrQueueDirectMessage()` 负责排队和启动。 | `server/index.ts:7244`、`:7196-7220`、`:7218` | 部分成立 | `acceptDirectSend` 头在 :7244（+7）；`startOrQueueDirectMessage` 头在 :7196，原区间 :7189-7211 落在上一个排队函数尾部；`startTurn` 调用在 :7218。 |
| plan/02-minimal-features.md | 02-7 | `startTurn()` 在 `index.ts:7538` 包 `batchSaves`，`beginTurn()` 在 `:7539`；后续取 bot、投影、取实例、追加 user 消息、通知协调器、置 working、调 `sendTurn` 的位置如原文。 | `server/index.ts:7545-7546`、`:7589`、`:7607`、`:7641`、`:7705-7721`、`:7801`、`:7810`、`:8487` | 部分成立 | 前四段后移 7 行，追加 user 消息后移 10 行，`beginTurn`/`working` 后移 21 行，`sendTurn` 后移 24 行；调用关系本身成立。 |
| plan/02-minimal-features.md | 02-8 | `pushMessage()` 在 `index.ts:6390`、`pushAssistantText()` 在 `:6409`、`item.completed` 在 `:6446-6448` 把驱动文本写入 Store。 | `server/index.ts:6398`、`:6417`、`:6454-6456` | 部分成立 | 三处统一后移 8 行；:6390 现为 `routines?.handleRuntimeEvent`，:6446 是 `turn.started` 分支；落库仍经 :6405 的 `store.appendMessage`。 |
| plan/02-minimal-features.md | 02-9 | `openai-chat.ts:208` 建运行时，`:490-517` 组消息，`:522` 的 `sendTurn()`，`:297` 请求 `/chat/completions`，`:741` 发 `item.completed/assistant_text`，`:925` 发 `turn.completed`。 | `server/drivers/openai-chat.ts:208`、`:490-520`、`:522`、`:297`、`:741`、`:925` | 成立 | 所有锚点命中；`messagesFor` 实际结束于 :520，:517 只是 transcript map 的末行。 |
| plan/02-minimal-features.md | 02-10 | 协调器接口是必需调用点（`index.ts:7715` 的 `answer`、`:7780` 的 `beginTurn`），完整多 bot 运行时不是；保留 `coordinator.ts:160-179` 的形状，`runtime-coordinator.ts:319` 可后补。 | `server/index.ts:7730`、`:7801`、`coordinator.ts:160-216`、`:214`、`runtime-coordinator.ts:319` | 部分成立 | `answer` 在 :7730（+15），`beginTurn` 在 :7801（+21）；接口实际是 :160-216，:160-179 只到 `beginTurn` 声明，缺 `endTurn`（:180）和 `answer`（:214）。 |

小结：20 条中成立 6 条、部分成立 14 条、不成立 0 条。计划文档的描述基本可靠，但行号普遍漂移 2~38 行，直接照抄会指错代码；引用时应以当前工作树重新定位。

## 三、`docs/cleanse/01-backend-egress.md`

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 01-backend-egress.md | E-01 | 打包桌面端启动 15 秒后检查更新，此后每小时从 GitHub Releases 的 `Ebony-Vinyl/EACbot` 读取 `latest.yml` 或 `latest-mac.yml`。 | `electron/updater.mjs:151-155,189-190`；`electron-builder.yml:16-19` | 成立 | 15 秒、每小时和发布仓库均一致；仅报告第四节把打包门禁写成 153-158，实际在 151-155，偏移约 2 行。 |
| 01-backend-egress.md | E-02 | 已下载更新后，Windows/macOS 在无人使用且应用空闲时执行 `quitAndInstall` 或静默 NSIS 安装并重启。 | `electron/update-when-quiet.mjs:1-4,71,79-107`；`electron/updater.mjs:32,180-185`；`electron/updater-coordinator.mjs:256` | 成立 | 引用行号一致；实际条件更细：无输入、锁屏或 10 分钟无操作、窗口隐藏 2 分钟、本地与服务端均无进行中工作。 |
| 01-backend-egress.md | E-03 | 打包桌面端创建 companion account service 后，启动时向 `accounts.eacbot.com` 发 `GET /healthz`。 | `electron/main.mjs:2965,3129`；`electron/companion-account-service.mjs:18,74-82,325-348,958-961`；`electron/control-plane-client.mjs:271-273` | 成立 | 报告只列 3129 的 restore 调用；实际链路是 958-961 → 325-348 → 271-273 的 `/healthz`，中间行未列；开启桌面远程访问时 2965 不创建该服务。 |
| 01-backend-egress.md | E-04 | 打包桌面端启动且未开桌面远程访问时，向 workers.dev broker `POST /v1/installations`（body 为 `{}`）注册，已有 token 时先 `GET /v1/me`。 | `electron/main.mjs:3134-3143`；`electron/managed-composio.mjs:4,7-9,60-95` | 成立 | 启动条件一致；但报告引用的 72-100 从 `/v1/me` 的 catch 开始，GET 实际在 62，POST 在 77-95。 |
| 01-backend-egress.md | E-06 | 服务启动约 1 秒后拉取公告，之后每 10 分钟一次，地址为空则完全不请求。 | `server/announcement-feed.ts:10-11,116-125`；`server/index.ts:12493` | 成立 | 1 秒、10 分钟与 12493 均准确；定时器在构造 feed 时排定，严格说是路由装配时而非 listen 回调后。 |
| 01-backend-egress.md | E-07 | `@devs` 报告发往 `EAC_BUG_REPORT_URL` 或 Cloud home 的 `EAC_CLOUD_ADMIN_URL`，两者都无则完全不发。 | `server/devs-report-send.ts:25-37,78-80`；`server/index.ts:2846`；`server/host/devs-reports.ts:455-456` | 部分成立 | “无 `EAC_BUG_REPORT_URL` 就不发”成立；但 `devs-report-send.ts:25-26` 明确没有 Cloud 派生目标，`index.ts:2846` 只传 `bugReportEndpoint(process.env)`，不存在 `EAC_CLOUD_ADMIN_URL` 回退。 |
| 01-backend-egress.md | E-09 | Team Cloud 启动时、每 5 分钟或 Admin 通知变更时，POST 策略 fingerprint/version 与 problem，并带 machine id、时间戳、nonce、HMAC。 | `server/cloud-team-policy.ts:21,26,176-184,224-228,255-258` | 部分成立 | 路径、启动即拉取、body 与签名头 176-184 均一致；但 227 的间隔是 5 分钟乘 1 加 0.2 倍随机数，实际为 5–6 分钟，不是固定 5 分钟。 |
| 01-backend-egress.md | E-19 | decider 房间路由发送房间名、参与者、最近消息不超过 6000 字符、新消息不超过 8000 字符，收件箱分类还发邮件正文（上限 200k 字符）。 | `server/decider/room-routing.ts:18,52-64,77`；`server/decider/inbox-triage.ts:34`；`server/host/inbox-triage.ts:30-31,54-57`；`server/extractor/contract.ts:20,40` | 部分成立 | 6000 与 8000 准确；但收件箱分类给 decider 的只有 from ≤160、subject ≤200、preview ≤600，给 extractor 的整段文本上限是 8000 字符；200000 是通用 extract 的 text 上限，并非邮件正文上限。 |
| 01-backend-egress.md | E-29 | 服务启动 2 分钟后开始检查，之后每 24 小时自动更新应用自装引擎，无 UI 开关。 | `server/engine-updates.ts:1-4,21-23,334-336,356-363`；`server/index.ts:15511` | 成立 | 2 分钟、24 小时与 15511 均准确；首次基准是 `createEngineUpdater` 的 `startedAt`（335），此后按 `state.checkedAt` 计时（336），忙碌时另有 5 分钟重试。 |
| 01-backend-egress.md | E-32 | 自建服务器只要配置邮箱登录白名单，未设 `EAC_CONTROL_PLANE_URL` 也会默认走 `accounts.eacbot.com`。 | `server/account-signin.ts:56-60,62-68`；`electron/companion-account-service.mjs:18,74-82` | 部分成立 | 默认地址成立（64 行 `isPackaged:true` 对应 18 行常量）；但报告引用的 60-66 整体早约 2 行，控制面块实际 62-68；且 56-60 若配置 `EAC_SIGNIN_SMTP_URL` 会直接走本机 SMTP。 |

小结：10 条中成立 6 条、部分成立 4 条、不成立 0 条。最实质的偏差是 E-07：报告写了一个并不存在的 Cloud Admin 回退地址，会让读者误判 `@devs` 在 Cloud 上会自动上报。

## 四、`docs/plan/03-coupling.md`、`04-core-spec.md`、`05-remaining-capabilities.md`

口径说明：`03` 描述当前的 `EACbot` 仓库；`04` 是“要重写的东西”的规格，正文中的 `src/*` 指另一套 `eacbot-core` 参考实现，不是 `clean-core` 的现有代码；`05` 混用了 `eacbot-core`（核心）与 `EACbot`（上游）两套实现。因此下表的“部分成立”很多不是算错，而是描述对象与 clean-core 不是同一套代码。

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| plan/03-coupling.md | 03-1 | `server/index.ts` 是组合根，实测 15,674 行。 | EACbot `server/index.ts` 15,674 行；clean-core 15,636 行（781c57e） | 部分成立 | 组合根判断成立；clean-core 少 38 行，15,674 只对应 EACbot 14d72d9。 |
| plan/03-coupling.md | 03-2 | `server/index.ts:622` 顶部静态 import 插件宿主。 | EACbot `:622`；clean-core `:626` | 部分成立 | clean-core 后移 4 行，同一行 `createPluginsHost` 导入，行为一致。 |
| plan/03-coupling.md | 03-3 | `server/index.ts:2395` 构造 `createBrowserHost`；浏览器栈 724/989/555 行，index 有 393 处 browser。 | clean-core `:2395` 为解构头、`:2401` 调用；`browser-engine.ts` 724、`browser-runtime.ts` 989、`host/browser.ts` 555；`rg -io browser server/index.ts` 393 | 部分成立 | 三个行数和 393 次引用完全一致；clean-core 调用点后移 6 行。 |
| plan/03-coupling.md | 03-4 | `server/index.ts:15475` 在 listen 前 `await loadEnterpriseLayer`。 | EACbot `:15475`；clean-core `:15437` | 部分成立 | clean-core 前移 38 行；仍在 `server.listen` 前，调用关系不变。 |
| plan/03-coupling.md | 03-5 | `server/enterprise.ts:13-35` 定义 EditionStatus/schema，`:108-111` 提供 createWorkspaceAccess，`:119-133` 无企业目录回落 oss；保留约 200 行模块、删 enterprise/ 目录不影响，目录 10 文件。 | `server/enterprise.ts:13-34,108-111,119-130`（224 行）；`enterprise/` 10 文件；`tsconfig.server.json:27`；`scripts/bundle-server.mjs:128-141` | 部分成立 | 类型、工厂、回落均存在；回落分支实际 126-129，133 已进入动态 import 的 try；模块 224 行、目录 10 文件、两处构建引用准确。 |
| plan/03-coupling.md | 03-6 | `server/cloud-home.ts:37-47` 的 CloudHomeConfig 是启动入参，`:70-87` 无配置返回 null；`CLOUD_HOME?.team` 喂给 `createCloudTeamHost`。 | `server/cloud-home.ts:37-47,70-87`；`server/index.ts:698` 归一为 `CLOUD_TEAM`，`:962` 传入 | 成立 | 类型和 null 分支逐行命中；实际先赋 `CLOUD_TEAM = CLOUD_HOME?.team ?? null` 再传，语义相同。 |
| plan/03-coupling.md | 03-7 | `server/audience.ts:1-6` 的 Audience 是持久化字段，`server/store.ts:889` 的 audienceFloor，`shared/wire.ts:130,155` 把它带给前端。 | `server/audience.ts:1-5,63-68`；`server/store.ts:887`（clean）/ `:889`（EACbot）；`shared/wire.ts:885-887` | 部分成立 | Audience 类型和 layerId 命中；store 行号 clean-core 少 2 行；wire.ts:130/155 实际是 `BotMovedTo.team` 和 private 注释，持久化字段在 885-887。 |
| plan/03-coupling.md | 03-8 | `server/media/audio-focus.ts:9`、`audio-stream.ts:1`、`memory-spaces/store.ts:21` 依赖 `shared/plugins/audio.ts` 与 `memory-spaces.ts`，清理插件不能删 `shared/plugins`。 | 三处 import 均命中；两个 `shared/plugins` 文件存在 | 成立 | 行号逐字命中；依赖方向确为媒体/记忆模块指向 shared/plugins，保留判断成立。 |
| plan/03-coupling.md | 03-9 | `server/host/plugins-host.ts:7-19` 引入 11 个 server/plugins 模块，`:48-57` 建 registry、reconcile、写默认频道。 | EACbot `:7-19,:48-57`；clean-core `:7-20`、`:56-66`（registry :56、reconcile :64、ensureDefault :66） | 部分成立 | 11 个模块数量成立；clean-core 因多 `recordCall` 选项整体后移 8 行，`:48-57` 已落到接口定义。 |
| plan/03-coupling.md | 03-10 | relay 根目录 33 个文件可整删，`relay/src/main.ts:1` 是入口，对 server/、shared/ 的 import 为零，`server/tunnel.ts` 不引用它。 | `relay/` 33 文件；`relay/src/main.ts:1`；rg 无 `server/` 或 `shared/` 命中；`server/tunnel.ts` 无 relay 引用 | 成立 | 文件数、入口、零依赖均核实；删除只需处理 CI/部署引用，代码改动为零。 |
| plan/04-core-spec.md | 04-1 | 原服务启动解析约 1289 个本地模块（server 1125、shared 130），全部耦合在 15,674 行的 `server/index.ts`。 | EACbot 15,674；clean-core 15,636；clean-core 非测试 .ts 文件 server 1282、shared 176 | 部分成立 | 15,674 对应 EACbot；按文件计 1282/176，与 1125/130 不符，1289 的启动图口径未复现。 |
| plan/04-core-spec.md | 04-2 | v1 的 `config` 读 `data/config.json`，校验实例 id、baseUrl、apiKey 或 apiKeyEnv、model。 | eacbot-core `src/config.ts:465-547,31-56,342-353`；clean-core `server/config.ts:716,733` 读 `~/.eacbot/config.json`，实例是 `instances` 映射（`:272-286`） | 部分成立 | eacbot-core 的路径和字段逐项命中；clean-core 的配置路径、实例结构和字段名都不同。 |
| plan/04-core-spec.md | 04-3 | `data/token` 首次启动生成，权限 0600。 | eacbot-core `src/auth.ts:17-43`；clean-core 无 `data/token` | 部分成立 | eacbot-core 实现逐行命中（含已存在文件 chmod 0600）；clean-core 认证走 loopback/session，没有这个令牌文件。 |
| plan/04-core-spec.md | 04-4 | 消息写 `data/messages/<threadId>.jsonl`，字段 id/role/text/createdAt，新消息带 batch/seq，批次末尾写 `{"type":"batch",...}`。 | eacbot-core `src/store.ts:535-557`、`src/batch-log.ts:10-43`；clean-core `server/store.ts:206` 是 `messages-<threadId>.json`，主存储在 SQLite | 部分成立 | eacbot-core 的 jsonl、batch/seq、提交标记均命中；clean-core 是 SQLite + 单线程 JSON 快照，没有该布局。 |
| plan/04-core-spec.md | 04-5 | 写入先写临时文件再改名；读取容忍最后一行损坏。 | eacbot-core `src/store.ts:567-576,359-437`；clean-core `server/atomic.ts:51-76` | 部分成立 | eacbot-core 的临时文件/rename 和“仅最后一行可损坏”成立；clean-core 只有通用原子写，消息读取走 SQLite，没有 jsonl 尾行容错。 |
| plan/04-core-spec.md | 04-6 | 所有 `/api` 路由都要令牌，只有 `/health` 公开。 | eacbot-core `src/http.ts:1280-1296,1298-1347,1349`；clean-core `request-auth.ts:32-58,302-330` | 部分成立 | `/` 是公开 HTML；`/api/hooks/:id` 绕过统一令牌，另用 per-bot hook token；clean-core 还有大量公开路由。 |
| plan/04-core-spec.md | 04-7 | 服务只监听 `127.0.0.1`。 | clean-core `server/index.ts:15506`；eacbot-core `src/server.ts:102,258` 用 `EACBOT_HOST` 覆盖，默认才回 `127.0.0.1` | 部分成立 | clean-core 命中；04 所描述的实现允许 `EACBOT_HOST` 覆盖，“只绑”这个绝对条件被省略。 |
| plan/04-core-spec.md | 04-8 | 令牌用常量时间比较，不写进日志。 | eacbot-core `src/auth.ts:51-60`；clean-core `server/request-auth.ts:555` | 成立 | 两处都是常量时间比较；eacbot-core 比较摘要而非原文，结论不变。未做全仓日志穷举。 |
| plan/04-core-spec.md | 04-9 | `store` 对外提供 createBot、getBot、listBots、createThread、appendMessage、listMessages。 | eacbot-core `src/store.ts:105-134` | 成立 | 六方法逐项命中；接口比清单多 8 个方法，原结论是不完整清单，不是错误。 |
| plan/04-core-spec.md | 04-10 | `store` 不做级联删除。 | eacbot-core `src/store.ts:119-124`；clean-core `server/store.ts:1465-1503` | 不成立 | `deleteBot` 删除 bot 的全部 threads 和 message logs，`deleteThreadWithMessages` 删除整条线程及消息；接口注释和实现都做级联删除，与同表“不做什么”矛盾。 |
| plan/05-remaining-capabilities.md | 05-1 | Webhook 默认只听 `127.0.0.1` 的 `/hooks/:id`，先验 secret 再读 256 KiB，成功 202，按 delivery id 去重，每钩 10 次/分钟、最多 3 个待办，事件与指令分开。 | `server/webhook-ingress.ts:8,107-138,172-176`；`server/webhooks.ts:93-104,290-326,641-655` | 成立 | 数字和顺序全部命中；报告引用的 `webhooks.ts:206-245` 实际是 key 文件和 cleanInput，202 在 ingress:138、去重在 641-655。 |
| plan/05-remaining-capabilities.md | 05-2 | 每 bot+文件夹一个影子 git，GIT_DIR 指数据目录、GIT_WORK_TREE 指工作目录，派发前 snapshot，回复后 diff，3 秒超时，pin 防回收；没有按回合回滚。 | `server/checkpoints.ts:1-9,19,25-105,151-177,179-182,464-493,515-545`；`server/index.ts:8342,5510-5583,5570` | 部分成立 | 机制和 3 秒均成立；报告引用的 `index.ts:8317-8324` 实际是 peer roster/电脑挂载，snapshot 在 8342；GIT 命令超时是 120 秒（checkpoints.ts:110），3 秒是回合后 diff 的 race 超时；GIT_DIR 实际指向 `data/checkpoints/.../.git`。 |
| plan/05-remaining-capabilities.md | 05-3 | 房间是 group+共享 thread，auto 路由 1.5 秒、置信度 0.6，成员回合串行排队，RoomMemberLock 防重复，每回合最多 3 条房间发言。 | `server/decider/room-routing.ts:4-10,83-103`；`server/room-member-lock.ts:5-39`；`server/index.ts:1630,14024-14025`；`server/host/room-transcript.ts:11,34-75` | 部分成立 | 1.5 秒/0.6、锁、3 条上限均命中；`server/room-queue.ts:10-50` 只是把队列项排成 UI 行，不含“串行排队”调度，真正排队在 index.ts 的房间回合操作里。 |
| plan/05-remaining-capabilities.md | 05-4 | 模型目录向 provider 的 `/models` 要列表（8 秒），models.dev 补元数据（24 小时缓存、ETag/304、10 秒、20 MB、启动 6 小时缓存），只收 `tool_call=true`。 | `server/drivers/openai-compat.ts:200-288`；`server/model-catalog/catalog.ts:43-48`；`server/model-catalog/trim.ts:133-151`；`server/startup-model-catalog.ts:11-20` | 成立 | 所有数字和条件命中；`/models` 还分 LM Studio `/api/v1/models` 和 provider `baseUrl+/models` 两路，文档提及前者，未提额外过滤，属省略。 |
| plan/05-remaining-capabilities.md | 05-5 | 只给 Claude 订阅登录保活，缓存 1 小时，50 分钟 ping，少于 5 万上下文不 ping，写入超过读取 10% 判冷并停止，忙时 60 秒重试，默认窗口 180 分钟。 | `server/cache-keepwarm.ts:13-20,60-62,86-146,159-181` | 成立 | 数值和停止条件逐项命中；`write 小于 0.1*read` 才算暖，等于 10% 也会停，文档“超过 10%”在边界上少说了“等于”。 |
| plan/05-remaining-capabilities.md | 05-6 | 用量按月追加 JSONL（0600），一行一次调用，记 bot/model/instance、input/output/cached、cost、trigger、turnId、parent、工具次数，不存正文；`/api/usage` 支持 7 种聚合和 CSV，范围最多 366 天；span 存 90 天；未定价 cost 为 null。 | `server/usage-ledger.ts:1-2,82,99-105,111-142,197-211`；`server/routes/usage.ts:41-100`；`server/usage-trace/spans.ts:39,76-99`；`server/model-prices.ts:10-17` | 成立 | 字段、0600、366 天、90 天、7 种 groupBy 和 cost=null 均命中；`/api/usage` 还分 `/metering` 等路由，聚合键不完全相同。 |
| plan/05-remaining-capabilities.md | 05-7 | 7 种 TTS，speak 返回音频；prepare 把 Markdown 变可朗读文本并按句切分（首块 90 字）；speak 单次最多 500 字；transcribe 只收 WAV、上限 12 MB、只认 Fish key。 | `server/tts/index.ts:11,178-230`；`server/routes/tts.ts:15,26-34,60-65,89-100`；`server/tts/speech-text.ts:96,100-138` | 成立 | 7 种、90 字、500 字、12 MB、WAV/Fish 全部命中；`speech-text.ts` 的默认 maxChars 是 320，500 是路由层硬上限。 |
| plan/05-remaining-capabilities.md | 05-8 | 图片理解已在核心落地：vision 开关，png/jpeg/gif/webp，10 MiB 上限，当前消息最多 5 张；历史重放最多 8 张/20 MiB；上游额外是 10 张/40 MB 和视频抽帧。 | eacbot-core `src/config.ts:39`、`src/attachments.ts:9,14-30`、`src/limits.ts:4-5`、`src/turn.ts:521-555`；clean-core `server/turn-images.ts:11-13,167-169,193-215` | 部分成立 | eacbot-core 的 8/20、5 张、`[history images truncated]` 命中；clean-core 恰好是文档所说的“上游”10 张/40 MB + 视频抽帧，没有 8/20 分支。05 把两套实现混在一句里。 |
| plan/05-remaining-capabilities.md | 05-9 | 会话检索用 SQLite FTS5，messages/memory 建虚拟表和触发器，MATCH+bm25 排序、snippet 高亮，支持 all/any。 | `server/message-db.ts:117-143,737-759,824-836,963-981` | 成立 | 表、触发器、排序、片段、all/any 均命中；报告引用 `:110-142` 起点略早，110 是缺 FTS5 的诊断，实际建表从 117 开始。 |
| plan/05-remaining-capabilities.md | 05-10 | 联网检索走 treg：x_search 抓 X，research_search/research_call 查端点再调用，单次最多 10 个结果、50 条帖子、约 22k 字符、35 秒超时，没 key 或套餐关闭就拒绝。 | `server/research.ts:12,149-162`；`server/x-research.ts:14,23,28`；`server/drivers/agents-research-tools.ts:36-95` | 部分成立 | 四个数字都存在，但不是同一条调用：10 是 research_search 的端点上限，50/22k/35s 是 X 搜索的帖子/字符/超时；文档把它们并列成“单次”限制，范围被合并。 |

小结：30 条中成立 11 条、部分成立 18 条、不成立 1 条。最关键的是 04-10：规格明确写“不做级联删除”，两套实现却都做级联删除，属于会误导实现者的硬错误；其次是 04/05 混用了两套代码（eacbot-core 与 EACbot），引用前必须确认对象。

## 五、`docs/cleanse/02-backend-gates.md`

抽查时（约 12:40）发现工作树正在被并行修改：`server/request-auth.ts` 在 12:22 新增了“同源本机页面按 owner 放行”的分支，`bot-thread-limits` 和 `image-daily-cap` 也已接入配置。因此 02 号报告里的“写死”判断有几条已经过时，下表按**抽查时的当前工作树**记录，并保留报告原行号以便对照。

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 02-backend-gates.md | G-01 | HTTP 服务只绑定 `127.0.0.1`，局域网或公网不能直连。 | `server/index.ts:15506` | 成立 | 行号无偏移：15506 行确为 `server.listen(PORT, "127.0.0.1")`；index.ts 的 mtime 为 12:12，早于报告 12:15，未被并行改动。 |
| 02-backend-gates.md | G-02 | 非回环请求没有有效会话一律 403，远程设备必须先配对。 | `server/request-auth.ts:647-652`（报告 `:643`） | 成立 | 行号漂移：报告 `:643` 现为分支右括号，实际 403 在 `:647-652`，分别覆盖代理和非回环 Host；结论不变。 |
| 02-backend-gates.md | G-03 | 回环来源的浏览器也必须先登录，直接打开本机 UI 会 401；开发信任开关仅在源码开发且 owner 信任时生效。 | `server/request-auth.ts:622-626,155`（报告 `:619`、`:155`） | 部分成立 | 行号漂移 +3 至 +7：`:619` 现为注释，401 在 `:622-626`。12:22 工作树新增同源本机页面按 owner 放行（`:623-626`）；地址栏直开因 `sec-fetch-site=none` 仍 401，但“浏览器也必须先登录”已不再绝对。 |
| 02-backend-gates.md | G-08 | 会话 30 天过期，续期最长 180 天。 | `server/sessions.ts:24-26` | 成立 | 行号无偏移：24、26 行确为默认 30 天和 180 天。30/180 是默认值，`EAC_SESSION_TTL_DAYS`、`EAC_SESSION_MAX_DAYS` 可改，`daysMs` 允许 1 至 3650 天，“最长”仅指默认。 |
| 02-backend-gates.md | G-09 | 同一来源 60 秒内失败 10 次锁定 60 秒。 | `server/sessions.ts:34` | 成立 | 行号无偏移：`LOCKOUT = { failures: 10, windowMs: 60_000, lockMs: 60_000 }`，三个数字均一致。 |
| 02-backend-gates.md | G-18 | Starter Cloud 最多 5 个 bot，第 6 个创建返回 409。 | `server/host/starter-bot-limit.ts:6,31`；`shared/bot-limit.ts:9-10`；`server/routes/bots-create.ts:193-194` | 部分成立 | starter 文件行号无偏移；5 只计非 `defaultBot`、非隐藏、未迁走的 bot，默认 EACbot 不计。按普通 bot 计是第 6 个触发 409，按总数计是第 7 个；409 在 `bots-create.ts:194`，报告省略该条件。 |
| 02-backend-gates.md | G-30 | 每个 bot 最多 16 个并发线程，内存很小时最低 3。 | `server/bot-thread-limits.ts:8,18,22-28`；`server/config.ts:327` | 部分成立 | 行号漂移：报告 `:6` 现为空行，`:16-17` 为空白和注释；16 在 `:8`，默认值和最低 3 在 `:22-28`。12:21 工作树新增 `limits.botThreads`（上限 1024，config.ts:327），16 已降为默认上限，配置后可超过 16。 |
| 02-backend-gates.md | G-33 | 每个安装每天最多生成 50 张图，计数落盘、重启不清零。 | `server/image-daily-cap.ts:11,31`；`server/config.ts:329` | 部分成立 | 行号漂移：报告 `:9` 现为空行，`:24-25` 为接口结束和空行；50 在 `:11`，实际取值在 `:31`。12:22 工作树已接 `config.json limits.imagesPerDay`（1 至 1000000），50 只是默认值，“写死、改可配置”的建议过时；计数落盘与重启不清零仍成立。 |
| 02-backend-gates.md | G-42 | 本地 VM 最多 8 个，默认值列也写 8。 | `server/local-vm-settings.ts:5,7,17` | 部分成立 | 行号无偏移：`:7` 是上限 8，`:5` 默认是 2，`:17` 取值用默认 2。报告“最多 8 个”成立，但默认列写 8 与默认值不符。 |
| 02-backend-gates.md | G-51 | OpenAI-compat 回合最长等待 60 分钟，超时中止。 | `server/drivers/openai-compat.ts:88,328`；`server/drivers/openai-chat.ts:272-277` | 部分成立 | 行号无偏移：`:88` 的 60 是 `replyWaitMinutes` 配置上限，`:328` 将其用作流式空闲计时；未设置时默认 `idleTimeoutMs()` 为 180000ms（3 分钟），不是整回合 60 分钟总时限。 |

小结：10 条中成立 4 条、部分成立 6 条、不成立 0 条。最大问题是报告把“默认值”和“硬上限”混写（G-18/G-30/G-42/G-51），以及抽查期间正好有并行修改把 G-03、G-30、G-33 的结论改旧了；落地前必须重新核对当前工作树。

## 六、`docs/cleanse/05-license.md`

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 05-license.md | C07 | 删除 enterprise 目录后无入口返回 oss；设了 key 但无层时也返回 oss 并带 notice。 | `server/enterprise.ts:52,113-129`（关键分支 126-129） | 成立 | 本文件自 781c57e 未改，行号未漂移；52 行初值、126-129 行无入口与 notice 条件均一致。 |
| 05-license.md | C14 | `entitled` 只认 `current.features`，未知 id 一律 false。 | `server/enterprise.ts:193-195`（expired 在 160-163） | 部分成立 | 本文件未改，行号未漂移；194 行先判 `!expired(now)` 再查 features，许可证过期后即使 features 含该 id 也返回 false；原句省略了过期条件。 |
| 05-license.md | C20 | hosted 时禁用 pairing 和 email；workspaceAccess 为空时 hosted 路由 503，远程根路径也 503；本地 loopback 仍可回退。 | `server/index.ts:12670-12678`（会话级另见 12529-12530） | 部分成立 | index.ts 自 781c57e 仅 2846 行 1 行替换且行数不变，12670-12678 未漂移；但 403 只覆盖 12671-12672 的 5 个 POST 路径，503 只覆盖 `/api/auth/hosted/*`、`/pair` 和非 loopback 或 proxied 的 `/`（12676），会话级 503 另在 12529-12530；loopback 只放行根路径，pairing/email 仍 403，不能算完整本地回退。 |
| 05-license.md | C22 | `/api/fleet` 要求 entitled admin，否则 403；没有 socket 时 404。 | `server/routes/status.ts:82-86` | 成立 | status.ts 未改，行号未漂移；84 行 403、86 行 404 与原文一致。 |
| 05-license.md | L03 | 只有 budgets entitlement 且 `monthlyUsd` 为有限正数才计算 spend 状态。 | `server/spend.ts:80-81` | 成立 | spend.ts 未改，行号未漂移；81 行同时检查 `isEntitled("budgets")`、`typeof number`、`Number.isFinite` 和 `>0`。 |
| 05-license.md | L06 | spend 超限时抛 status 409、code `spend_cap`。 | `server/spend.ts:106-111` | 成立 | spend.ts 未改，行号未漂移；106-107 行先取 `spendState`，state 为 null 或未超限直接返回，108-111 行才抛 409 和 `spend_cap`。 |
| 05-license.md | A11 | `operatorPrices` 只有 billing entitlement 且价格表非空才返回。 | `server/index.ts:1367-1368` | 成立 | 1367-1368 未受 2846 行替换影响，行号未漂移；1368 行先 `entitled("billing")`，再要求 `cfg.billing.prices` 且 `Object.keys` 非空。 |
| 05-license.md | C25 | CI 删除 enterprise 后跑 typecheck、两个测试、带假 key 启动并断言 oss（`ci.yml:417-443`）。 | `.github/workflows/ci.yml:417-447`（typecheck 436、测试 437、启动 441-443、断言 445-447） | 部分成立 | ci.yml 未改，作业行号未漂移；typecheck 在 436、两个测试在 437、带假 key 启动在 441-443，但“断言 oss”在 445-447（grep edition 和 no enterprise layer），引用 417-443 少了 4 行。 |
| 05-license.md | A34 | `billing.prices` 按模型 key 存 input、output、cached input 价格，每项 0 到 1,000,000；config.ts 引 373-388,487。 | `server/config.ts:373-388`（schema）、`:503`（AppConfig，当前工作树） | 部分成立 | config.ts 工作树因新增 `limits` 段整体后移 15 行；billing schema 当前 373-388 与原文一致，但 AppConfig 的 billing 当前在 503，487 是 HEAD/基线行，同一单元格混用了当前行和基线行。 |
| 05-license.md | Q11 | 同一订阅 engine 的不同账号不能互相接管；只有不同 engine 或 pay-per-use 才能接管。 | `server/limit-failover.ts:22-26`（放行分支 24） | 部分成立 | limit-failover.ts 未改，行号未漂移；23 行拒绝同实例，24 行对“不同 driver 或 from 非订阅驱动”直接放行，25 行才要求 `billsEachUse`；非订阅来源的同一 driver 不同实例也可接管，原句未覆盖 24 行后半条件。 |

小结：10 条中成立 5 条、部分成立 5 条、不成立 0 条。偏差集中在“省略过期条件”“省略 403/503 的精确路径范围”“当前行号与基线行号混用”，没有发现方向性错误。

## 七、`docs/cleanse/03-frontend-gates.md`

这份报告的 B01/B02/B03 在抽查时已经被并行小组改掉：`ChiefIntro` 新增了 `onLater`，`SettingsModal` 去掉了桌面端的 `!window.ogb`。因此报告描述的“781c57e 基线”成立，但“当前仍然强制/隐藏”已经不成立；下表同时给出两个口径。

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 03-frontend-gates.md | F01 | 未登录或未被信任的浏览器只显示 PairPage，属 A 类显示门，由后端在 `request-auth` 中拒绝。 | `src/main.tsx:45-49`；`src/lib/session.ts:43-45`；`server/request-auth.ts:619-643`；`server/index.ts:12825-12831` | 成立 | 行号一致；`main.tsx:49` 的桌面 `/home` 分支用 `SignedOutAtHome` 包住 PairPage，并非直接渲染 PairPage；cookie/session 与 scope 细分在 `request-auth.ts:563-596`，远程拒绝在 647-653，报告只列 loopback 段，但 A 类判断有依据。 |
| 03-frontend-gates.md | F02 | loopback 为 service trust 时仍要求配对，前端只检查 `session.trust === "service"`，属 A 类。 | `src/main.tsx:52-54`；`server/request-auth.ts:623-636`（trust 赋值在 642）；`server/index.ts:12829-12830` | 部分成立 | `main.tsx` 行号一致；`request-auth` 引用段止于 636，实际返回 `trust:"service"` 在 642，少 6 行；结论成立但引用范围不全。 |
| 03-frontend-gates.md | F04 | 企业版 Settings→Workspaces 与 `/api/fleet` 受 admin entitlement 和 `fleet.available` 双重门控，属 A 类。 | `src/components/WorkspacesSection.tsx:27-29`；`src/components/SettingsModal.tsx:204`；`server/routes/status.ts:82-86` | 成立 | 行号一致；后端在 `fleetAvailable=false` 时还返回 404（`status.ts:86`），报告只写 403，属条件省略，不影响 A 类判断。 |
| 03-frontend-gates.md | F05 | 预算卡和售价表仅在 budgets/billing entitlement 下渲染，后端 `spendState` 与价格列表同样受限，属 A 类。 | `src/components/UsageBudget.tsx:25-27,197-203`；`server/spend.ts:80-81`；`server/index.ts:11812,1368` | 部分成立 | `spend.ts:80-81` 与前端 197-199 一致；但 `configStatus()` 在 `index.ts:11812` 无条件返回 `billing.prices`，1368 的 `entitled("billing")` 只用于 metering 价格，并非 UI 售价表门；所以“价格列表仅在 billing 下返回”不成立，A 类对预算卡成立、对售价表缺后端拒绝点。 |
| 03-frontend-gates.md | F06 | Starter 的 Bot 上限在创建前弹升级框，服务端 `bots-create` 的 `botLimit.refusal` 兜底，属 A 类。 | `src/lib/bot-limit.ts:23-33`；`src/state/store.tsx:2607,2621`；`server/routes/bots-create.ts:193-194`；`server/host/starter-bot-limit.ts:30-40`；`server/index.ts:11797` | 部分成立 | `new-bot.ts:8` 只是 `isBotLimitRefusal` 的 import，创建前拦截实际在 `store.tsx:2607/2621`；`bots-create.ts:192` 是注释，`refusal` 在 193-194，偏移 1-2 行；A 类判断成立。 |
| 03-frontend-gates.md | F10 | Cloud guest 只能在 `openedThreads` 内发言，前端读服务端 session，并非本地写死，属 A 类。 | `src/lib/cloud-guest.ts:11-14`；`src/components/ChatView.tsx:828,1278-1292`；`server/index.ts:12843` | 成立 | 行号基本一致；`ChatView:1278-1292` 是 composer 条件，报告写到 1293，多含下一段引用工具条的起始；`cloudGuest/openedThreads` 由 `/api/auth/session` 返回。 |
| 03-frontend-gates.md | B01 | 首次运行强制完成 Chief 选择/创建，ChiefIntro 无 Skip，WelcomeGate 全屏挂载，属 B 类。 | `src/components/onboarding/WelcomeFlow.tsx:108-121,155-172`；`ChiefIntro.tsx:190-205`；`MeetScreen.tsx:113-117`；`WelcomeFlow.tsx:166` | 部分成立 | 781c57e 下成立；当前工作区未提交改动新增 `data-chief-later`/`onLater`（`ChiefIntro:200-205`、`WelcomeFlow:171-172`），可跳过，因此“强制”说法不再成立；`ChiefIntro` 引用 184-193 已漂移到头像/标题；`MeetScreen` 的 Later 仅在 `signingIn` 时显示（112）；`fixed inset-0` 在 `WelcomeFlow:166`，不在 `WelcomeGate:73-84`。 |
| 03-frontend-gates.md | B02 | 桌面端隐藏 Settings→People，条件是 `!window.ogb && cloudHome !== true`，属 B 类。 | `src/components/SettingsModal.tsx:205`；`server/index.ts:12941-12942`；`src/components/PeopleSection.tsx:202` | 部分成立 | 781c57e 下条件确为 `(!window.ogb && cloudHome !== true)`；当前工作区未提交改动已改为 `cloudHome !== true`，205 行号未漂移但条件变了，桌面端不再因 `window.ogb` 隐藏 People；后端引用一致。 |
| 03-frontend-gates.md | B03 | 桌面端隐藏 Settings→Activity，条件是 `!window.ogb && ownerOrAdmin === true`，属 B 类。 | `src/components/SettingsModal.tsx:206`；`server/routes/status.ts:182-212`；`src/components/ActivitySection.tsx:67` | 部分成立 | 781c57e 下成立；当前工作区把 206 行改为 `ownerOrAdmin === true`，去掉 `!window.ogb`，行号未漂移，桌面 owner 已可见 Activity；后端 182-212 与 `ActivitySection:67` 一致。 |
| 03-frontend-gates.md | B04 | attention 等非 free 状态不能从应用内重新订阅/购买，`buyOfferAllowed` 只允许 signed-out/free，属 B 类。 | `src/lib/cloud-plan.ts:48-50,360`；`src/components/CloudAccountSettings.tsx:268,298,303`；`src/components/CloudAddDialog.tsx:267`；`electron/cloud-account.mjs:427-431` | 成立 | 48-50、268、267 行号一致；attention 实际落到 `cloud-plan.ts:360` 的 default settings，334-341 是 paid 分支，引用段与 attention 不完全对应但不影响结论；`openCheckout` 只查 connected+grant，未查 `entitlement.active`；Settings 仅在 advanced 模式传 `onAddCloud`（`SettingsModal:335`），Simple 模式本就不显示该按钮。 |

小结：10 条中成立 4 条、部分成立 6 条、不成立 0 条。最需要注意的是 B01/B02/B03 已经在本轮被并行修掉：报告作为基线记录有效，但不能再当“当前待办”使用。

## 八、`docs/cleanse/04-cloud.md`

抽查时仓库已经有了新提交 `b5ca7fd`（12:18“默认关闭三项外连”），工作树还有多项未提交修改。04 号报告的第 10 条正是被这个提交改旧的：它写的是“当前工作树”，但头部仍标 `781c57e`。

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 04-cloud.md | C-01 | 启动处 `CLOUD_HOME` 由 `cloudHomeConfiguration(CLOUD_ENV)` 取得，无 Cloud 变量时为 null 且不抛错。 | `server/index.ts:697`；`server/cloud-home.ts:49-51,70-71` | 成立 | 行号零漂移，697 行内容逐字一致；index.ts 未被工作树修改，`b5ca7fd` 只改了 2843 行。 |
| 04-cloud.md | C-02 | `control-client` 的 url/token 默认空串，`configured = Boolean(url && token)`，未配置时 `state()` 不发请求、直接返回 `DISENGAGED`。 | `server/control-client.ts:60-61,65,46,96-97` | 成立 | 行号零漂移；早退实际落在 96-103 区间的第 97 行，报告只给区间；该文件未被工作树改动。 |
| 04-cloud.md | C-03 | Cloud power 在 `CLOUD_HOME` 下每 5 秒 tick 一次，证据行 154-161。 | `server/cloud-power.ts:57,154,160` | 成立 | `TICK_MS = 5_000` 在 57 行、`setInterval(tick, TICK_MS)` 在 160 行；报告区间覆盖 tick 与定时器但漏掉常量行；文件未被改动。 |
| 04-cloud.md | C-04 | Connected Apps 注册失败按 30 秒到 30 分钟退避重试。 | `server/cloud-connected-apps.ts:20,106-108` | 成立 | 数组 `30_000` 至 `1_800_000` 与“30 秒到 30 分钟”一致，20 与 104-110 无漂移；报告省略了每档最多叠加 20% 抖动、最后一档重复这两点。 |
| 04-cloud.md | C-05 | Fleet agent 把 socket chmod 0660 并 chown 给 operator 组（205-219）。 | `server/fleet-agent.ts:214-219` | 成立 | 行号一致，chmod 在 214、chown 在 217；报告省略了 chown 仅在传入 `options.group` 时执行（215），未传时只剩 0660。 |
| 04-cloud.md | C-06 | `cloud-send-verify` 自述持有 owner session 者可离线猜弱密码，并对密码/TOTP 做 HMAC 指纹。 | `server/cloud-send-verify.ts:5,15,18-27` | 成立 | 第 5 行注释与 23、26 行实现一致；报告区间 17-27 未含 15 行的 `fingerprint`，HMAC 的密钥是桌面主进程选定的 nonce（第 2 行）。 |
| 04-cloud.md | C-07 | 托管公司模型把 Claude/Codex/OpenRouter 的 base URL 指到 `EAC_ADMIN_URL/api/gateway/<workspace>`（80-93）。 | `server/hosted-models.ts:38,83,90,95` | 部分成立 | `base` 实际在 38 行定义，80-93 只覆盖 Claude（83）与 Codex（90），OpenRouter 在 95 行，超出给定区间；基址还各接 `/anthropic`、`/openai/v1`、`/openrouter/v1`，凭据是 `EAC_HOSTED_MODEL_TOKEN`（37）。 |
| 04-cloud.md | C-08 | shared Local VM 固定发布 `127.0.0.1:6080`，默认 `VNC_PW=CHANGE_ME`（64-70,826-905,1219）。 | `server/container-computer.ts:53,64-70,827,902-906,1219` | 成立 | 6080 常量在 53 行，64-70 是引用它的 shared target；容器内端口为 6901（52），宿主 6080 仅绑 `127.0.0.1`（905-906），1219 行确实传 `"CHANGE_ME"`。 |
| 04-cloud.md | C-09 | 共享电脑借用者不能超过 900 秒命令上限（37-59,360）。 | `server/shared-computers.ts:44,49-50,59,380-382` | 部分成立 | 900 只是 `timeout_seconds` 的 schema 上限（44）；生效还需桌面注册 `commandTimeouts`（59），旧桌面限 240 秒（50、380-382），默认 120 秒（49），未注册时整单 45 秒（59）；360 行附近是排队与作用域检查，不是上限判定。 |
| 04-cloud.md | C-10 | 更新检查只有显式 `EAC_UPDATE_CHECK_URL` 才发请求（11-20,108-120）。 | `server/update-check.ts:7,11-20,110,114` | 部分成立 | 当前工作树成立；但报告头写的 HEAD `781c57e` 已过时，现行 HEAD `b5ca7fd`（12:18“默认关闭三项外连”）才引入该开关。基线第 5 行写死 `https://api.github.com/repos/milind-soni/EACbot/releases/latest`、第 95 行无条件请求，11-20 整段在基线不存在；文件 mtime 12:19:09，晚于报告采集。 |

小结：10 条中成立 7 条、部分成立 3 条、不成立 0 条。04 的主体描述可靠；最需要修的是头部 HEAD 与“当前工作树”不一致，以及 C-07/C-09 的引用范围不完整。

## 九、`docs/cleanse/06-account.md`

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 06-account.md | C01 | 邮箱白名单为空时 `signInEnabled()` 返回 false，`/api/auth/email/start` 与 `verify` 返回 404。 | `server/account-signin.ts:33-35`；`server/routes/email-sign-in.ts:29-31`；`server/index.ts:681-683,798-800` | 成立 | 行号未漂移；404 之前还有两道门：Cloud home 先 403（`email-sign-in.ts:20-22`），非 `application/json` 先 415（`:24-27`），报告省略了这两个前置条件。 |
| 06-account.md | C02 | `@domain` 后缀或精确地址匹配，admins 得 admin+client、members 仅 client，环境变量覆盖配置文件。 | `server/account-signin.ts:24-31`；`server/config.ts:340-341,815-818`（基线 781c57e 为 326-327,792-795） | 部分成立 | 匹配与 scope 逻辑完全一致；但行号漂移：工作树新增 `limits` 配置块后，signIn schema 由 326-327 移到 340-341（+14），环境变量覆盖由 792-795 移到 815-818（+23）；config.ts 仍处于未提交修改状态。 |
| 06-account.md | C03 | 未设 SMTP 时邮箱登录走控制面，`isPackaged:true` 使自建服务器也默认连 `https://accounts.eacbot.com`。 | `server/account-signin.ts:56-68`；`electron/companion-account-service.mjs:18,74-82` | 成立 | 行号一致；`account-signin.ts:64` 硬编码 `isPackaged:true`，默认常量确为 `https://accounts.eacbot.com`；`EAC_CONTROL_PLANE_URL` 优先，非 https 时返回空串并在 `:65` 抛错。 |
| 06-account.md | C08 | hosted 访问依赖 enterprise 层与 admin entitlement，层或授权缺失时返回 503。 | `server/enterprise.ts:107-110`；`server/index.ts:15452,12797-12801`；`enterprise/server/workspace-access.ts:17,55,92,152` | 成立 | 行号一致；无层时 `createWorkspaceAccess` 返回 null，`index.ts:12800` 兜底 503；`authorize()` 在 `:151` 对 loopback 直接返回 null，503 只落在 session 请求上（该豁免见报告 L06 与 §3）。 |
| 06-account.md | C11 | 无 `EAC_LICENSE_KEY` 即回落 OSS，到期后有 7 天宽限，未知 feature 一律 false。 | `server/enterprise.ts:37-38,126-129,137,160-163,193-195` | 成立 | 行号一致；7 天由 `LICENSE_GRACE_DAYS=7` 在 `expired()` 中按 `expiresAt` 加 7 天计算，宽限期内 edition 仍为 enterprise 并附 notice；`entitled()` 只查 `features.includes`，未知名必为 false。 |
| 06-account.md | C14 | 非 admin 会话看 `/api/edition` 只得到 features，过期天数、宽限日期和 notice 被剥离。 | `server/routes/status.ts:104-107`；`server/enterprise.ts:186-190` | 部分成立 | 行号一致；实际只剥离 `expiresInDays`、`graceEndsAt`、`notice`，仍返回 edition、customer 和 `expiresAt` 原始到期日，故“只得到 features”偏大。 |
| 06-account.md | L01 | HTTP 主服务只监听 `127.0.0.1`，局域网和公网不能直接访问。 | `server/index.ts:15506`（另 `:15533` 为 Unix socket） | 成立 | 行号一致；唯一的 TCP listen 绑定 `127.0.0.1`；15533 监听 `TUNNEL_SOCKET` 的本地 Unix socket，不是对外 TCP；index.ts 工作树无改动。 |
| 06-account.md | A07 | 会话默认 30 天、最长 180 天，剩余不足一半时续期。 | `server/sessions.ts:24-27,620-634` | 成立 | 行号一致；30 与 180 来自 `EAC_SESSION_TTL_DAYS` 与 `EAC_SESSION_MAX_DAYS` 默认值；`renew()` 对 `token:true` 的脚本会话直接返回 false（`:624`），续期规则只适用于普通会话，上限按 `createdAt` 加 180 天夹取。 |
| 06-account.md | A08 | 配对码 12 字符、60 位熵，默认 5 分钟、最长 24 小时，单次使用。 | `server/sessions.ts:13-16,130-142,195-207,352-366,442-446` | 成立 | 行号一致；60 位是 32 符号字母表乘 12 字符的熵（`:33` 注释亦写 60-bit），不是字符数；24 小时上限仅在 `pairingRequest` 的 `within(60_000, PAIRING_CODE_MAX_TTL_MS)` 强制，`openPairing` 自身不夹取；单次性由兑换时 `splice` 删除保证，兑换失败也消耗该码。 |
| 06-account.md | §1-5 | 普通浏览器无会话访问 `/api/auth/session` 默认返回 401 `BROWSER_SIGN_IN`（HEAD 基线）。 | `server/request-auth.ts:622-627`（基线 619），owner 返回 `:644`（基线 636） | 部分成立 | 行号漂移 +7 与 +8：工作树未提交改动把基线 619 一行扩成注释加分支，401 落在 `:626`，`:636` 的 owner 返回移到 `:644`；同时新增同源 own-page 分支（`:623-625`），自建 owner 下同源页面经 `provesSameOrigin()` 直接成为 owner，不再 401，仅 hosted、桌面壳和跨源页面仍 401；仓库 HEAD 已由 781c57e 前进到 b5ca7fd。 |

小结：10 条中成立 7 条、部分成立 3 条、不成立 0 条。06 的认证/许可事实基本可靠；偏差来自并行修改导致的行号漂移和“只得到 features”的措辞过大。

## 十、`docs/cleanse/07-quota.md`

| 来源报告 | 编号 | 原结论 | 实际代码位置 | 是否成立 | 偏差说明 |
|---|---|---|---|---|---|
| 07-quota.md | Q9 | 月度美元上限只在 budgets entitlement 下生效；超限后新回合返回 409 `spend_cap`；0 或不设视为不启用。 | `server/spend.ts:80-111`；`server/index.ts:7232-7236,7620` | 成立 | `spend.ts:81` 的 `!isEntitled("budgets") \|\| monthlyUsd <= 0` 与结论一致；`index.ts:7620` 才是 `startTurn` 前置检查，7232-7236 只是 directSend 的 409 包装。行号无漂移。 |
| 07-quota.md | A4 | 每回合最多 3 条房间发言；`limits.roomPostsPerTurn` 已声明但未接线（抽查时口径）。 | `server/index.ts:14023-14025,14119`；`server/room-post-budget.ts:36-40`；`server/config.ts:332` | 抽查时成立；`7cac874` 后已不成立 | 抽查时 `roomPostsPerTurn()` 未进 index.ts，14024 仍比较常量 3；`7cac874` 后 :14023-14025 已调用并生效。07 已按最终代码更新。 |
| 07-quota.md | A1 | 安装级每日默认 50 张图；`limits.imagesPerDay` 可配 1 到 1,000,000；按本地自然日计数并写盘，重启不清零。 | `server/image-daily-cap.ts:11,14-16,31,43-56`；`server/config.ts:329`；`server/routes/image-tools.ts:78,137` | 成立 | 50 和 1..1,000,000 均吻合；localDay 用本地 `getFullYear/getMonth/getDate`，写 `image-generation-day.json`。行号无漂移；`image-daily-cap.ts` 于 12:22 刚被改过，50 与 `quotaLimits()` 动态读取仍在。补充：settle 写盘失败只 `console.warn`（`:53-54`），会少计而非清零。 |
| 07-quota.md | C18 | 每 bot 默认并发线程 16；`threads.maxConcurrentPerBot` 与 `limits.botThreads` 都可配到 1024；普通本地按内存算默认；Starter 强制 1、子线程放行 16。 | `server/bot-thread-limits.ts:8,10,26-27,31-39`；`server/config.ts:306,327` | 成立 | 16、1024、`min(ceiling,max(3,round(mem/2GiB)))` 与 Starter 1/子线程 16 均吻合；`threads.maxConcurrentPerBot` 无默认值，未设置时才走 `defaultBotThreads`。行号无漂移；该文件 12:21 刚改过，数值未变。 |
| 07-quota.md | C20 | 单个 MCP 工具结果默认 8000 字符进上下文；最小 512；0 表示不截断；每 server 可配 0 到 2,000,000；环境变量只校验有限且不小于 0。 | `server/mcp-trim.ts:1,5,167`；`server/mcp-gate-config.ts:24-28,32-39`；`server/mcp-registry.ts:89-94` | 成立 | 8000/512 及 `Math.max(MIN_BUDGET, budget ?? DEFAULT)` 吻合；0 的“不截断”是靠 `hasOwnResultBudget` 要求 >=1 使 `gateRemote` 为 false、直连 server，而不是 trim 函数接受 0。行号无漂移。 |
| 07-quota.md | C16 | 托管容器 PIDs 上限 4096；旧容器正好 512 时尝试原地升级，失败保持 512。 | `server/container-limits.ts:3,5,11-19`；`server/container-computer.ts:559,878` | 成立 | 4096/512 与 `update --pids-limit` 逻辑吻合，`.catch(()=>{})` 确实吞掉升级失败。报告主表只引 `container-computer.ts:878`（创建参数），漏了 `:559` 的实际升级调用；这是引用不全，不是行号漂移。 |
| 07-quota.md | L2 | `eventLogMaxBytes` 配置后，events/、native/ 日志超限裁到最新一半，按行边界切，静默且不删 SQLite。 | `server/config.ts:51-53,308,649-652`；`server/thread-log-rotation.ts:18-27,30-70`；`server/harness/bus.ts:245-249` | 成立 | `capThreadLog` 以 `maxBytes/2` 作为保留窗口，`trimToTail` 从首个换行后续写，符合“半段+行边界”。补充 `:47`：窗口内无换行时直接放弃裁剪，极端单条超长记录会继续保持超限，“裁到一半”不是保证。 |
| 07-quota.md | C1 | 未知模型上下文窗口兜底 128000 tokens；优先 provider 上报、模型目录、模型名推断。 | `server/context-budget.ts:4,7-12` | 成立 | 128_000 与 `reported→catalog→modelContextWindow→默认` 的顺序完全吻合；报告写 `:7-13`，实际函数到 `:13` 的右花括号，覆盖正确。行号无漂移。 |
| 07-quota.md | Q11 | Starter Cloud 最多 5 个 bot，第 6 个返回 409 并提示升级。 | `server/host/starter-bot-limit.ts:6,30-40`；`shared/bot-limit.ts:9-10`；`server/routes/bots-create.ts:192-194` | 部分成立 | 5 是 `STARTER_BOT_LIMIT`，但 `botsTowardLimit` 只数 `!defaultBot && !hidden && !movedTo`；EACbot、隐藏和已迁走的 bot 不计数。因此“最多 5 个 bot”应为“最多 5 个计入计划的 bot”，同一 workspace 加 EACbot 可见 6 个；routes:193 还对 `kept.id` 的迁入 bot 跳过计划检查。 |
| 07-quota.md | C19 | 工具预算元数据最多记 1000 个 bot，超出淘汰最早插入的。 | `server/tool-budgets.ts:3,7-11` | 部分成立 | 1000 正确；但 `:9-10` 先 delete 再 set，已有 bot 每次上报都会移到队尾，`:11` 淘汰的是最久未上报的 bot，不是最早插入的。行号无漂移。 |

小结：10 条中成立 8 条、部分成立 2 条、不成立 0 条。配额数字本身可靠；偏差主要是把“计入计划的 bot 数”写成“bot 总数”，以及把 LRU 淘汰写成 FIFO。

## 十一、汇总

| 来源 | 抽查数 | 成立 | 部分成立 | 不成立 |
|---|---:|---:|---:|---:|
| `00-baseline.md` | 10 | 5 | 3 | 2 |
| `plan/01-boot-chain.md` + `02-minimal-features.md` | 20 | 6 | 14 | 0 |
| `plan/03-coupling.md` + `04-core-spec.md` + `05-remaining-capabilities.md` | 30 | 11 | 18 | 1 |
| `01-backend-egress.md` | 10 | 6 | 4 | 0 |
| `02-backend-gates.md` | 10 | 4 | 6 | 0 |
| `03-frontend-gates.md` | 10 | 4 | 6 | 0 |
| `04-cloud.md` | 10 | 7 | 3 | 0 |
| `05-license.md` | 10 | 5 | 5 | 0 |
| `06-account.md` | 10 | 7 | 3 | 0 |
| `07-quota.md` | 10 | 8 | 2 | 0 |
| **合计** | **130** | **63** | **64** | **3** |

3 条“不成立”分别是：

1. `00-B01`：报告用现在时写“缺少 `node_modules`、基线 BLOCKED”，但依赖早在 12:07 就已安装，报告 12:09 保存时仍在写旧状态。
2. `00-B10`：9 个测试文件合计写成 230；按源码实际计数，HEAD 为 229、当前工作树为 231。
3. `plan/04-10`：规格写“`store` 不做级联删除”，但 `deleteBot` 与 `deleteThreadWithMessages` 都做级联删除，接口注释和实现直接矛盾。

“部分成立”主要集中在四类，不是事实错误，但会误导落地：

- **行号漂移**：计划文档普遍偏 2~38 行；并行修改又让 `request-auth.ts`、`config.ts` 等继续移动。
- **默认值当成硬上限**：Starter 5 bot、线程 16、图片 50、本地 VM 8、OpenAI-compat 60 分钟，都是默认值或配置上限，不是不可改的死数。
- **引用对象混用**：`04-core-spec.md` 描述的是另一套 `eacbot-core/src`，`05` 又把 eacbot-core 的“核心”和 EACbot 的“上游”混在一句里；拿 clean-core 去核对会得到大量“部分成立”。
- **并行修改使结论过时**：`03` 的 B01/B02/B03 已被修掉，`02` 的 G-03/G-30/G-33 也已被改旧；报告应标注采集时间，落地前重新核对。

本轮只读，没有修改源码、没有提交、没有 push。所有行号以 2026-11-14 抽查期间的当前工作树为准；仓库 HEAD 已由 `781c57e` 前进到 `b5ca7fd`，引用前请按符号名复核。


