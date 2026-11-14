# 06 账号与准入审计

采集日期：2026-11-14  
仓库：`D:\workspace\EACbot-clean-core`  
分支：`codex/clean-core`  
审计基线：`781c57e9a6fbf0f504704d358f4c82a1860490c2`（短哈希 `781c57e`；当前 HEAD 已前进到 `b5ca7fd`，正文按基线，漂移见第八节）

**审计范围。** `server/account-signin.ts`、`sign-in-mail.ts`、`admission.ts`、`request-auth.ts`、`sessions.ts`、`login-*.ts`、`bot-logins.ts`、`device-links.ts`、`phone-secret.ts`、`setup-*.ts`、`hosted-contract.ts`、`enterprise.ts`；以及 `server/index.ts` 中的鉴权中间件、配对、`/api/auth`、`/api/signin`、`/api/setup` 路由挂载。另读了 `enterprise/server/workspace-access.ts`，因为 `enterprise.ts` 只定义 hook，真正的 hosted 校验在那一层。

**方法。** 只读静态审计：用 `rg -n` 找入口，用 `git show HEAD:...` 逐段核对真实行号；没有启动服务、没有编译、没有跑测试、没有联网、没有安装依赖。审计开始时 `docs/cleanse/00-baseline.md` 仍写 BLOCKED（依赖缺失）；`08-evidence-audit.md:13` 的抽查发现 `node_modules`、`node_modules/.bin/tsc` 与 `vitest` 已在 12:07 后安装，依赖后来已经存在。即便如此，**本报告仍未编译、未启动、未跑测试**，本文所有“会发生什么”都来自代码分支和错误文案，不等于运行验证。

**重要前提（基线口径）。** 本报告按 **HEAD `781c57e` 的提交内容**审计，行号用 `git show HEAD:...` 核对。采集期间主线程在工作树并行修改了 `server/request-auth.ts`、`server/config.ts`、`server/setup-import.ts`、`src/components/SettingsModal.tsx`、`src/components/onboarding/ChiefIntro.tsx`、`src/components/onboarding/WelcomeFlow.tsx` 等；这些改动不写进正文，正文仍是基线结论，统一列在末尾“工作树漂移（非基线）”。合并到主线后请按符号名复核，不要用当前工作树的行号直接替换本报告。本任务没有编辑、回滚或暂存这些文件，只新建本报告。

**与共享资料的关系。** `01-backend-egress.md` 第 32 条已经记录了邮箱登录默认连 `https://accounts.eacbot.com` 的外连；`02-backend-gates.md` 的 G-02 至 G-13 已经列出回环、会话、邮箱、hosted 和企业许可的主干门；`03-frontend-gates.md` 的 F01/F02/F13 已经说明登录页和 owner/admin 的前端表现。本文不整段重复这些结论，而是补四件事：认证与授权的分层、首次启动的精确状态码、远程注销的实际生效范围、setup 与账号无关的澄清。与主线程结论不一致的地方在“与共享资料不一致”一节单独列出。

## 术语与判定口径

- **认证**回答“你是谁”，例如回环来源、会话 cookie、bearer token、配对码。**授权**回答“你能做什么”，例如 `admin`/`client` scope、`ownerOrAdmin`、`SERVICE_ALLOW`。本文把两者分开，避免把“能登录”误写成“能做管理员”。
- **回环（loopback）**指 `127.0.0.0/8`、`::1`、`localhost` 这类只在本机可达的地址。回环信任的本意是“这台机器的本地调用者”，不是“任何浏览器页面”。
- **会话 cookie**是浏览器自动携带的凭据；**bearer token**是调用方显式放在 `Authorization` 头里的凭据。两者在 `request-auth.ts` 里走不同的校验分支。
- **CSRF**是别的网页借用户浏览器自动带 cookie 发请求；**DNS rebinding**是恶意域名解析到本机后借浏览器访问回环服务；**会话固定**是攻击者预先让受害者使用一个已知会话；**常量时间比较**是避免通过响应时间猜 token。
- 本文的“默认值”指不写 `config.json`、不设相关环境变量时的实际行为；“可配置”指已有环境变量或配置项，不是建议新造一个开关。

## 一、直接回答

### 1）首次启动到能用是否强制登录、建账号、填邮箱？

**结论：不强制建账号，也不强制填邮箱；但“纯浏览器打开 UI”在默认自建服务器上要先配对，桌面壳和源码开发模式例外。** 需要把“启动成功”“浏览器能进 UI”“本地进程能调 API”分开看。

逐步状态如下：

1. **无 `config.json`。** `loadConfig()` 读不到文件时使用默认值，不会因为缺配置退出（`server/config.ts:735-751`）。默认 `signIn` 不存在，因此邮箱登录白名单为空；`signInEnabled()` 返回 false（`server/account-signin.ts:33-35`），邮箱路由即使被访问也返回 404（`server/routes/email-sign-in.ts:29-31`）。
2. **无 `sessions.json`。** `SessionRegistry` 先写 `sessions.json.open` 守卫，再 `load()`；文件不存在时直接返回，会话列表为空（`server/sessions.ts:243-266`）。不会自动创建账号，也不会自动生成会话。
3. **无 `enterprise/` 或无 `EAC_LICENSE_KEY`。** `loadEnterpriseLayer()` 找不到层或没有 key 时回落为 `oss`，features 为空（`server/enterprise.ts:119-150`）。企业层不是启动必需；没有它，hosted workspace 不可用，但普通本地服务照常启动。
4. **没有 Cloud、没有 hosted 环境变量。** `resolveLoopbackTrust()` 在自建默认下返回 `owner`（`server/request-auth.ts:106-107`）。服务只监听 `127.0.0.1`（`server/index.ts:15506`）。
5. **浏览器访问 UI（HEAD 基线）。** 静态页面在鉴权门之前就被服务（`server/index.ts:12694`），所以 HTML/JS 能加载；前端启动时请求 `GET /api/auth/session`（`src/lib/session.ts:34-44`）。在 HEAD 基线上，普通浏览器没有会话，`fromBrowser()` 为真，`desktopOwner` 为假，`trustLocalBrowser` 默认为假，于是 `resolveRequestAuth()` 返回 **401**，错误是 `BROWSER_SIGN_IN`（`server/request-auth.ts:155,619`）；前端把 401/403 当作未登录并渲染 `PairPage`（`src/main.tsx:45-49`）。当前工作树已经加入“同源 own-page owner”分支，见末尾“工作树漂移（非基线）”；不要把那段行为当成 HEAD 基线。
6. **非浏览器本地调用。** `curl`、CLI、Node 脚本不带 `Sec-Fetch-*`，`fromBrowser()` 为假；只要 Host 是回环、没有代理头，就直接得到 `kind: "loopback"`、`scopes: ["admin","client"]`（`server/request-auth.ts:604-636`）。`GET /api/auth/session` 会返回 `{kind:"loopback",scopes:[...]}`（`server/index.ts:12825-12830`）。这是“本地进程即 owner”的默认，不是账号登录。
7. **公开路由的实际状态。** `GET /api/health` 在无会话时返回 200 `{app:"eacbot"}`（`server/index.ts:12787-12789`）；`GET /api/brand` 返回 200（`:12790-12793`）；`GET /.well-known/eacbot/environment` 返回 200（`:12695-12702`）。`POST /api/auth/email/start` 在白名单空时返回 404（`server/routes/email-sign-in.ts:29-31`）；`POST /api/auth/pair` 没有有效码时返回 401（`server/sessions.ts:442-444`；`server/index.ts:12725-12728`）；`GET /api/setup` 没有这个路由，非浏览器回环调用最终落到 404（`server/index.ts:15419`）。
8. **怎样才能“能用”（HEAD 基线）。** `eacbot serve` 的默认 `pair` 是 true（`server/cli.ts:131`），启动后会 mint 一次性配对码并打印本机 `/pair#code=...` 链接（`server/cli.ts:895-900`）；用这个码换 cookie 会话（`server/index.ts:12732-12737`）。也可以 `eacbot pair` 单独生成码（`server/cli.ts:352-363`）。桌面壳由 Electron 注入 `EAC_DESKTOP_PARENT=1` 和每启动一次的 owner header，浏览器窗口自动作为 owner（`electron/main.mjs:1124-1130`；`electron/server-session.mjs:35-43`）。源码开发用 `pnpm dev:server`，它会设 `EAC_DEV_TRUST_LOCAL_BROWSER=1`（`server/dev-server.ts:1-3`），本机浏览器因此暂时按 owner 处理。
9. **直接 `node server/index.ts` 的特殊情况（HEAD 基线）。** 它不会替你 mint 配对码；普通浏览器仍然得到 401，而 `curl` 等本地进程可以直接调 API。要进浏览器 UI，必须用 `eacbot serve`/`eacbot pair` 生成码，或桌面壳，或显式开发信任。当前工作树已允许自建 owner 的同源页面直接作为 owner，见末尾附录。
10. **是否要建账号。** 仓库里没有本地注册或建账号路由；邮箱登录只是向控制面请求 OTP 并验证已有账号（`server/account-signin.ts:71-107`；`server/routes/email-sign-in.ts:41-64`）。没有白名单时连这条路径也不存在。

**首次设置不是账号门槛。** `setup-request.ts` 是“新 bot 的 Setup 卡片”，`setup-mode.ts` 是 `/setup` 提示词改写；它们都不是服务器首次运行向导，也不创建账号（`server/setup-request.ts:1-6`；`server/setup-mode.ts:1`）。真正的前端欢迎流另算：`03` 的 B01 在 HEAD 基线成立；当前工作树已经加了“稍后设置”按钮，见末尾附录。

#### 1.1 首次启动状态码矩阵

下表把“无 config、无 session、无 enterprise”拆成可核对的路由结果。状态码来自静态分支，未实机抓包。

