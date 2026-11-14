# 11. 本机浏览器免登录：loopback 信任收敛方案

日期：2026-11-14  
范围：`server/request-auth.ts` 及其单元测试、端到端测试  
对应问题：`docs/cleanse/02-backend-gates.md` 的 G-03，`docs/cleanse/03-frontend-gates.md` 的 F01/F02

## 结论

可以安全地做一次**很窄**的放宽：只让“由本服务自己提供的页面”在本机以 owner 身份访问本机 API，也就是同时满足下面三个条件的请求：

1. 已经通过现有的 loopback 判定（不是代理、Host 是回环地址、Origin 是回环地址或缺失）；
2. 浏览器用 `Origin` / `Sec-Fetch-Site` 证明请求来自**和 Host 完全相同的来源**（scheme、主机、端口都相同）；
3. 当前是 `owner` 信任，且不是桌面端的私有能力通道（没有 `loopbackMutationToken`）。

不满足这三条的浏览器请求仍然返回 401 和原来的登录提示。远程请求、反向代理请求、`service` 信任、桌面端、Cloud / hosted workspace 全部保持原样。

这不是“所有 loopback 浏览器都免登录”。如果只删掉浏览器判断，跨站页面、无 Origin 的图片/导航请求、DNS rebinding 之外的边界都会变松；本方案只放开同源页面，正是为了避免这些口子。

## 一、现在 loopback 在哪些条件下会被拒

入口是 `server/request-auth.ts` 的 `resolveRequestAuth()`（当前第 558 行起）。它按下面的顺序判断，任何一步失败都会直接返回 401/403：

1. **先看凭证**（第 563-597 行）。
   - `Authorization: Bearer omb_sess_…`、会话 cookie、`/api/events` 的 `ticket` 三者之一有效时，走 session 分支。
   - cookie 必须是同源请求；cookie 会话的写操作还要 `provesSameOrigin()`。
   - session 的 scope 不够时 403。
   - 这里有一条重要规则：**只要请求带了无效/过期的凭证，就不会回退成 loopback owner**（第 599-602 行）。

2. **判断是不是代理**（第 604 行，`isProxied()`）。
   - 通过 IPC 监听器进来的请求（`ipcPeer()`），或者带着任意 `X-Forwarded-For`、`X-Forwarded-Proto`、`X-Forwarded-Host`、`Forwarded` 的请求，都算代理。
   - 这类请求在 loopback 分支之外，最终得到 403：“this request came through a proxy …”。

3. **判断 Host 和 Origin**（第 605 行）。
   - `isLoopbackHost(Host)` 必须为真：`localhost`、`localhost.`、任意 `127.*`、`::1` 或 `0:0:0:0:0:0:0:1`，可以带端口。
   - `isAllowedOrigin(Origin)` 必须为真：没有 Origin，或者 Origin 的 hostname 也是回环地址，协议是 http/https。
   - Host 不是回环 → 403 “loopback host required …”。
   - Origin 存在但不是回环 → 403 “cross-origin request”。

4. **浏览器单独拦一道**（第 619 行，`fromBrowser()`）。
   - `fromBrowser()` 在请求带 `Sec-Fetch-Site` 或 `Sec-Fetch-Dest` 时判为浏览器；WebSocket 握手带 `Origin` 也判为浏览器。
   - 这是浏览器和命令行工具的关键区别：Chrome、Edge、Firefox、Safari 访问回环地址时会自动加 `Sec-Fetch-*`，网页脚本无法删除或伪造它们；`curl`、Node 的 `fetch`、桌面主进程、companion 默认不带。
   - 判为浏览器后，只有两种例外能继续：
     - 桌面端自己的窗口带了正确的 `x-eacbot-desktop-owner` 能力头，并且请求来自它自己的页面（`fromOwnPage()`）；
     - 源码开发服务器设置了 `EAC_DEV_TRUST_LOCAL_BROWSER=1`（只在 `fromSource` 且 `owner` 信任时生效，其他情况会被忽略并打警告）。
   - 两种例外都没有 → 401，错误文案就是 `BROWSER_SIGN_IN`。

5. **桌面端 mutation 能力**（第 620-622 行）。
   - 如果存在 `loopbackMutationToken`（桌面 App 启动时会设置），所有“会改变状态”的公开路由都要求桌面能力头；普通浏览器即使过了第 619 行，也会在这里 403。