| 请求 | 普通浏览器（HEAD 基线） | 非浏览器回环 | 判定与证据 |
|---|---|---|---|
| `GET /` | 200，返回静态 HTML | 200，返回静态 HTML | 静态文件在鉴权门之前（`server/index.ts:12694`） |
| `GET /api/health` | 200 `{app:"eacbot"}` | 200 `{app:"eacbot"}` | 公开探针（`server/index.ts:12787-12789`） |
| `GET /api/brand` | 200 | 200 | 公开品牌（`:12790-12793`） |
| `GET /.well-known/eacbot/environment` | 200 | 200 | 公开环境描述（`:12695-12702`） |
| `GET /api/auth/session` | 401 `BROWSER_SIGN_IN` | 200 `kind:"loopback"` | 浏览器拒绝（`server/request-auth.ts:619`）；回环 owner（`:636`）；响应形状（`server/index.ts:12825-12830`） |
| `GET /api/config` | 401 | 200，owner 管理视图 | 同一道门；非浏览器回环是 admin+client（`server/request-auth.ts:636`） |
| `POST /api/auth/email/start` | 404（白名单空） | 404（白名单空） | 路由在门前，但 `emailSignIn.enabled()` 为 false（`server/routes/email-sign-in.ts:29-31`） |
| `POST /api/auth/pair` | 401（无有效码） | 401（无有效码） | 公开兑换入口，码不对就拒绝（`server/sessions.ts:442-444`；`server/index.ts:12725-12728`） |
| `GET /api/setup` | 401（浏览器先被门拦） | 404（没有该路由） | 门在前，未知路径 404（`server/index.ts:12794,15419`） |
| `GET /api/setup-import` | 403（非桌面） | 403（非桌面） | `local` 为 false，或不是 owner loopback（`server/routes/setup-import.ts:47-49`；`server/index.ts:12494`） |

这张表说明一个容易误判的点：在 HEAD 基线上，浏览器访问 `/api/setup` 看到的是 401，不是 404；只有非浏览器回环调用越过门之后，才会看到“没有这个路由”的 404。当前工作树的同源 owner 行为见末尾附录。

### 2）哪些路由要会话或令牌？

按“谁在判定”分类，实际存在的是下面九类。注意 `admin` 是授权 scope，不是独立的认证方式；`hosted contract` 只是版本兼容，不是认证。

- **公开（无会话）**：`GET /api/health`（`server/index.ts:12787-12789`）、`GET /api/brand`（`:12790-12793`）、静态文件和 `/.well-known/eacbot/*`（`:12694-12702`）、`POST /api/auth/email/start` 与 `verify`（`:12704-12705`；`server/routes/email-sign-in.ts:17-31`）、`POST /api/auth/pair` 与 `POST /api/pair`（`:12707-12765`）、hosted 的 `/api/auth/hosted/start` 与 `callback`（`enterprise/server/workspace-access.ts:88-148`）。这些公开路由里，邮箱和 hosted 只在对应功能启用时存在。
- **回环信任（loopback）**：`resolveRequestAuth()` 在无会话时先看 Host/Origin/代理，再返回 `kind: "loopback"`；默认自建是 `owner`，hosted/Cloud 是 `service`（`server/request-auth.ts:604-636`；`server/request-auth.ts:85-108`）。`service` 只能走 15 条 `SERVICE_ALLOW`，且 scope 只有 `client`（`:29-55,623-634`）。
- **会话 cookie**：cookie 名由端口和环境 ID 组成（`server/request-auth.ts:257-274`），`SessionRegistry.authenticate()` 校验哈希、过期和个人 scope（`server/sessions.ts:603-617`）。cookie 请求必须同源；跨源返回 403（`server/request-auth.ts:580-587`）。
- **bearer token**：只有 `Authorization: Bearer omb_sess_...` 会被当成会话 bearer（`server/request-auth.ts:250-255,563-571`）；其他 bearer 由具体路由自己解释，例如内部能力令牌（`server/index.ts:13012-13015`）或 Bot API。脚本 token 是 `token: true` 的会话，到期不续（`server/sessions.ts:65-66,458-459,624`）。
- **admin**：`requiredScope()` 默认返回 `admin`，只有 `CLIENT_ALLOW` 里明确列出的方法和路径才是 `client`（`server/request-auth.ts:276-277,431-438`）。`GET /api/auth/sessions` 不在 `CLIENT_ALLOW`，所以只有 admin 能列出会话（`server/index.ts:12941-12942`）。
- **companion**：桌面壳把 `x-openmausbot-companion-auth` 与 `x-openmausbot-companion: 1`、设备 ID 一起校验；通过后直接给 `admin+client` 回环 scope（`server/request-auth.ts:607-615`）。token 初始是空字符串，只有 Electron 通过私有端口发来 43 字符 token 后才可用（`server/index.ts:779-780,1466-1475`；`electron/main.mjs:1089-1095`）。
- **CLI owner**：`eacbot serve` 在 service 信任下把每启动一次的 43 字符 token 从 stdin 交给子进程；它只打开 `/api/auth/pairing` 的 GET/POST（`server/request-auth.ts:513-524,623-629`；`server/index.ts:765-777`）。这是给 CLI 自己配对用的，不是通用管理员 token。
- **stream ticket**：EventSource 不能设 header，所以先用会话换一次性 ticket；ticket 只对 `/api/events` 生效，5 分钟、一次性、每会话最多 5 个、兑换不续期（`server/sessions.ts:32,678-696`；`server/index.ts:12848-12850`）。
- **hosted contract**：`x-omb-hosted-contract-version` 只声明 Admin 与 workspace 的 wire 版本；不携带身份，也不替代 session（`server/hosted-contract.ts:1-14`；`enterprise/server/workspace-access.ts:54-67`）。

#### 2.1 判定函数与适用路由

| 类别 | 判定函数或常量 | 适用的典型路由 | 不通过时 |
|---|---|---|---|
| 公开 | 无门，或功能开关 | `/api/health`、`/api/brand`、静态、`/.well-known` | 功能关闭时 404/503 |
| 回环 owner | `resolveRequestAuth()` 末尾的 `LOOPBACK_SCOPES` | `/api/config`、`/api/bots` 写、设置、日志 | 非回环得到 403 |
| 回环 service | `serviceAllowed()` + `SERVICE_ALLOW` | health、session、edition、brand、bots 列表、guarded 发送、内部能力 | 白名单外 403 |
| 会话 cookie | `parseCookies()` + `sessions.authenticate()` | 所有浏览器 UI 路由 | 401 或 403 |
| 会话 bearer | `bearerToken()` + `omb_sess_` 前缀 | 脚本、CLI、手机 | 401 |
| stream ticket | `redeemStreamTicket()` | 仅 `/api/events` | 401 |
| admin scope | `requiredScope()` 默认分支 | `/api/auth/sessions`、配置、人员、Webhook 创建 | 403 |
| client scope | `CLIENT_ALLOW` 明确条目 | 发消息、任务、例程、显示字段、登录卡 | 403 |
| companion | `x-openmausbot-companion-auth` + 设备 ID | 手机伴侣专用动作 | 403 |
| CLI owner | stdin 43 字符 token + 固定路径 | 仅 `/api/auth/pairing` | 403 或走普通 service |
| 内部能力 | `authorizedInternalCapability()` | `/api/internal/*` | 401/403 |
| hosted contract | 版本头 | 仅 hosted 兼容检查 | 409 或 503 |

这张表里只有前两行是“本地信任”，其余都是显式凭据或 scope。把 `client` 当成“已登录”是不够的：`client` 仍然不能读会话列表、不能改 provider、不能管人。

### 3）本地回环能否免登录？判定顺序是什么？

**在 HEAD 基线：能免登录，但只对“非浏览器本地调用者”默认成立；浏览器默认不行。** 当前工作树已增加“同源 own-page owner”分支，差异见末尾附录；下面先按 HEAD 顺序写。

1. 先看有没有会话凭据：`omb_sess_` bearer、`/api/events` 的 ticket、会话 cookie；有就按会话处理（`server/request-auth.ts:563-578`）。
2. 没有有效会话，但呈现了过期/被撤销的会话凭据时，直接 401，**不会回退成回环 owner**（`:599-602`）。这是重要安全点，防止被移除的成员借本地地址提权。
3. 计算 `proxied`：有 `x-forwarded-*`、`forwarded` 或 IPC peer 就认为不是回环（`:179-183,604`）。
4. 计算 `loopback`：Host 必须是回环，Origin 缺省或必须是回环 HTTP(S)（`:604-605,110-132,157-165`）。
5. 如果请求带 companion token，先走 companion 分支；token 不匹配就 403，不会继续当 owner（`:607-615`）。
6. 计算 `desktopOwner`：只有提供了 43 字符 desktop token，且 `fromOwnPage()` 为真，才算桌面窗口自己的页面（`:617-618,201-205`）。
7. 如果是浏览器且不是 `desktopOwner`，且没有开发信任，返回 401 `BROWSER_SIGN_IN`（`:619`）。当前工作树在这一步之前插入了 `ownPageOwner` 检查，见附录。
8. 如果桌面 token 已启用，且这是“会产生副作用”的公开路由而不是桌面窗口，返回 403（`:620-621`；路由分类在 `:528-549`）。
9. 如果是 service 信任：先看 CLI owner 是否只对 `/api/auth/pairing` 生效；否则只允许 `SERVICE_ALLOW`，返回 `client` scope；不在白名单就 403（`:623-634`）。
10. 其余回环请求返回 owner：`admin+client`（`:636`）。

`EAC_LOOPBACK_TRUST` 的优先级是：Cloud home 强制 `service`；桌面壳强制 `owner`；显式 `owner`/`service` 生效；非空非法值回落 `service` 并警告；hosted workspace 默认 `service`；最后才是自建默认 `owner`（`server/request-auth.ts:85-108`）。空字符串会跳过显式分支，继续走 hosted/默认，不会变成 service。

`EAC_DESKTOP_PARENT=1` 的效果是：`desktopManaged` 为真，回环信任判为 owner，`EAC_LOOPBACK_TRUST` 被忽略（`:91-93`）；同时 `desktopMutationToken` 和 `companionMutationToken` 初始为空字符串，所有浏览器写操作在 Electron 发来 token 前都是 403（`server/index.ts:757-780`；`server/request-auth.ts:617-621`）。Electron 只在 `127.0.0.1:serverPort` 的 http/ws 请求上注入 header，其他 loopback 端口不注入（`electron/server-session.mjs:35-43`）。

hosted workspace 的影响：默认把回环判为 `service`（`:106`），配对和邮箱路由被前置拒绝（`server/index.ts:12670-12672`），每个 session 请求还要过 `workspaceAccess.authorize()`（`:12797-12801`）。**但显式 `EAC_LOOPBACK_TRUST=owner` 会覆盖 hosted 的 service 默认，只打印警告，不硬拒绝**（`server/request-auth.ts:94-100`）。这就是“回环即 owner”的隐式提权：自建/桌面默认开启；hosted/Cloud 默认关闭，但可被环境变量重新打开。

#### 3.1 回环信任组合矩阵

| 环境 | `EAC_LOOPBACK_TRUST` | 最终 trust | 非浏览器回环 | 浏览器回环 | 证据 |
|---|---|---|---|---|---|
| 自建，无 Cloud/hosted | 未设 | owner | admin+client | 401，除非配对/开发信任 | `server/request-auth.ts:106-107,619,636` |
| 自建，无 Cloud/hosted | `service` | service | 仅 SERVICE_ALLOW，client | 401 | `:94-101,623-634` |
| 自建，无 Cloud/hosted | `owner` | owner | admin+client | 401 | `:94-100,619,636` |
| 自建，无 Cloud/hosted | 非法非空值 | service | 仅 SERVICE_ALLOW，client | 401 | `:103-105` |
| desktop，`EAC_DESKTOP_PARENT=1` | 任意值 | owner | admin+client 读，写需 desktop token | 401，除非 desktop token 同页 | `:91-93,617-621`；`server/index.ts:757-780` |
| hosted，任一 `EAC_ADMIN_*` | 未设/空 | service | 仅 SERVICE_ALLOW，client | 401 或门户登录 | `:106`；`server/index.ts:12670-12677` |
| hosted | `owner` | owner，仅警告 | admin+client | 可绕过 portal | `:94-100` |
| Cloud home | 任意值 | service，忽略配置 | 仅 service | 需要 Cloud/配对会话 | `:88-90` |

这张矩阵解释了一个常见误解：在 HEAD 基线，`EAC_LOOPBACK_TRUST=owner` 不是“让浏览器免登录”的开关。浏览器仍被 `fromBrowser()` 挡住，除非另有 desktop token 或开发信任；它真正改变的是非浏览器本地调用，以及在 hosted 上绕过 portal 的回环调用。当前工作树对自建 owner 的同源页面增加了例外，见附录。

### 4）哪些鉴权是安全必需，哪些只是商业账号体系？

**安全必需，建议保留：**

- **防 DNS rebinding**：Host 必须是回环；非回环 Host 直接 403（`server/request-auth.ts:642-645`）。
- **防代理提权**：任何 `x-forwarded-*`/`forwarded`/IPC peer 都不算回环（`:179-183,639-641`）。
- **防 CSRF**：cookie 会话必须同源（`:580-587`）；`cookieOnly` 的浏览器会话做写操作时还必须 `provesSameOrigin()`（`:582-587,207-211`）；配对和邮箱路由只收 JSON，降低跨站表单面（`server/index.ts:12707-12711`；`server/routes/email-sign-in.ts:24-27`）。
- **防跨站 WebSocket**：所有 upgrade 走同一个 `handleRequest()`，因此过同一套 Host/Origin/会话门（`server/routes/upgrades.ts:1-2,35-64`；`server/request-auth.ts:134-141`）。
- **防暴力破解**：配对码同来源 60 秒内 10 次失败锁 60 秒（`server/sessions.ts:34,400-422`）；邮箱验证码 10 分钟、5 次尝试、30 秒重发（`server/sign-in-mail.ts:5-8,89-103`）；hosted start 每来源每分钟 20 次、最多 1000 个 pending（`enterprise/server/workspace-access.ts:12-16,105-117`）。
- **防会话固定**：浏览器 sign-in 换 cookie 时会撤销同一个 cookie 里的旧会话（`server/index.ts:12732-12735`）。普通“配对 + cookie”路径没有这一步，见 A22。
- **token 常量时间比较**：会话哈希、配对码、共享电脑 secret、测试 key 都用 `timingSafeEqual`（`server/request-auth.ts:551-556`；`server/sessions.ts:124-128`；`server/sign-in-mail.ts:96`；`server/shared-computers.ts:205`；`server/index.ts:12955,12973`）。
- **会话存储与会话撤销**：token 只存 sha256，文件 0600，启动写 `.open` 标记；撤销会关流、关 live call、清 provider auth/MCP OAuth（`server/sessions.ts:42-67,243-282`；`server/index.ts:4701-4713`）。
- **默认拒绝的授权**：`requiredScope()` 未列出的路由默认 admin（`server/request-auth.ts:276-277,431-438`）；service 回环只给 15 条白名单（`:39-55`）。

**商业账号/许可体系，不是本地聊天必需：**

- 邮箱 OTP 控制面、邮箱白名单的 admin/member 角色（`server/account-signin.ts:24-35,61-107`）。
- hosted workspace 的 portal/WorkspaceAccess、`EAC_ADMIN_*`、portal membership（`server/enterprise.ts:71-99`；`enterprise/server/workspace-access.ts:34-156`）。
- enterprise 许可、`EAC_LICENSE_KEY`、entitlement、hosted readiness、fleet（`server/enterprise.ts:119-150,193-195`；`server/routes/status.ts:82-86`）。
- Team Cloud 的成员 claim、`revokeMember`、成员手机（`server/sessions.ts:646-667`；`server/cloud-home.ts:208`）。
- 企业共享工作区的 Full access 策略（`server/enterprise.ts:101-105`；`server/index.ts:758-760`）。

**不能混为一谈的：** 配对码本身是本地准入的安全机制，不是商业账号；删除商业账号体系时，可以保留一个“本机配对/本地 token”作为浏览器入口，也可以完全改成 API token。`admin` scope 是授权；`entitled("admin")` 是商业许可；两者都不等于“登录”。

### 5）有没有远程注销、踢下线、撤销设备？

**有，但分三层，生效范围不同。**

- **本地会话层（sessions.ts）。** `GET /api/auth/sessions` 列出会话，`DELETE /api/auth/sessions/:id` 撤销（`server/index.ts:12941-12948`）。撤销会从内存和 `sessions.json` 删除记录、清 stream ticket、触发 `onSessionRevoked`；监听器会清 provider auth、MCP OAuth、浏览器 live、桌面 viewer、SSE 流和 live call（`server/sessions.ts:325-334,669-676`；`server/index.ts:4701-4713,12616`）。**本地离线仍可注销**，因为这是本进程内的注册表操作，不发网络请求。
- **设备链接层（device-links.ts）。** 每个链接的 `live()` 直接查 `sessions.isLive(session)`；路由和 10 秒 ping 都检查，会话被撤销后下一次 ping 会以 `LINK_ENDED` 关闭（`server/device-links.ts:25-27,48-56,85-113`；`server/shared-computers.ts:200-205,281-285`）。共享电脑的 `reap()` 也会删除并 `drop` 链接（`server/shared-computers.ts:195-198`）。生效上限约 10 秒，不是即时。
- **hosted/portal 层（workspace-access.ts）。** 每个已认证请求都 `check()` 一次，另有 10 秒 `revalidate()`；Admin 返回 401 会撤销本地会话，返回 503 只关闭流并拒绝，不撤销（`enterprise/server/workspace-access.ts:70-85,150-162`；`server/index.ts:15454-15456,12797-12801`）。**离线时 hosted 会话不能通过 API 注销**：`POST /api/auth/logout` 在路由之前先过 `workspaceAccess.authorize()`，Admin 不可达时得到 503，根本走不到 `sessions.revoke()`（`server/index.ts:12797-12801,12852-12855`）。这是 A18 的风险。
- **Team 层。** Admin 的签名 claim 变化时，`revokeMember(email, keepRole)` 会结束该成员的 team session，`closeMemberPhones()` 会结束成员自己码开的手机；`revokeMoveIns(bot)` 结束“搬入一个 bot”的临时会话（`server/sessions.ts:488-514,646-667`；`server/cloud-home.ts:208`；`server/cloud-team-policy.ts:286`）。
- **bot-logins / login-store。** 这是第三方网站登录，不是 EACbot 账号。删除保存的登录只影响本机加密文件，不会注销 EACbot 会话；`/api/logins` 也不在 `CLIENT_ALLOW`，默认 admin-only（`server/bot-logins.ts:46-55,97-124`；`server/login-store.ts:1-3,115-155`；`server/routes/logins.ts:77-80`；`server/index.ts:12392`）。
- **hosted-contract。** 没有注销接口；只有版本不兼容时的 409/503，`check()` 会关流但不撤销会话（`server/hosted-contract.ts:1-14`；`enterprise/server/workspace-access.ts:63-85`）。

**生效范围的一个限制（静态推断）：** `onSessionRevoked` 里没有调用 turn interrupt；它关闭流和 live call，但已经进入模型回合的服务器工作不会因为会话撤销而自动停止（`server/index.ts:4708-4713`）。这是“以后不能再请求/看流”，不等于“立刻终止正在跑的回合”。

#### 5.1 撤销能力矩阵