6. **service 信任的白名单**（第 623-635 行）。
   - `EAC_LOOPBACK_TRUST=service`、hosted workspace、Cloud home 都会走这里。
   - 只有 `SERVICE_ALLOW` 里的路由（健康检查、身份、bot 列表、消息读取、受保护的 Slack worker 路由、`/api/internal/*` 等）能用；其他一律 403。
   - 这条规则在共享服务器上是安全边界：每个 bot 的 shell 也是 loopback 调用者，不能让它改设置、权限、密钥。

7. **最后才是远程拒绝**（第 639-645 行）。
   - 不是 loopback、又不是代理，但 Host 不是回环 → 403。
   - 其他情况 → 403 cross-origin。
   - 远程设备只有配对后的 session 能进。

所以“本机浏览器第一次打开显示 PairPage”不是静态页面被挡：`server/index.ts:12694` 在鉴权之前就把 `dist` 里的 HTML/JS/CSS 发出去了。真正被挡的是页面启动后请求的 `GET /api/auth/session`，它拿到 401，`src/main.tsx` 就渲染 `PairPage`。

## 二、可选方案与取舍

### 方案 A：所有 loopback 浏览器都当 owner（直接删掉第 619 行的浏览器判断）

优点：改动最小，一行就能让 UI 和 API 全通。

缺点：这会同时放开跨站请求。浏览器访问一个恶意网页时，网页可以：

- 用 `<img>`、`<script>`、`<link rel=prefetch>` 发没有 Origin 的 GET；
- 用顶层导航打开 `http://127.0.0.1:8799/api/...`；
- 利用已有的 `mutatingPublicRoute` 里的 GET 副作用（例如 connector card 的 status、桌面 viewer、webhook 地址）；
- 在旧浏览器或某些嵌入环境里，用没有 `Sec-Fetch-*` 的请求碰运气。

`Host` 校验能挡住 DNS rebinding，但挡不住“受害者浏览器主动访问 127.0.0.1”的跨站请求。**不采用。**

### 方案 B：只信任本服务同源页面（本方案采用）

在现有 loopback 分支里，把“浏览器”再分成两类：

- 请求来自本服务自己的页面：`provesSameOrigin(req)` 为真；
- 其他浏览器请求：仍然 401。

`provesSameOrigin()` 的规则是（第 208-211 行）：

- 有 `Origin`：`Origin` 必须和 `requestOrigin(req)` 完全一致；
- 没有 `Origin`：必须有 `Sec-Fetch-Site: same-origin`；
- 两者都没有：失败（fail closed）。

它比 `fromOwnPage()` 更严格：`fromOwnPage()` 允许 `Sec-Fetch-Site: none`，也就是允许地址栏导航；`provesSameOrigin()` 不允许。这样，恶意页面把用户导航到某个会改状态的 GET 也不成立。

优点：

- UI 自己发的 `fetch`、`EventSource`、WebSocket、表单、下载、上传都带同源证明，能直接用；
- 跨站页面、其他本地端口、`Origin: null` 的 sandbox iframe、地址栏导航都被挡住；
- 不需要新 cookie、不需要新环境变量、不改前端；
- 只影响 `owner` 信任下的本机页面，service / 远程 / 桌面端边界不动。

缺点：

- 它把“本服务自己的页面”当成可信代码。只要页面同源，页面里的脚本就有 owner 权限；这本来就是登录后 cookie 会话的性质，但现在“从未登录”的本机页面也有。
- 需要接受一个残余风险：同源 XSS 或同源主动内容（例如被直接打开的 SVG）会拿到 owner。下面会单独分析，并说明为什么当前代码面可以接受。

### 方案 C：保持拒绝，改成 CLI 打开带一次性 token 的链接

优点：不产生“环境权限”（ambient authority），最符合原来的“浏览器永远不是 owner”模型；远程边界最干净。

缺点：

- 需要改 `eacbot serve` / `server/index.ts` / 会话签发和 cookie 逻辑，超出 `request-auth.ts` 的最小改动；
- 用户手动在地址栏打开 `http://127.0.0.1:8799` 仍然会看到 PairPage，和这次“第一次打开不必登录”的目标不完全一致；
- 仍然需要一次“交换 token”的动作，只是把它藏起来。

如果产品要求“浏览器绝不能拥有环境权限”，应选 C，而不是本方案。

### 方案 D：只放开读接口，写接口仍要求配对

优点：风险比 B 小。

缺点：UI 能打开，但发消息、改设置、批准卡片都会 403，用户会认为应用坏了；不满足“可构建可运行、本机可用”的目标。**不采用。**

## 三、最小改动

只改 `server/request-auth.ts` 第 619 行附近的一段判断：

```ts
const browser = fromBrowser(req);
if (browser && !desktopOwner && !options.trustLocalBrowser) {
  const ownPageOwner = options.loopbackMutationToken === undefined &&
    options.loopbackTrust !== "service" &&
    provesSameOrigin(req);
  if (!ownPageOwner) return deny(401, BROWSER_SIGN_IN);
}
```

三个条件缺一不可：

- `options.loopbackMutationToken === undefined`：桌面 App 的私有能力通道保持原样。桌面端自己的 Electron 窗口已经带 owner 头；普通浏览器打开桌面端端口仍然需要配对，避免绕过桌面 mutation 保护。
- `options.loopbackTrust !== "service"`：hosted workspace、Cloud home、显式 `service` 信任都保持“浏览器必须登录”。这是防止“共享服务器上 bot 的浏览器直接当 owner”的关键。
- `provesSameOrigin(req)`：只接受本服务自己的页面，连其他本地端口都不行。

影响的路由：

- `GET /api/auth/session`：本机同源页面从 401 变成 200，返回 `{ kind: "loopback", scopes: ["admin", "client"] }`；前端因此进入 App。
- 所有在 `server/index.ts` 鉴权门之后的 `/api/*`：本机同源页面按 owner 的 `admin` + `client` scope 访问，包括设置、bot、消息、任务、Webhook、备份等。
- 同源 WebSocket / EventSource / 文件下载 / 上传：`provesSameOrigin` 都能通过。
- 静态 `/`、`/pair`、`/assets/*`：本来就在鉴权之前，行为不变。
- 非回环、代理、`service`、桌面端、已配对 session、CLI、companion：行为不变。
- `/api/health`、`/api/brand`：本来就是公开的，行为不变。

没有数据迁移，没有新配置项，没有新 cookie。回滚只需要把上面这段恢复成原来的一行判断。

## 四、安全分析

### 4.1 什么情况下会被误判为本地

| 场景 | 会不会被本方案当成 owner | 原因 |
|---|---|---|
| 本机同源页面（`http://127.0.0.1:8799` 自己的 HTML/JS） | 会，这是目标 | Host 回环 + `Origin`/`Sec-Fetch-Site` 完全同源 |
| 本机其他端口的页面（`http://127.0.0.1:3000`） | 不会 | `isSameOrigin` 比较端口，`same-site` 不够 |
| 本机 `file://` 打开的 HTML | 不会 | `Origin` 是 `null`，`isAllowedOrigin` 直接拒绝 |
| sandbox iframe（`Origin: null`） | 不会 | 同上；和当前 cookie 会话的规则一致 |
| 公网/局域网页面直接 fetch 回环 | 不会 | Origin 不是回环；Host 也不是回环 |
| 恶意网页用 `<img>`、`<form>`、`<a>` 触发回环 | 不会 | 没有同源 `Origin`，`Sec-Fetch-Site` 是 cross-site/none，`provesSameOrigin` 失败 |
| 恶意网页用 `window.open` 打开回环页面 | 页面本身能打开（静态资源公开），但页面里的 API 请求是新页面的同源请求；新页面是应用自己的代码 | 打开的是应用，不是攻击者能注入代码的页面；攻击者读不到它的 DOM |
| 通过反向代理进来的远程请求 | 不会 | 有 `X-Forwarded-*` 时 `isProxied` 直接拒绝；没有转发头但 Host 是公网时 `isLoopbackHost` 拒绝 |
| 通过本地代理、且代理把 Host 改写成 127.0.0.1、又清掉所有转发头 | 可能，取决于代理是否也改写 Origin | 这是代理配置/被攻陷，不是浏览器能单独做到的；见 4.3 |
| 本机其他进程/恶意软件 | 会；但这是现有模型 | owner 信任本来就信任所有本机程序，不依赖浏览器 |
| 浏览器扩展/DevTools 伪造头 | 可能；属于本机受信软件 | 扩展本身能读页面、改请求；不在“网页内容”边界内 |