| 对象 | 撤销入口 | 立即效果 | 延迟或缺口 | 证据 |
|---|---|---|---|---|
| 本地 cookie/bearer 会话 | `DELETE /api/auth/sessions/:id` 或 logout | 从注册表删除、清 ticket、关流/live call | 已过门的请求和已开始的回合不自动停 | `server/sessions.ts:669-676`；`server/index.ts:4701-4713` |
| 浏览器 SSE | 会话撤销监听器 | 关 `sseClients` | 客户端可能重连，重连时被 401 | `server/index.ts:4701-4713` |
| 浏览器 live / 桌面 viewer | `closeForOwner` | 关对应 owner 的 live/viewer | 需要下一次监听器触发 | `server/index.ts:4701-4713` |
| 设备链接 | `sessions.isLive()` + `DeviceLinks` ping | 下一次路由或 10 秒 ping 关闭 | 最多约 10 秒 | `server/device-links.ts:25-27,48-56` |
| 共享电脑 | `SharedComputers.reap()` / `authorize()` | 列表下线、链接 drop、任务拒绝 | 保留期内可能仍在内存 | `server/shared-computers.ts:195-205,281-285` |
| hosted 会话 | `workspaceAccess.check()` | 401 撤销；503 阻断 | Admin 离线时不能本地 logout | `enterprise/server/workspace-access.ts:70-85`；`server/index.ts:12797-12801` |
| Team 成员 | `revokeMember()` / `closeMemberPhones()` | 结束 team session、成员手机 | 由 Admin claim 变化触发 | `server/sessions.ts:646-667` |
| 第三方网站登录 | `DELETE /api/logins/:id` | 删除本机加密记录 | 不影响 EACbot 会话 | `server/routes/logins.ts:122-127`；`server/login-store.ts:1-3` |

注意“撤销会话”和“删除保存的网站登录”是两件事：前者结束 EACbot 的访问，后者只清掉浏览器自动填写的第三方凭据。把两者混在一起会导致用户以为注销 EACbot 就删掉了网站密码。

### 6）setup-*.ts 会在无认证时暴露配置或密钥吗？

**不会以“无认证 HTTP”方式暴露；但 setup-import 会读取本机多个 AI 工具的配置，并把 MCP 条目导入到 EACbot 配置。**

- **没有 `/api/setup` 路由。** 全仓 `rg` 没有精确的 `/api/setup` 或 `/api/signin` 路由；实际存在的是 `/api/setup-import`、`/api/setup-import/grok` 和 `/api/bots/:id/setup-request`（`server/routes/setup-import.ts:23-24`；`server/routes/setup-request.ts:25`）。未知路径最终落到 404（`server/index.ts:15419`）。
- **setup-import 的门。** 路由必须同时满足 `deps.local`（只有桌面壳、且不是 Cloud/hosted）、`auth.kind === "loopback"`、`auth.trust !== "service"`，否则 403（`server/routes/setup-import.ts:41-59`；`server/index.ts:12494`）。按当前默认，`eacbot serve` 的 `local` 是 false，所以即使本机 owner 也不能用它。
- **GET 只回报名字。** `detectSetup()` 只返回 `{name, source}` 列表，不返回 MCP 的 URL、headers、env 或密钥（`server/setup-import.ts:691-699`）。
- **POST 会导入。** 它读取 `~/.claude.json` 的顶层 `mcpServers`、Claude Desktop/Cursor/Gemini 的 JSON、Codex 的 `config.toml`，把 MCP 条目规范化并以 `enabled:false` 写入配置；技能只复制 `SKILL.md` 和文本文件，按 `secretName()`、`holdsCredential()` 排除凭据类文件（`server/setup-import.ts:101-122,150-155,316-340,565-581,672,691-699`）。它不把内容上传到网络。
- **没有 setup 专用一次性 token。** 它依赖桌面壳每启动一次的 43 字符 `desktopMutationToken`，该 token 在 Electron 私有端口发来之前是空字符串，所有浏览器写操作 fail closed（`server/index.ts:757-780,1466-1475`；`server/request-auth.ts:617-621`）。`setup-import` 本身没有 nonce/一次性票据；`mcpConfigBusy` 只做单飞，`picking` 只防同一 setup-request 重复发送（`server/setup-import.ts:657-687`；`server/routes/setup-request.ts:31,54-69`）。静态代码没有看到“首次设置竞态窗口”；但这是推断，未实机并发验证。
- **setup-request 不是服务器设置。** 它是新 bot 的“要我先帮你做什么”卡片；`POST/DELETE /api/bots/:id/setup-request` 走 client scope，先 `sendRefusal()`，再 `canSetUp()`，按 `picking` 防双击；取消时 owner/admin 可清别人的（`server/routes/setup-request.ts:25-69`；`server/setup-request.ts:43-80`）。它不创建账号、不写全局配置。
- **setup-mode 没有授权作用。** 它只把 `/setup` 改写成提示词并加 system 段落；注释明确“grants no authority”（`server/setup-mode.ts:1,5-8,19-21,106-108`）。

#### 6.1 setup-import 的读取面