### 4.2 DNS rebinding

DNS rebinding 的攻击步骤是：受害者先访问攻击者的域名（例如 `http://evil.example:8799`），攻击者把该域名的 DNS 重新解析到 `127.0.0.1`，让页面以“自己的源”去请求本机服务。

本方案下它不成立：

1. 浏览器发出的请求 `Host` 仍然是 `evil.example:8799`，不是回环地址；
2. `isLoopbackHost(Host)` 返回 false，请求在 loopback 分支之外，最终 403；
3. 即使页面用 `http://127.0.0.1:8799` 作为目标，那个源也不是攻击者的源，`Origin` 会是 `http://evil.example:8799`（跨源），`provesSameOrigin` 失败。

如果把服务绑定到 `0.0.0.0` 或局域网地址，远程请求的 Host 不是回环，仍然只能配对；这一点和这次改动无关。

### 4.3 代理头伪造

浏览器 JS 不能设置 `Host`、`Origin`、`Sec-Fetch-*`、`X-Forwarded-*` 这些受保护的头；这些值由浏览器或代理生成。

- 远程客户端经反向代理进来时，代理通常会加 `X-Forwarded-For` / `X-Forwarded-Proto`。`isProxied()` 看到任意一个就拒绝 loopback 信任，所以不会因为“代理把 peer 变成 127.0.0.1”而误判。
- 如果代理清掉了所有转发头，但保留了公网 Host，`isLoopbackHost` 仍然拒绝。
- 如果代理既清掉转发头，又把 Host 改写成 `127.0.0.1`，但保留浏览器的公网 `Origin`，`isSameOrigin` 仍然拒绝。
- 只有代理同时改写 Host 和 Origin，才会让远程请求看起来像本机同源。这已经是代理主动伪造浏览器头，属于反向代理配置错误或被攻陷；现有模型也无法在这种情况下区分。部署要求是：反向代理必须保留原始 Host/Origin，并设置 `X-Forwarded-*`，让服务按远程请求处理。

### 4.4 现有 Host / Origin 校验够不够

对本方案来说够用，原因是它把“同源”定义得比原来的 `isAllowedOrigin` 更窄：

- `isAllowedOrigin` 只要求 Origin 的 hostname 是回环，允许不同端口；它只用于判断“是不是 loopback 候选”。
- 新增的 `provesSameOrigin` 用 `requestOrigin(req)` 做完整字符串比较，包含协议、主机、端口。`127.0.0.1:8799` 和 `127.0.0.1:3000`、`localhost:8799` 和 `127.0.0.1:8799` 都不同源。
- `requestOrigin` 只信 Host；`X-Forwarded-Proto` 只在没有代理头时才会被使用，而带代理头的请求已经被 `isProxied` 拒绝，所以不存在“用 `X-Forwarded-Proto: https` 把 http 请求伪装成同源”的路径。
- 没有 Origin 时要求 `Sec-Fetch-Site: same-origin`；两者都没有就失败。这是 fail closed。
- `Host` 校验只接受回环字面量，不接受 `localhost.evil.com`、`127.0.0.1.nip.io`、`[::ffff:127.0.0.1]` 等变体；IPv6 只接受 `::1` / `0:0:0:0:0:0:0:1`。

一个需要注意的限制：`isLoopbackHost` 接受任意 `127.*`，这是 IPv4 回环网段的正常做法；它不等于“只有 127.0.0.1 才能访问”。如果机器上有其他 127.x 地址的监听，仍属于本机回环。

### 4.5 残余风险

1. **同源 XSS / 同源主动内容。** 新规则把本服务自己的源当成 owner。只要攻击者能让脚本在本服务源里执行（例如直接打开一个同源 SVG、或应用里存在 XSS），脚本就能调用 owner API。当前缓解：
   - 上传只允许 PNG/JPEG/GIF/WebP，明确拒绝 SVG、HTML、脚本（`server/attachments.ts:65-106`）；
   - 消息文件非图片走 `content-disposition: attachment`；图片预览要求 `image/*` 且带 `nosniff`（`server/routes/threads.ts:254-275`）；
   - 发布页/页面文件在 sandbox CSP 下，`Origin` 为 opaque，不能读应用源（`server/page-files.ts` 的 `content-security-policy: sandbox allow-scripts`）；
   - 静态 HTML 带 `frame-ancestors 'none'` / `X-Frame-Options: DENY`，不能被第三方 iframe 套住。

   仍建议后续给所有同源 SVG 响应加 `Content-Security-Policy: sandbox` 或强制下载；这次不改 `server/routes/threads.ts`，避免超出职责。

2. **本机多用户/恶意软件。** owner 信任原本就信任所有本机进程；本方案没有增加“另一个本机用户”的能力，因为对方本来就能用 `curl`。但它确实让“另一个本机用户的浏览器”也能打开 UI；如果机器是多用户共享的，应使用 `EAC_LOOPBACK_TRUST=service`，而不是 owner。

3. **桌面端普通浏览器。** 本方案特意不放开桌面端的 `loopbackMutationToken` 通道。桌面 App 的 Electron 窗口已经能工作；普通浏览器打开桌面端端口仍然需要配对。这是有意的：桌面端同时运行多个 bot，不能让任意本机浏览器绕过 mutation 能力头。

4. **service / Cloud / hosted。** 全部保持浏览器必须登录。共享服务器上 bot 的浏览器不会因为这次改动获得 owner。

5. **开发模式的 `EAC_DEV_TRUST_LOCAL_BROWSER=1`。** 它仍然比本方案宽（允许 Vite 的另一个端口），但只在源码开发 + owner 信任下生效，构建产物、桌面、hosted、Cloud 都会忽略。生产环境不依赖它。

## 五、实施与验证

实施前检查：

- `server/request-auth.ts` 的 `resolveRequestAuth` 仍是当前结构（按符号名复核，不按行号硬编码）；
- `provesSameOrigin` 仍然要求 Origin 完全匹配，或缺 Origin 时 `Sec-Fetch-Site: same-origin`；
- `isProxied` 仍然拒绝任意转发头；
- 服务仍只监听 `127.0.0.1`（`server/index.ts:15506`）。

测试矩阵：

| 请求 | 期望 |
|---|---|
| 本机同源页面 GET `/api/auth/session` | 200，`kind: loopback`，`scopes: [admin, client]` |
| 本机同源页面 GET `/api/bots`、PATCH `/api/config` | 200 / 不被鉴权拒绝 |
| 本机同源 WebSocket 握手 | 通过鉴权（不是 401） |
| 跨站页面（`Sec-Fetch-Site: cross-site`，Origin 为外部） | 401 `BROWSER_SIGN_IN` |
| 同站不同端口（`Origin: http://127.0.0.1:3000`，`same-site`） | 401 |
| 地址栏导航（`Sec-Fetch-Site: none`） | 401 |
| `Origin: null` 的 sandbox iframe | 403 cross-origin |
| service 信任下的同源页面 | 401 `BROWSER_SIGN_IN` |
| 桌面端能力通道下、无 owner 头的同源页面 | 401 |
| 非回环 Host / 代理头 | 403，文案不变 |
| 已配对 cookie 会话 | 仍按 session scope 工作 |

验证命令：

```sh
pnpm typecheck
pnpm exec vitest run server/request-auth.test.ts server/request-auth.e2e.test.ts
```

如果 `pnpm typecheck` 被并行小组的未完成文件挡住，会单独记录失败文件和原因，不把别人的类型错误算到本改动。

## 六、结论

方案 B 满足“本机浏览器第一次打开不必登录”，同时把权限限制在“本服务自己提供的同源页面”。它不放宽远程访问，不放宽 service / Cloud / hosted，不放宽桌面端的私有 mutation 通道。剩余的主要风险是同源 XSS / 同源主动内容；当前上传和页面文件的安全措施把这个面压得较小，但后续仍应补同源 SVG 的 CSP/下载策略。

如果产品要求“浏览器永远不能拥有任何环境权限”，应改走方案 C（CLI 一次性 token），而不是把本方案继续放宽。