| 来源 | 路径 | 读取内容 | 过滤/处理 | 证据 |
|---|---|---|---|---|
| Claude Code | `~/.claude.json` | 只取顶层 `mcpServers`，不读项目历史 | 上限 256MB；其他成员不解析 | `server/setup-import.ts:96-99,116,594-605` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | 1MB 上限 | `:116-121,594-605` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` | 1MB 上限 | `:117-121` |
| Codex | `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` | `mcp_servers` | 1MB 上限 | `:104-121` |
| Gemini | `~/.gemini/settings.json` | `mcpServers` | 1MB 上限；去注释/尾逗号 | `:120-121,506-553` |
| 技能目录 | `~/.claude/skills`、`$CODEX_HOME/skills` | `SKILL.md` 和文本附件 | 只读文本；`secretName`/`holdsCredential` 排除；不跟随链接 | `:111-114,140-155,308-340` |
| Grok 本地痕迹 | `GET /api/setup-import/grok` | Downloads 里的 Grok 痕迹 | 被标记为敏感读；需要 desktop owner | `server/request-auth.ts:536-540`；`server/routes/setup-import.ts:41-45` |
| 输出 | `config.json` 的 `mcpServers` | 新 MCP 条目 | 统一 `enabled:false`；GET 只回名字 | `server/setup-import.ts:657-699` |

这张表说明“无认证暴露”不成立的关键：路由不是公开的，响应也不是配置全文。真正需要防的是“已拿到桌面 owner 能力的人”能读取本机其他 AI 工具的 MCP 配置；这是本地权限问题，不是未认证 HTTP 问题。

### 7）能否降级为“纯本地、无账号、API token 即可”？

**可以。** 上游的账号/会话层并不是本地聊天必需的；04-core-spec 已经把目标写成“所有 `/api` 都要令牌、只有 `/health` 公开、只绑 `127.0.0.1`、不做回环即管理员”（`docs/plan/04-core-spec.md:37-43`）。有三种落地深度，优缺点不同：

| 方案 | 保留 | 删除或默认关闭 | 优点 | 代价 |
|---|---|---|---|---|
| A 纯 API token | 回环绑定、Host/Origin/代理检查、`Authorization: Bearer` 校验、常量时间比较、`/api/health` 公开 | 邮箱、配对、session cookie、hosted、enterprise、team、device-links | 代码最少，攻击面最小，脚本/CLI 直接可用 | 没有浏览器 UI；若 UI 需要 token，只能由用户手工注入或另做本地登录页 |
| B token + 本地 HttpOnly 会话 | A 的全部，再加最小 `SessionRegistry`、cookie 签发、CSRF 同源校验、撤销 | 邮箱/OTP、hosted/portal、team、企业许可、device-links | 保留浏览器 UI，仍然没有账号体系 | 需要维护 cookie/CSRF/会话固定；代码量比 A 大 |
| C 保留本机配对 | B 的全部，再加 `request-auth` 配对码、`/pair` 页面、会话列表/撤销 | 邮箱登录、hosted/enterprise、team、Cloud 相关 | 对普通用户最友好；本机/手机配对体验保留 | 攻击面最大；必须保留锁定、限速、一次性码和撤销 |

#### 7.1 模块取舍表

| 模块或路由 | 纯本地是否需要 | 建议 | 理由 |
|---|---|---|---|
| `server/request-auth.ts` 的 Host/Origin/代理判定 | 需要 | 保留 | 防 DNS rebinding、防代理提权（`:179-183,642-645`） |
| `server/request-auth.ts` 的 `ownerOrAdmin` | 单用户可简化 | 改可配置 | 回环 owner 是便利，不是认证（`:62-66`） |
| `server/request-auth.ts` 的 `SERVICE_ALLOW` | 单用户不需要 | 删除或只留 health | service 分支服务共享服务器（`:39-55`） |
| `server/sessions.ts` 的 token 哈希/TTL/撤销 | 需要 | 保留 | 即便是 API token 也要可撤销、可过期（`:24-27,669-676`） |
| `server/sessions.ts` 的配对码 | 浏览器 UI 可选 | 保留或默认关闭 | 不是账号；是本地准入（`:13-16,352-372`） |
| `server/account-signin.ts` | 不需要 | 删除 | 控制面 OTP（`:61-107`） |
| `server/sign-in-mail.ts` | 不需要 | 删除 | 本机 SMTP 账号功能（`:5-8`） |
| `server/routes/email-sign-in.ts` | 不需要 | 删除 | 邮箱登录公开入口（`:17-31`） |
| `server/enterprise.ts` 的 workspace access hook | 不需要 | 删除或留 OSS 回落 | hosted 商业层（`:107-110`） |
| `server/hosted-contract.ts` | 不需要 | 删除 | 只服务 hosted 兼容（`:1-14`） |
| `server/device-links.ts` | 不需要 | 默认关闭 | 共享电脑/借网（`:36-127`） |
| `server/setup-import.ts` | 桌面可选 | 保留 | 本机导入，不涉账号（`:691-699`） |
| `server/admission.ts` | 视回合队列 | 保留 | 不是鉴权，删了会影响排队（`:94-159`） |

**最小保留清单（按方案 B/C）：** `server/request-auth.ts` 里的 Host/Origin/代理判定、`fromBrowser`、`ownerOrAdmin`、`requiredScope`、常量时间比较、`SERVICE_ALLOW`（如果还需要 service 模式）；`server/sessions.ts` 的 token 哈希、TTL、撤销、stream ticket；`server/index.ts` 的 `/api/auth/session`、`/api/auth/logout`、`/api/auth/sessions`（单用户可只留 logout）；`server/routes/upgrades.ts` 的统一 upgrade 门；`server/admission.ts` 与账号无关，按回合队列需要保留。

**必须删除或默认关闭的商业账号面：** `/api/auth/email/start`、`/api/auth/email/verify`（`server/routes/email-sign-in.ts:17-31`）；`/api/auth/hosted/*` 和 portal 流程（`enterprise/server/workspace-access.ts:88-148`）；`EAC_ADMIN_*`、`workspaceMembership`、`sharedWorkspaceFullAccess`（`server/enterprise.ts:71-105`）；team 成员 claim/手机撤销（`server/sessions.ts:646-667`）；`hosted-contract`（`server/hosted-contract.ts:1-14`）；device-links/共享电脑（`server/device-links.ts:36-127`）按产品取舍。`/api/auth/pairing` 和 `/pair` 可以保留为“本机/远程配对”，不属于商业账号；如果不需远程访问，也可以一并默认关闭。

**许可证边界。** `enterprise/LICENSE` 明确：`enterprise/` 不在根 Apache 2.0 范围内；生产启用企业功能需要有效 key；不得移除、禁用或绕过许可检查；但第 4 条明确允许删除该目录，剩余仓库按 Apache 2.0 作为 OSS 构建运行（`enterprise/LICENSE:4-26`）。因此“删掉 `enterprise/` 走合法 OSS 降级”是允许的产品决策；改 key、伪造 entitlement、绕过校验都不允许。`server/enterprise.ts` 本身在 `server/` 下，保留它的 OSS 回落即可，不需要改许可逻辑。

#### 7.2 降级后的验收清单

| 验收项 | 期望 | 证据或判定 |
|---|---|---|
| 无 config 启动 | 服务能监听回环，不要求建账号 | `server/config.ts:735-751`；`server/index.ts:15506` |
| 无 session 调 health | 200 且只回 app 名 | `server/index.ts:12787-12789` |
| 无 token 调 `/api/config` | 401/403，不再因回环自动放行 | 目标行为；当前相反（`server/request-auth.ts:636`） |
| 正确 token 调 `/api/config` | 200 | 目标行为；`requiredScope` 仍按 admin（`server/request-auth.ts:431-438`） |
| 错误 token | 401，且不泄漏期望值 | 目标行为；常量时间比较可复用（`server/request-auth.ts:551-556`） |
| 跨源 cookie 写 | 403 | 现有逻辑（`server/request-auth.ts:580-587`） |
| 撤销 token | 立即 401，流关闭 | 现有 `sessions.revoke`（`server/sessions.ts:669-676`） |
| 停用邮箱/配对 | 对应路由 404/403，不出现半开状态 | `server/routes/email-sign-in.ts:29-31`；`server/index.ts:12670-12672` |
| 删除 enterprise | 构建和启动仍为 OSS | `server/enterprise.ts:119-150`；`enterprise/LICENSE:24-26` |
| 保留 setup-import | 非桌面 403，桌面 owner 可用 | `server/routes/setup-import.ts:47-59` |

这张清单的重点不是“功能都在”，而是“去掉账号后每个入口都有确定的拒绝方式”。如果某一项只改了前端而没改后端，验收会看到“页面没了但请求仍成功”，这不算降级完成。

## 二、与共享资料不一致

### 与 02 的 G-03 不一致（范围补充与工作树状态差异）

G-03 的 HEAD 描述“回环来源的浏览器也必须先登录”是成立的；它没有写“非浏览器本地进程默认直接是 owner”。按 HEAD，`fromBrowser()` 只根据 `Sec-Fetch-*` 和 WebSocket Origin 判断；`curl`、CLI、Node 脚本、bot 的 shell 都不带这些头，走到 `server/request-auth.ts:636` 就得到 `admin+client`。这意味着在默认自建服务器上，**任何同 OS 用户的本地进程（包括 bot 的工具 shell）都能以 owner 身份调用 API**，不需要配对。G-03 的“本机直接打开浏览器会 401”是成立的，但把风险范围写小了。证据：HEAD 的 `server/request-auth.ts:134-141,604-636`。

G-03 的建议“默认信任本机页面但保留跨源限制”在 HEAD 上如果直接去掉 619 的浏览器拒绝会有风险：`isAllowedOrigin()` 只要求 Origin 的 hostname 是回环，任意回环端口都通过；HEAD 的回环 owner 分支没有调用 `fromOwnPage()` 或 `provesSameOrigin()`。`http://127.0.0.1:5173` 之类的本地页面就能对 `http://127.0.0.1:8799` 发 owner 请求。当前工作树已经用 `provesSameOrigin()` 实现了这个建议，见末尾“工作树漂移（非基线）”；正文不把当前工作树描述成没有该分支。

### 与 02 的 G-04 不一致（影响范围）

G-04 说 service 回环“不能改设置、人员、权限”，这部分成立；但代码注释明确写出了更广的已存在风险：bot 的 shell 也是回环调用者，能通过 guarded 路由往任意 bot 的线程发消息、在共享 Full access 打开时开新的 Full access 线程、停止请求、拒绝卡片。`SERVICE_ALLOW` 确实包含 `/api/bots/:id/messages/guarded`、`/api/bots/:id/tasks`、`/api/threads/:id/respond` 等（`server/request-auth.ts:32-38,47-52`）。所以 G-04 的“不能改设置”不能理解为“bot shell 只能看”；建议补上 relay token 或把这些路由从 service 匿名白名单移出。

### 与 02 的 G-11 不一致（影响不完整）

G-11 说“配了 `EAC_ADMIN_*` 但没装 enterprise 层时登录和浏览器鉴权不可用”，这是对的；但它没有说明同时发生的锁死：`hostedWorkspaceConfigured()` 只要看到任意一个 `EAC_ADMIN_*` 就为真（`server/enterprise.ts:71-72`），于是 `HOSTED_WORKSPACE` 为真（`server/index.ts:755`），配对和邮箱在 12670-12672 被前置 403；而 `hostedWorkspaceConfiguration()` 因配置不完整返回 null（`server/enterprise.ts:76-87`），`workspaceAccess` 为 null，hosted 登录返回 503（`server/index.ts:12674-12677`）。结果是既不能配对、也不能邮箱、也没有 portal，管理员只能改环境变量重启。这个“无登录路径”应在 G-11 的影响里写明。

### 与 03 的 B01-B03 状态差异（HEAD 基线 vs 当前工作树）

03 的 B01/B02/B03 是**HEAD 基线**的结论，不是当前工作树的状态。HEAD 的 `ChiefIntro` 没有 `onLater`，所以 B01 说“不能跳过 Chief”在 HEAD 成立（`03-frontend-gates.md:30-31`）；当前工作树已经加了 `onLater` 和 `data-chief-later` 按钮（当前 `src/components/onboarding/ChiefIntro.tsx:36,102-106,201-204`），`WelcomeFlow` 把 `onLater` 接到 `finish("skipped", null)`（当前 `src/components/onboarding/WelcomeFlow.tsx:170-172`）。因此合并当前工作树后，B01 不应再作为待修项。

同理，03 的 B02/B03 描述的是 HEAD 的 `SettingsModal` 过滤条件（People/Activity 受 `!window.ogb` 影响，`03-frontend-gates.md:31-32`）；当前工作树已经去掉了 `!window.ogb`，People 仅在 `cloudHome === true` 时隐藏，Activity 仅在 `ownerOrAdmin !== true` 时隐藏（当前 `src/components/SettingsModal.tsx:205-206`）。当前工作树上面板可见，B02/B03 也不应再作为待修项。合并后按这两行复核，不要重复删除条件。

## 三、逐项清单

| 编号 | 文件:行 | 限制或行为 | 触发条件 | 默认值 | 技术限制/商业许可 | 建议（删除/默认关闭/改可配置/保留） |
|---|---|---|---|---|---|---|
| C01 | `server/account-signin.ts:33-35`；`server/routes/email-sign-in.ts:29-31` | 邮箱登录白名单为空时不启用，`/api/auth/email/*` 返回 404 | 未配置 `config.signIn.admins/members` 且未设 `EAC_SIGNIN_EMAILS`/`EAC_SIGNIN_MEMBER_EMAILS` | 关闭 | 商业许可 | 默认关闭 |
| C02 | `server/account-signin.ts:24-31`；`server/config.ts:326-327,792-795` | `@domain` 或精确地址；admins 得 admin+client，members 仅 client；环境变量覆盖文件 | 配置白名单 | 空 | 商业许可 | 改可配置 |
| C03 | `server/account-signin.ts:61-68`；`electron/companion-account-service.mjs:18,74-82` | 未设 SMTP 时走控制面；`isPackaged:true` 使自建也默认 `https://accounts.eacbot.com` | 邮箱登录已启用且未设 `EAC_CONTROL_PLANE_URL` | 控制面 | 商业许可 | 默认关闭 |
| C04 | `server/sign-in-mail.ts:5-8,67-103` | 本机 SMTP 的 8 位码，10 分钟、5 次、30 秒重发、最多 1000 个 pending；只存哈希 | 设置 `EAC_SIGNIN_SMTP_URL` | 未设置则不启用 | 技术限制 | 保留 |
| C05 | `server/routes/email-sign-in.ts:53-64`；`server/sessions.ts:571-601` | 邮箱验证通过后签发普通本地会话；白名单移除会撤销该邮箱的会话 | 邮箱登录成功或白名单变更 | 无会话 | 商业许可 | 保留 |
| C06 | `server/enterprise.ts:71-87`；`server/index.ts:755,12670-12677` | 任一 `EAC_ADMIN_*` 即视为 hosted；配置不完整会同时禁用配对/邮箱且无 portal，形成锁死 | 任一 `EAC_ADMIN_*` 出现 | 未设置即非 hosted | 商业许可 | 改可配置 |
| C07 | `server/index.ts:12670-12672`；`server/enterprise.ts:90-95` | hosted workspace 前置拒绝配对和邮箱，只允许门户登录 | hosted 已配置 | 仅 hosted 生效 | 商业许可 | 保留 |
| C08 | `server/enterprise.ts:107-110`；`server/index.ts:15452`；`enterprise/server/workspace-access.ts:55,92,152` | hosted 访问依赖 enterprise 层和 admin entitlement；缺失时 503 | hosted 已配置但层或许可缺失 | 无层则 503 | 商业许可 | 保留 |
| C09 | `server/enterprise.ts:90-99` | `workspaceMembership()` 返回 local/portal；只要有任何 hosted 变量就禁用 pairingCodes | 读取 hosted 配置 | 非 hosted 时 local+pairing | 商业许可 | 改可配置 |
| C10 | `server/enterprise.ts:101-105`；`server/index.ts:758-760` | 共享工作区 Full access 只允许 portal membership 且非桌面，并需 admin entitlement | 显式 `EAC_SHARED_WORKSPACE_FULL_ACCESS=1` | 关闭 | 商业许可 | 默认关闭 |
| C11 | `server/enterprise.ts:37-38,137-150,193-195` | 无 key 即 OSS；到期后 7 天宽限；未知 feature 一律 false | 加载企业层 | OSS，无 features | 商业许可 | 保留 |
| C12 | `server/routes/status.ts:82-86`；`server/index.ts:12662` | Fleet/Workspaces/hosted readiness 需要 `entitled("admin")`，admin scope 本身不够 | 调用对应企业路由 | 未授权即 403/503 | 商业许可 | 保留 |
| C13 | `server/index.ts:698-702`；`server/sessions.ts:336-349,358,448` | Cloud personal 模式只允许 admin 会话；非 admin 会话不能签发/兑换/接受 | `CLOUD_HOME` 且无 team | 仅 personal Cloud | 商业许可 | 保留 |
| C14 | `server/routes/status.ts:104-107`；`server/enterprise.ts:186-190` | 成员看 `/api/edition` 只得到 features，过期天数/宽限/notice 被剥离 | 非 admin 会话 | 仅 admin 看完整 | 商业许可 | 保留 |
| C15 | `server/sessions.ts:646-667`；`server/cloud-home.ts:208`；`server/cloud-team-policy.ts:286` | Team 成员被移除时结束其 team 会话和成员手机；`revokeMember` 可按角色保留 | Admin claim 变化 | 无 team 不生效 | 商业许可 | 保留 |
| L01 | `server/index.ts:15506` | HTTP 只监听 `127.0.0.1`，局域网/公网不能直接访问 | 启动主服务 | 回环 | 技术限制 | 改可配置 |
| L02 | `server/request-auth.ts:604-605,110-132,157-165` | 回环要求 Host 是 loopback，Origin 缺省或 loopback HTTP(S) | 无会话请求 | 强制 | 技术限制 | 保留 |
| L03 | `server/request-auth.ts:179-183` | 有 `x-forwarded-*`、`forwarded` 或 IPC peer 即视为代理，不给回环信任 | 反向代理或 IPC 转发 | 强制 | 技术限制 | 保留 |
| L04 | `server/request-auth.ts:134-141` | 浏览器由 `Sec-Fetch-*` 或 WebSocket Origin 识别；非浏览器不带这些头 | 任意请求 | 依赖 header | 技术限制 | 保留 |
| L05 | `server/request-auth.ts:85-108` | 自建默认 owner；hosted/Cloud 默认 service；桌面默认 owner | 启动时解析 | 自建 owner | 技术限制 | 改可配置 |
| L06 | `server/request-auth.ts:88-107` | Cloud 强制 service；桌面强制 owner；显式 owner/service 生效；非法值回落 service；显式 owner 在 hosted 只警告 | 设置 `EAC_LOOPBACK_TRUST` | 见左 | 技术限制 | 改可配置 |
| L07 | `server/index.ts:757-780,1466-1475`；`electron/server-session.mjs:35-43`；`server/request-auth.ts:617-621` | 桌面 owner header 只在 `127.0.0.1:serverPort` 注入，且要求同页；token 初始为空 | `EAC_DESKTOP_PARENT=1` | 桌面 owner，浏览器写操作需 token | 技术限制 | 保留 |
| L08 | `server/request-auth.ts:143-153`；`server/dev-server.ts:1-3` | `EAC_DEV_TRUST_LOCAL_BROWSER=1` 只对源码启动且 owner 信任生效 | 开发服务器 | 关闭 | 技术限制 | 默认关闭 |
| L09 | `server/request-auth.ts:39-55,623-634` | service 回环只允许 15 条白名单，scope 只有 client | hosted/Cloud 或显式 service | 默认自建 owner，hosted service | 技术限制 | 保留 |
| L10 | `server/request-auth.ts:32-38,47-52` | 注释承认 bot shell 可通过 guarded 路由发消息、开 Full access 线程、停止请求、拒绝卡片 | service 回环 | 白名单默认放行 | 技术限制 | 改可配置 |
| L11 | `server/request-auth.ts:513-524,623-629`；`server/index.ts:765-777` | CLI owner token 从 stdin 读，只打开 `/api/auth/pairing` 的 GET/POST | service 信任且 `EAC_CLI_OWNER_STDIN=1` | 无 token 则不用 | 技术限制 | 保留 |
| L12 | `server/request-auth.ts:607-615`；`server/index.ts:779-780,1466-1475` | companion token 通过后给 admin+client；token 初始为空 | 桌面壳发送 companion token | 空 token 拒绝 | 技术限制 | 改可配置 |
| L13 | `server/request-auth.ts:62-66` | `ownerOrAdmin()` 对非 service 回环直接返回 true | 任何回环 owner | 自建/桌面为 true | 技术限制 | 保留 |
| L14 | `server/request-auth.ts:157-165,604-636` | HEAD 基线：`isAllowedOrigin` 只要求 loopback，任意 loopback 端口都过；owner 分支不要求同源 | 回环请求 | 任意 loopback Origin | 技术限制 | 改可配置 |
| L15 | `server/request-auth.ts:137-141,604-636` | 非浏览器本地进程默认为 owner；bot shell 若同 OS 用户也可调 API | 自建默认 owner | 开启 | 技术限制 | 默认关闭 |
| L16 | `server/index.ts:757-780`；`server/request-auth.ts:617-621` | 在非 Electron 环境误设 `EAC_DESKTOP_PARENT=1` 会让浏览器写操作 403，且没有 token 可补 | 误设环境变量 | 桌面壳才应设置 | 技术限制 | 保留 |
| A01 | `server/request-auth.ts:563-578` | 凭据优先级：`omb_sess_` bearer、ticket、cookie；先到先判 | 任意请求 | 无 | 技术限制 | 保留 |
| A02 | `server/request-auth.ts:569-571,250-255` | 只有 `omb_sess_` 前缀的 bearer 被当作会话；其他 bearer 留给具体路由 | 带 Authorization 的请求 | 无 | 技术限制 | 保留 |
| A03 | `server/request-auth.ts:580-587` | cookie 会话跨源返回 403；无 Origin 的 CLI 请求仍可通过同源检查 | 浏览器 cookie 请求 | 强制 | 技术限制 | 保留 |
| A04 | `server/request-auth.ts:582-587,207-211` | `cookieOnly` 会话不能用 bearer；写操作必须 `provesSameOrigin()` | 浏览器 sign-in 会话 | 强制 | 技术限制 | 保留 |
| A05 | `server/request-auth.ts:276-277,431-438` | `CLIENT_ALLOW` 未列出的新路由默认 admin | 新路由 | 默认拒绝 | 技术限制 | 保留 |
| A06 | `server/request-auth.ts:599-602` | 过期/被撤销的会话凭据直接 401，不回退成回环 owner | 带失效 cookie/bearer | 强制 | 技术限制 | 保留 |
| A07 | `server/sessions.ts:24-27,620-634` | 会话默认 30 天、最长 180 天；剩余不足一半时续期 | 每次认证/续期 | 30/180 天 | 技术限制 | 改可配置 |
| A08 | `server/sessions.ts:13-16,130-142,352-366`；`server/sessions.ts:195-207` | 配对码 60 位、12 字符、默认 5 分钟、最长 24 小时；单次使用 | 创建配对码 | 5 分钟 | 技术限制 | 保留 |
| A09 | `server/sessions.ts:357`；`server/cli.ts:352-363,899` | 未传 scopes 时配对码默认 admin+client；`eacbot pair` 不加 `--client` 就是完整权限 | 创建配对码 | admin+client | 技术限制 | 改可配置 |
| A10 | `server/sessions.ts:34-36,400-422,424-444`；`server/request-auth.ts:213-227` | 同来源 10 次/60 秒锁 60 秒；attemptId 重放窗口 60 秒；source 截断清洗 | 连续失败或重试 | 锁定关闭 | 技术限制 | 保留 |
| A11 | `server/sessions.ts:42-67,243-265,275-282` | token 只存 sha256；文件 0600；启动写 `.open`；不干净退出只恢复非账号会话 | 启动/写入/关闭 | 强制 | 技术限制 | 保留 |
| A12 | `server/sessions.ts:325-334,669-676`；`server/index.ts:4701-4713,12616` | 撤销清 ticket、触发监听器、关 SSE/浏览器 live/桌面 viewer/live call/provider auth/MCP OAuth | 调用 revoke | 强制 | 技术限制 | 保留 |
| A13 | `server/sessions.ts:32,678-696`；`server/index.ts:12848-12850` | stream ticket 5 分钟、一次性、每会话最多 5 个、兑换不续期 | `/api/events` | 强制 | 技术限制 | 保留 |
| A14 | `server/sign-in-mail.ts:5-8,67-103` | 邮箱码 8 位、10 分钟、5 次、30 秒重发、最多 1000 pending；只存哈希 | 本机 SMTP 登录 | 关闭 | 技术限制 | 保留 |
| A15 | `server/routes/email-sign-in.ts:33-57` | 邮箱 start/verify 共用来源锁定；403/401 计失败，429 直接返回 | 邮箱登录 | 关闭 | 技术限制 | 保留 |
| A16 | `enterprise/server/workspace-access.ts:12-16,105-148` | hosted PKCE：state/verifier 5 分钟、一次性、cookie 绑定、每来源 20 次/分钟、最多 1000 pending | hosted 登录 | 关闭 | 技术限制 | 保留 |
| A17 | `enterprise/server/workspace-access.ts:70-85,150-162`；`server/index.ts:15454-15456,12797-12801` | 每个 hosted 请求校验一次，另每 10 秒 revalidate；401 撤销，503 只阻断 | hosted 会话 | 强制 | 技术限制 | 保留 |
| A18 | `server/index.ts:12797-12801,12852-12855`；`enterprise/server/workspace-access.ts:74-77` | Admin 不可达时 logout/revoke 先被 503 拦住，无法走本地撤销 | hosted + Admin 离线 | 无离线豁免 | 技术限制 | 改可配置 |
| A19 | `server/sessions.ts:488-514`；`server/team-move-in.ts:83-99`；`server/index.ts:12776` | move-in 会话虽为 admin+client，但只允许其目标 bot 的搬入路由和文件路径 | Team move-in | 仅该 bot | 技术限制 | 保留 |
| A20 | `server/index.ts:12941-12942`；`server/sessions.ts:641-644` | admin 列出所有会话（含其他用户），没有按 tenant/person 过滤；可撤销任意 id | admin 会话 | 全部可见 | 技术限制 | 改可配置 |
| A21 | `server/request-auth.ts:257-274`；`server/index.ts:12732-12736,12779-12784` | cookie 名含端口+环境 ID；HttpOnly、SameSite=Lax；Secure 仅在 HTTPS 或 hosted 续期时加 | 签发/续期 | HTTP 回环不带 Secure | 技术限制 | 保留 |
| A22 | `server/index.ts:12732-12735` | 只有 browser sign-in 会撤销旧 cookie 会话；普通配对+cookie 不撤销旧会话 | cookie 配对 | 旧会话仍有效 | 技术限制 | 改可配置 |
| A23 | `server/request-auth.ts:53`；`server/index.ts:13012-13015` | `/api/internal/*` 用 turn-scoped capability bearer，handler 再校验；service 回环只是允许到达 | 内部能力调用 | 默认拒绝无 capability | 技术限制 | 保留 |
| A24 | `server/sessions.ts:65-66,458-459,624` | `token: true` 的脚本 token 到期即失效，不续期 | 创建 tokenTtl 的配对 | 不创建 | 技术限制 | 保留 |
| Q01 | `server/index.ts:12787-12789` | 无会话 `GET /api/health` 只返回 `{app:"eacbot"}` | 任意来源 | 公开 | 技术限制 | 保留 |
| Q02 | `server/index.ts:12790-12793` | 无会话 `GET /api/brand` 返回品牌信息 | 任意来源 | 公开 | 技术限制 | 保留 |
| Q03 | `server/index.ts:12694-12702` | 静态文件、`/.well-known/eacbot/environment`、domain-check 在鉴权门之前 | 任意来源 | 公开 | 技术限制 | 保留 |
| Q04 | `server/index.ts:12704-12705`；`server/routes/email-sign-in.ts:17-31` | 邮箱路由在鉴权门之前，但未启用时 404；启用后是公开 OTP 入口 | 邮箱已启用 | 关闭 | 技术限制 | 保留 |
| Q05 | `server/index.ts:12707-12765` | `/api/auth/pair` 与 `/api/pair` 在鉴权门之前，只收 JSON，兑换有锁定和单次码 | 配对 | 公开入口 | 技术限制 | 保留 |
| Q06 | `server/index.ts:15419`；`server/routes/setup-import.ts:23-24`；`server/routes/setup-request.ts:25` | 没有 `/api/setup` 或 `/api/signin`；未知路径落到 404 | 访问该路径 | 不存在 | 技术限制 | 保留 |
| Q07 | `server/routes/setup-import.ts:43-59`；`server/index.ts:12494` | setup-import 仅桌面壳、loopback owner、非 service；否则 403 | 桌面欢迎流 | 非桌面禁用 | 技术限制 | 保留 |
| Q08 | `server/setup-import.ts:101-122,150-155,316-340,672,691-699` | 读取本机 Claude/Cursor/Codex/Gemini 配置和技能；GET 只回名字；MCP 以 enabled:false 导入；过滤凭据文件 | 调用 detect/apply | 桌面才可 | 技术限制 | 保留 |
| Q09 | `server/routes/setup-request.ts:25-69`；`server/setup-request.ts:43-80` | bot 的 Setup 卡片走 client scope，先 sendRefusal/canSetUp，picking 防双击；owner/admin 可取消 | 用户在会话里点 Setup | 仅该会话 | 技术限制 | 保留 |
| Q10 | `server/setup-mode.ts:1,5-8,19-21,106-108` | `/setup` 只改写本轮提示词，不授予任何权限 | 输入 `/setup` | 无权限变化 | 技术限制 | 保留 |
| Q11 | `server/admission.ts:1,94-159` | 这是回合准入（start/queue/steer/refuse），不是身份认证；`guarded` 只是外部发送的容量策略 | 回合派发 | 无认证作用 | 技术限制 | 保留 |
| Q12 | `server/bot-logins.ts:46-55,75-85`；`server/login-store.ts:1-3,115-155`；`server/login-handoff.ts:1-3,99-119` | 第三方网站登录；加密存本机；handoff 只走 Electron 私有 utility 端口 | 浏览器登录卡片/桌面交接 | 本机加密 | 技术限制 | 保留 |
| Q13 | `server/request-auth.ts:346-349`；`server/routes/logins.ts:77-80`；`server/index.ts:12392` | 保存登录卡是 client 可用；`/api/logins` 列表/改/删不在 CLIENT_ALLOW，默认 admin | 登录卡或设置 | admin-only | 技术限制 | 保留 |
| Q14 | `server/phone-secret.ts:93-152`；`server/routes/secret-cards.ts:70-96` | 手机密钥用 HPKE 信封，AAD 绑定 bot/thread/message/device/target；不是账号认证 | 手机提交凭据 | 需要配对设备头 | 技术限制 | 保留 |
| Q15 | `server/device-links.ts:25-27,48-56,85-113`；`server/shared-computers.ts:281-285` | 设备链接的 live 直接查 session；路由和 10 秒 ping 都检查；会话撤销后关闭 | Cloud home 共享电脑 | 仅 Cloud 链接 | 技术限制 | 保留 |
| Q16 | `server/hosted-contract.ts:1-14`；`enterprise/server/workspace-access.ts:59-67` | 只版本化 hosted wire；legacy 省略版本被接受；不携带身份 | hosted 调用 | v1 | 商业许可 | 删除 |
| Q17 | `server/routes/upgrades.ts:1-2,35-64` | WebSocket upgrade 走同一个 handleRequest，因此同一套 Host/Origin/会话/维护门 | WS 握手 | 统一门 | 技术限制 | 保留 |
| Q18 | `server/request-auth.ts:440-500` | client 改 bot 只允许显示字段；member 按 view/chat/edit 再分层 | client/member PATCH | 默认拒绝越界字段 | 技术限制 | 保留 |
| Q19 | `server/index.ts:12684-12691` | MCP OAuth callback 在鉴权门之前，靠 state 由 `teamConnections.mcpCallback` 校验 | OAuth 回调 | 公开入口 | 技术限制 | 保留 |
| Q20 | `server/index.ts:12950-12974` | 测试路由只有高熵 key 存在时才可用，否则 404；比较用常量时间 | 测试环境 | 生产无 key | 技术限制 | 保留 |

## 四、统计

- **总条数：75 条。** C 类 15 条、L 类 16 条、A 类 24 条、Q 类 20 条。
- **按建议分类：** 保留 **55** 条；改可配置 **14** 条；默认关闭 **5** 条；删除 **1** 条。
- **按性质分类：** 技术限制 **60** 条；商业许可 **15** 条。
- **商业许可的 15 条：** C01 至 C03、C05 至 C15（C04 是本机 SMTP，算技术限制），以及 Q16 的 hosted-contract。
- **“默认关闭”的 5 条：** C01、C03、C10、L08、L15。它们不是同一类：C01/C03 是账号功能，C10 是企业策略，L08 是开发信任，L15 是回环 owner 的生产默认。

## 五、风险 Top 10

1. **L15 本地进程默认为 owner。** 风险最高：自建默认下任何同 OS 用户的进程（包括 bot 的 shell）不带浏览器头就能拿到 `admin+client`，可以改设置、读配置、撤销会话；这不是“登录漏洞”，而是把“本机用户”当成了信任边界。证据：`server/request-auth.ts:137-141,604-636`；`server/index.ts:15440-15442`。建议：默认关闭回环 owner 的写权限，所有 `/api` 要求 token；如果必须保留回环免登录，只给只读或 `client`，并补同源/CSRF 证明。
2. **L06 hosted 上显式 `EAC_LOOPBACK_TRUST=owner` 只警告不拒绝。** 这会让 hosted workspace 的“每个 bot shell 都是 service”隔离失效，回环请求直接成为 owner，并绕过 `workspaceAccess.authorize()` 的 session 分支。证据：`server/request-auth.ts:94-100,623-636`；`enterprise/server/workspace-access.ts:150-156`。建议：hosted 下硬拒绝 `owner`，或要求额外的一次性 operator token。
3. **L10 service 白名单比“不能改设置”更宽。** 代码注释明确 bot shell 可以发 guarded 消息、在共享 Full access 下开新 Full access 线程、停止请求、拒绝卡片；这些不是设置，但仍是高影响操作。证据：`server/request-auth.ts:32-38,47-52`。建议：给 Slack worker 单独的 relay token，服务回环不再匿名放行这些路由。
4. **C06/C07 hosted 配置不完整会锁死登录。** 任一 `EAC_ADMIN_*` 就禁用配对/邮箱；配置不完整时 `workspaceAccess` 又是 null，hosted 登录 503，没有本地替代入口。证据：`server/enterprise.ts:71-87`；`server/index.ts:755,12670-12677`。建议：启动时校验 `EAC_ADMIN_*` 三件套和 `EAC_PUBLIC_URL`，不完整就拒绝启动并打印明确修复项。
5. **A18 hosted 离线不能 logout/revoke。** Admin 不可达时 `workspaceAccess.authorize()` 返回 503，路由前的 `POST /api/auth/logout` 和 `DELETE /api/auth/sessions/:id` 都走不到本地撤销；用户无法主动结束会话。证据：`server/index.ts:12797-12801,12852-12855`；`enterprise/server/workspace-access.ts:74-77`。建议：logout/revoke 在 hosted 下允许本地执行，或提供本地“结束本机会话”按钮。
6. **A09 配对码默认 admin+client。** `openPairing()` 不传 scopes 就是全部 scope；`eacbot pair` 不加 `--client` 会生成完整 owner 码。12 字符码在 5 分钟内被 shoulder-surf/日志泄露，后果是完整管理员。证据：`server/sessions.ts:357`；`server/cli.ts:352-363,899`。建议：默认 client，管理员显式 `--admin`；日志和 UI 不显示完整码。
7. **A20 会话列表不按人过滤。** 任何 admin 会话都能列出所有会话的 label、email、时间，并撤销任意 id；在 Team/hosted 多人环境下是隐私和误踢风险。证据：`server/index.ts:12941-12942`；`server/sessions.ts:641-644`。建议：按当前 tenant/person 过滤；跨人撤销要求额外角色或二次确认。
8. **L14 在 HEAD 基线上，若直接按 G-03 默认信任本机页面，任意 loopback Origin 都能当 owner。** HEAD 的 `isAllowedOrigin` 只校验 hostname，不校验端口/同源；回环 owner 分支没有 `provesSameOrigin`。证据：`server/request-auth.ts:157-165,604-636`。当前工作树已加 `provesSameOrigin`，见附录；合并后仍建议保留同源证明，并只信任配置过的 dev origin。
9. **C03 邮箱登录默认依赖厂商控制面。** 自建服务器一旦配置白名单，未设 `EAC_CONTROL_PLANE_URL` 就走 `https://accounts.eacbot.com`；离线/内网环境无法登录，也会把邮箱和 OTP 发给第三方。证据：`server/account-signin.ts:61-68`；`electron/companion-account-service.mjs:18,74-82`。建议：默认本地 SMTP，控制面必须显式配置。
10. **A22 普通 cookie 配对不撤销旧会话。** 只有 browser sign-in 会撤销旧 cookie 会话；普通配对的旧 cookie session 仍有效，属于会话固定/残留风险。证据：`server/index.ts:12732-12735`。建议：所有签发 cookie 的路径都撤销同一 cookie 的旧会话，并记录撤销原因。

## 六、未决问题与证据缺口

- **未编译、未启动、未跑测试。** 审计开始时 `00-baseline.md` 仍写 BLOCKED；`08-evidence-audit.md:13` 抽查发现依赖后来已安装（`node_modules/.bin/tsc` 与 `vitest` 创建于 12:07 后），但本报告仍未重新执行编译、启动或测试。本文不能证明运行时行为、状态码在实际 HTTP 栈中没有被上游中间件改写，也不能证明 TypeScript 类型检查通过。
- **Windows ACL 未验证。** `sessions.ts` 和 `login-store.ts` 用 `mode: 0o600` 写文件；Windows 上 Node 的 mode 不等同 POSIX 权限，实际 ACL 未被验证（`server/sessions.ts:275-282`；`server/login-store.ts:115-155`）。
- **浏览器 header 依赖未实测。** `fromBrowser()` 依赖 `Sec-Fetch-*`；不同浏览器/版本、扩展、WebView、Electron 的实际头未在本机抓包验证（`server/request-auth.ts:134-141`）。
- **反向代理配置未验证。** 如果代理删掉 `x-forwarded-*` 并把 Host/Origin 改写成回环，静态代码无法再区分远程与本地；这是部署配置风险，不是已证实漏洞（`server/request-auth.ts:179-183,604-605`）。
- **控制面账号生命周期未知。** `accounts.eacbot.com` 是否自动建账号、OTP 的具体限流、账号删除后的行为不在本仓库；本文只能证明本仓库发了 OTP 请求并签发本地会话（`server/account-signin.ts:71-107`）。
- **`EAC_ADMIN_MEMBERSHIP=local` 的实际路径不完整。** `workspaceMembership()` 可以返回 authority local，但 `enterprise/server/workspace-access.ts` 的 `authorize()` 要求 `portal:` userId；这种组合是否能登录，静态代码看不出完整闭环（`server/enterprise.ts:90-99`；`enterprise/server/workspace-access.ts:150-156`）。
- **远程注销对进行中回合的影响。** 静态可见 `onSessionRevoked` 没有调用 turn interrupt；但其他后台路径是否会因流关闭而停止回合，未运行验证（`server/index.ts:4708-4713`）。
- **`/api/setup` 的“不存在”是当前 HEAD 的事实。** 如果主线程接下来新增同名路由，本文 Q06 需要更新；当前证据是 `rg` 无匹配加 404 回落（`server/index.ts:15419`）。
- **`03` 的 B01/B02/B03 是 HEAD 基线结论。** 当前工作树已经加上 Chief 的“稍后设置”并去掉 SettingsModal 的 `!window.ogb`；合并后按附录中的符号复核，不要重复按旧结论改一遍。

## 七、行号抽查

写完后用 `git show HEAD:...` 加 `rg -n` 抽查了 12 个高风险引用，均能在 HEAD `781c57e` 命中对应符号；当前工作树的行号漂移见下一节。

| 引用 | 抽查符号 | 结果 |
|---|---|---|
| `server/request-auth.ts:619` | `fromBrowser(req) && !desktopOwner` | 命中 |
| `server/request-auth.ts:636` | `scopes: LOOPBACK_SCOPES` | 命中 |
| `server/sessions.ts:357` | `input.scopes?.length ? ... : [...SCOPES]` | 命中 |
| `server/sessions.ts:458` | `Math.min(pairing.tokenTtlMs ?? SESSION_TTL_MS, SESSION_MAX_AGE_MS)` | 命中 |
| `server/index.ts:12670` | `if (HOSTED_WORKSPACE)` | 命中 |
| `server/index.ts:12787` | `path === "/api/health"` | 命中 |
| `server/index.ts:12941` | `path === "/api/auth/sessions"` | 命中 |
| `server/enterprise.ts:71` | `hostedWorkspaceConfigured` | 命中 |
| `server/enterprise.ts:108` | `createWorkspaceAccess` | 命中 |
| `enterprise/server/workspace-access.ts:150` | `async authorize(req, auth)` | 命中 |
| `server/routes/setup-import.ts:49` | `if (!deps.local || auth.kind !== "loopback"` | 命中 |
| `server/config.ts:327` | `signIn: z.object` | 命中 |

## 八、工作树漂移（非基线）

以下内容来自主线程在当前工作树的未提交改动，**不是 HEAD `781c57e` 的结论**。保留在这里是为了合并后不误读：正文的主表、统计和 Top 10 仍按 HEAD 计算；合并后请按符号名复核，不要用当前工作树的行号直接替换正文。

| 文件 | HEAD `781c57e` | 当前工作树 | 对账号/准入的影响 |
|---|---|---|---|
| `server/request-auth.ts` | 619 行浏览器一律 401；636 行是 owner 的 general return | 622-626 行新增 `ownPageOwner = loopbackMutationToken === undefined && loopbackTrust !== "service" && provesSameOrigin(req)`；644 行是 owner 的 general return | 自建 owner 服务器上，服务自己同源页面的浏览器可以直接成为 owner；其他 loopback 端口、文件、沙箱、desktop 和 service 仍不获得这个例外。正文的浏览器 401、L14 和 G-03 风险描述是 HEAD 结论，当前工作树已对 L14 做了同源证明修复。 |
| `server/config.ts` | `signIn` 在 326-327；`EAC_SIGNIN_EMAILS` 在 792-795 | `signIn` 在 341；`EAC_SIGNIN_EMAILS` 在 815-818 | 只是 `limits` 配置块插入导致的行号漂移；白名单默认空、邮箱登录默认关闭的语义未变。正文 C02 引用 HEAD 行号。 |
| `server/setup-import.ts` | 691 行 `detectSetup`；672 行 `enabled:false` | 667/695 行改为 `maxMcpServers()`，替换 `MAX_MCP_SERVERS`；`detectSetup` 仍在 691 行，MCP 上限变成可配置 | 无认证语义变化；仍是桌面 owner 专用导入。正文 Q08 引用 HEAD 行号。 |
| `src/components/SettingsModal.tsx` | 205-206 行用 `!window.ogb` 隐藏 People/Activity | 205-206 行去掉 `!window.ogb`，People 仅受 `cloudHome` 限制，Activity 仅受 `ownerOrAdmin` 限制 | 桌面 owner 现在能看到 People/Activity；03 的 B02/B03 是 HEAD 基线结论，当前工作树已修，不应再当作待办。 |
| `src/components/onboarding/ChiefIntro.tsx` | 没有 `onLater`/`data-chief-later`，B01 所说的“不能跳过 Chief”在 HEAD 成立 | 36 行有 `onLater`，102-106 行有 `skip()`，201-204 行有 `data-chief-later` 按钮 | 首次运行可以选“稍后设置”完成，不强制创建 Chief；03 的 B01 是 HEAD 基线结论，当前工作树已修。 |
| `src/components/onboarding/WelcomeFlow.tsx` | 只有 `onDone`，没有 skipped 分支 | 170-172 行把 `onLater` 接到 `finish("skipped", null)` | 跳过 Chief 时以 `skipped` 完成首次运行，不声称已见 Chief。 |

**与共享资料的口径提醒。** 02 的 G-03 在 HEAD 上的“浏览器也必须先登录”是准确的；当前工作树新增了 `provesSameOrigin` own-page 例外，正文的 HEAD 结论不能直接套到当前工作树，当前工作树已有该分支。03 的 B01/B02/B03 同理：它们是 HEAD/修复前结论，当前工作树已经修好；合并后不要重复改一遍。

本报告只读，未修改源码、配置或依赖，未执行 `git add`、`commit`、`push`，未触碰 `D:\workspace\EACbot`。
