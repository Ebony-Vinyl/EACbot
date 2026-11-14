# 09 盲区扫描：未被岗位覆盖的限制、外发与远程控制

扫描开始时间：2026-11-14 12:25（Asia/Shanghai）；报告定稿时间：2026-11-14（具体时刻未单独记录；不晚于本文件提交时间 12:40:59）  
仓库：`D:\workspace\EACbot-clean-core`，分支 `codex/clean-core`，基线 `781c57e`；扫描期间 HEAD 前进到 `b5ca7fd`，工作树还有多项并行修改。  
口径：只读代码，不修改、不联网、不 push；每条都有 `文件:行`。已与 `01-backend-egress.md` 至 `07-quota.md` 逐份对照，**不重复它们已收录的条目**；只补这些报告明确未覆盖、或完全没人看的模块。  
筛选标准：只保留真正会拦人（正常功能被拒绝/静默消失/必须额外权限）、会外发（用户数据或凭据离开本机）、会远程控制（外部可改变本机行为）的逻辑。纯业务逻辑、正常鉴权、合理的安全边界不计入。

## 一、MCP（01/02 只覆盖了 MCP 超时、数量上限和用户自配地址，未覆盖门控与生命周期）

| 编号 | 文件:行 | 问题 | 性质 | 严重度 | 建议 |
|---|---|---|---|---|---|
| M-01 | `server/mcp-registry.ts:135`；`server/mcp-http.ts:260-267` | `urlError()` 只检查协议是 `http:` 或 `https:`，不要求非回环地址必须 HTTPS；`RemoteMcpClient.headers()` 会把 `Authorization` 等 header 原样发出。添加 `http://` 远程 MCP 后，Bearer/API key 明文过网。 | 外发 | 高 | 非回环地址强制 HTTPS；`http://` 只允许 localhost/127.0.0.1/::1；已有 http 条目在启用时拦截或提示。 |
| M-02 | `server/mcp-health.ts:13,73,123-125`；`server/mcp-probe.ts:53` | 一次探活失败（stdio 超时 8 秒或启动失败）后，`usable()` 会把该 server 从所有回合中过滤掉，失败结果缓存 `RECHECK_FAILED_MS = 30 * 60_000`；下一回合还会先等首次探活，最长卡 8 秒。工具会静默消失半小时，模型只看到少了一个 server。 | 限制 | 中 | 失败只提示并在下一回合重试；30 分钟退避改可配置；首次失败不要直接 unmount；探活与回合解耦。 |
| M-03 | `server/mcp-registry.ts:324-326`；`server/routes/mcp-servers.ts:156-166` | `enabledFor()` 在 `mutation && !existing` 时固定返回 `false`，忽略请求里的 `enabled: true`。`POST /api/mcp/servers` 返回成功，但新 server 仍关闭，调用方以为已添加。 | 限制 | 低 | 手动添加允许 `enabled: true` 一步生效；只有 bot 添加或导入保持默认关闭，并在响应里明确 `enabled: false`。 |
| M-04 | `server/host/mcp-requests.ts:95-98` | MCP 变更卡在 `behavior === "allow" && !ownerReview` 时返回 403；只能从桌面或 paired Full-access 设备批准，本地浏览器、手机和普通会话无法批准，卡片会一直等待。 | 限制 | 中 | 把 `ownerReview` 的来源做成可配置；本地回环会话默认允许，或提供一次性配对批准；错误里说明可用批准端。 |
| M-05 | `server/mcp-gate.ts:220-221` | `childEnv = { ...process.env, ...spec.env }` 只删除 `EAC_GATE_` 前缀，没有调用 `stripWorkspaceCredentialEnv`。自定义 stdio MCP server 会继承父进程未清理的 provider key、`GITHUB_TOKEN`、`AWS_*` 等环境变量。 | 外发 | 中 | spawn 前按 `PROVIDER_CREDENTIAL_ENV` 清理，只传 PATH、系统变量和该 server 自己的 `spec.env`。 |
| M-06 | `server/host/mcp-config.ts:79-83` | `probeAsBots()` 在 broker 探活失败且直连成功时回退到 `probeMcpServer(target, ...)`，`target` 仍带 `headers`。Cloud 的 broker/凭据隔离被绕过，Test 会从宿主机直接把存储的 header 发到目标地址。 | 外发 | 中 | 回退只做无凭据探测；有 header 的 server 失败就报 broker 故障，不从宿主机直连；记录审计事件。 |
| M-07 | `server/mcp-oauth.ts:648-660` | `withoutPendingSignIn()` 把 `authState === "needs-sign-in"` 的 URL server 从挂载表过滤；refresh 失败或没有 refresh token 后，server 的工具静默消失，模型只看到少了一个 server。 | 限制 | 中 | 把“需要重新登录”作为可见状态传给引擎或用户；不要静默 unmount，至少注入说明并保留条目。 |
| M-08 | `server/mcp-oauth.ts:471-475` | `preferredPort()` 把回调端口固定为 20000–39999 的哈希值；`listen()` 失败时，若该 server 已有注册 client 就直接抛 `port-busy`，不退回随机端口。端口被占用时预注册 OAuth 无法登录。 | 限制 | 中 | 预注册 client 也允许多个 redirect URI，或端口占用时提示改端口；不要把固定端口失败当终态。 |
| M-09 | `server/host/mcp-config.ts:160-170` | `addMany()` 只要 `blocked.length` 就整体返回 403，一个被策略拒绝的 server 会让整批导入失败；只要有一个重名也整体 409。 | 限制 | 中 | 支持跳过并报告被拒条目，或先预览再确认；至少返回逐条结果，不要 all-or-none。 |
| M-10 | `server/host/mcp-config.ts:89-92` | `personalHeaderValueRefusal()` 对 personal + remote + `sendsCredentials` 返回 400；共享配置不能保存个人 server 的 header，Team Cloud 成员在设置页保存 key 会被拒。 | 限制 | 中 | 允许 personal server 的 header 存入个人作用域，不要一刀切拒绝；或在 UI 引导到个人连接。 |
| M-11 | `server/mcp-remote-proxy.ts:326-327` | `deadline = message.method !== "tools/call" ? 30_000 : directory ? 120_000 : undefined`；目录模式把 `tools/call` 硬截到 120 秒，长任务在第 121 秒被 abort，返回 `MCP request cancelled`。 | 限制 | 中 | 把 120 秒做成 server 级配置，或交给引擎自己的 tool deadline；目录模式不要额外缩短调用寿命。 |
| M-12 | `server/mcp-tool-schema.ts:118-120` | `fitToolList()` 在 `fit.outcome === "dropped"` 时 `continue`，整个 tool 从 `tools/list` 消失；provider 的 `maxSchemaBytes` 容不下 schema 时，模型看不到该工具，也收不到“被省略”的条目。 | 限制 | 中 | 不要丢工具；保留 name 和最短 schema，或降级为可查询的 `describe_tool`；至少回传被省略的 tool 名和原因。 |
| M-13 | `server/host/mcp-sign-in-cards.ts:131-135` | `mayAuthorize()` 对非 personal 的共享 server 要求 `auth.scopes.includes("admin")`；普通成员或手机会话点授权返回 409。共享 MCP 的登录被硬编码成管理员操作。 | 限制 | 中 | 把共享 server 登录改成 owner/admin 可配置；至少允许成员用自己的账号完成 OAuth，不共享 token。 |
| M-14 | `server/host/mcp-sign-in-cards.ts:237-238` | `request()` 在 personal server 且 `turnPerson(threadId)` 为 null 时返回 409；群聊或共享会话里没有人能替个人 server 登录。 | 限制 | 低 | 在共享会话里显示“请到个人设置登录”，并提供每人独立的登录入口；不要直接拒绝整张卡。 |
| M-15 | `server/host/mcp-sign-in-cards.ts:162` | `authorize()` 在 `browser.remote && server.oauth` 时返回 409 `inSettings`；预注册 OAuth client 的 server 无法从远程浏览器登录，只能回本机 Settings。 | 限制 | 低 | 允许预注册 client 使用公网回调地址，或在远程端提供 paste-back；至少把限制写进 UI。 |
| M-16 | `server/mcp-app-observer.ts:150-159` | `postAppReport()` 把 `call.arguments`、`result.content/structuredContent` 和 `Bearer mount.token` POST 到 `harnessUrl`；`parseAppMount()`（`:42-44`）只校验 http/https，不校验回环。当前生产值是 127.0.0.1，但集成环境一旦指向远端，MCP app 的完整入参和结果会静默外发。 | 外发 | 低 | 强制 `harnessUrl` 为回环或显式 allowlist；发送前脱敏；不要把完整 `structuredContent` 默认上报。 |

小结：MCP 组 16 条，高 1 条、中 11 条、低 4 条。

## 二、网络入口、鉴权与出站审批（01/02 只覆盖了绑定地址、配对和 webhook 限流，未覆盖下列具体绕过与数据暴露）

| 编号 | 文件:行 | 问题 | 性质 | 严重度 | 建议 |
|---|---|---|---|---|---|
| N-02 | `server/request-auth.ts:179-189,604-606` | `isProxied()` 只认 `ipcPeer` 或 `X-Forwarded-*`/`Forwarded` 头；`loopback` 只看 `Host`/`Origin`，不校验 `req.socket.remoteAddress`。SSH `-L`、socat、nginx `stream` 等 TCP 转发不会加这些头，远程 curl 会被当成本机 owner，绕过配对。11 号方案只把“恶意代理改写 Host”列为残余风险；这里补充：SSH `-L`/socat 的**正常用法**就会命中，不需要恶意代理。 | 远程控制 | 高 | loopback 额外要求 socket 对端是 127.0.0.1/::1 且无转发迹象；或要求本机 owner token，不把 Host 当身份。 |
| N-03 | `server/webhook-requests.ts:1-2,156-215`；`server/index.ts:13469-13481` | webhook 的 create/update/pause/resume/delete 立即生效，卡片是 `options: []`、`answered: "allow"`、`autoApplied: true` 的回执；`/api/internal/trigger-requests` 只挡 `cloudGuestDriven`，不挡 `outsideDrivenThread`。事件驱动的 turn 可被事件内容注入后改写或删除现有 webhook 的 prompt，下一次投递即执行，无需人工批准。 | 远程控制 | 高 | 给 create/update/delete 加人工审批；`outsideDrivenThread` 直接 403；回执只允许 Undo，不承载即时生效。 |
| N-04 | `server/webhook-requests.ts:47`；`server/webhooks.ts:296-325,768-776` | `runOn: z.enum(["maus","cloud"])` 允许把 webhook 触发设为 `cloud`；`eventPrompt` 把第三方事件体原样拼进 prompt，`enqueue` 以 `runOn: trigger.runOn` 发到 Cloud 电脑执行。默认是 `maus`，但 bot 可在 create/update 中选 cloud，且变更自动生效。 | 外发 | 中 | 默认锁定 `maus`；选 `cloud` 需在卡片中明示并审批；事件体脱敏/限长。 |
| N-05 | `server/webhook-ingress.ts:157-169,207-213` | `advertisedWebhookBase` 只要求 `http:` 或 `https:`，而 `webhookCredential` 把 secret 直接拼进 URL 路径：`url: ${endpointUrl}/${encodeURIComponent(secret)}`。公网 `http://` 或任何记录 URL 的反向代理/应用日志都会 capture 完整 secret；泄露后任何人可向该 webhook 投递并触发 bot。 | 外发 | 中 | 公网 base 强制 https；默认只返回 `endpoint` + `Authorization: Bearer`；代理/应用日志脱敏。 |
| N-06 | `server/routes/webhooks.ts:21-25`；`server/request-auth.ts:389`；`server/webhooks.ts:279-280,858` | `GET /api/webhooks` 是 client 路由，返回 `attempts`；每条 attempt 的 `preview = previewPayload(payload).slice(0, 2_000)` 是原始事件体前 2000 字符。任何能看见该 bot 的只读成员都能读到 GitHub/Stripe 等事件里的 token、邮箱、订单信息。 | 外发 | 中 | attempts 仅 admin 可见；或只返回 outcome/status/time，不返回 payload preview。 |
| N-07 | `server/webhook-ingress.ts:176,203`；`server/index.ts:653`；`server/cli.ts:780`；`server/tunnel.ts:254`；`server/caddy.ts:112-115` | `listenWebhookIngress` 默认只监听 `127.0.0.1`，`baseUrl` 回退为 `http://127.0.0.1:<port>`；`serve --domain` 的 Caddy 已把 `/hooks/*` 转到 webhook 端口，但 CLI 只设置 `EAC_PUBLIC_URL`，进程只读 `EAC_WEBHOOK_PUBLIC_URL`，地址仍广告为回环；`--tunnel` 也不转发 webhook 端口。远程 app 拿到的地址不可达。 | 限制 | 中 | `--domain`/`--tunnel` 时自动设置 `EAC_WEBHOOK_PUBLIC_URL`；`--tunnel` 显式转发 `/hooks`；地址卡区分本地/公网。 |
| N-08 | `server/webhook-ingress.ts:157-170,177-178`；`server/index.ts:9590-9598` | `advertisedWebhookBase` 在创建 listener 之前调用；`EAC_WEBHOOK_PUBLIC_URL` 不是绝对 http(s)（例如漏了 `https://`）时直接抛错，`listenWebhookIngress` 失败，`webhookIngress` 为 null，整个接收器不可用，所有 webhook 投递失败，而不是只显示地址错误。 | 限制 | 中 | 先启动 listener；public base 解析失败时回退本地 `baseUrl` 并给出警告。 |
| N-09 | `server/guarded-requests.ts:38-41` | `if (messages.some(message => message.parentId && ancestors.has(message.parentId) && !seen.has(message.id))) throw requestConflict()` 会拒绝活动路径上的任何 sibling；普通编辑/重新生成都会产生 sibling，于是 guarded 请求 409 `The request no longer owns this conversation`，即使分支上没有待处理卡片。 | 限制 | 中 | 只拒绝带 requestId/审批/结果卡片的 sibling，或只检查 source 之后的 sibling；普通文本分支应放行。 |
| N-10 | `server/outbound-requests.ts:75-79` | `outboundCard` 把每个调用的 arguments 序列化后 `slice(0, 400)`；卡片数据 `calls` 只有 app/label，审批人看不到第 400 字符之后的正文。长邮件/长消息/带链接的内容可在用户点 Allow 时隐藏，审批保护被绕过。 | 外发 | 中 | 审批卡提供完整参数/展开全文；超过阈值要求二次确认；不要把截断后的摘要当唯一依据。 |
| N-11 | `electron/data-dir-lease.mjs:508-514`；`server/data-dir-lease.ts:2-7` | lease 用 `linkSync(candidatePath, leasePath)` 原子创建；`error?.code !== "EEXIST"` 一律抛错。exFAT/FAT32、部分 SMB/NFS 网络盘不支持硬链接，会抛 EPERM/ENOTSUP，`acquireDataDirLease` 失败，EACbot 拒绝启动；用户无法把数据目录放在这些盘上。 | 限制 | 中 | 不支持硬链接的卷回退到 `O_EXCL` 创建 + 原子 rename/目录锁；错误信息说明卷不支持硬链接。 |
| N-12 | `electron/data-dir-lease.mjs:56-60,519-523`；`server/data-dir-lease.ts:2-7` | `sameMachine` 只认 `record.host === hostname()` 或 boot id；Windows 没有 boot id（`bootSession()` 返回 null），只认 hostname。把数据目录从旧电脑复制/恢复，或改了主机名，旧 lease 被判为 another machine，启动直接拒绝，只能手动删 `eacbot-server.lease`；桌面端没有接管入口。 | 限制 | 中 | 桌面端提供“接管此目录”确认（校验备份来源/目录属主）；给迁移路径而不是硬拒绝。 |
| N-13 | `electron/data-dir-lease.mjs:243-246,296-299`；`server/data-dir-lease.ts:2-7` | Windows 上 `processCreationTimeMs` 先 `wmic` 再 PowerShell/CIM；两者都失败时返回 null，`ownerIdentityMatches` 的 `if (created === null) return true` 直接把该 PID 当作 lease 仍存活。崩溃后 PID 被复用，EACbot 永远报 already using this data directory，只能手动删 lease。 | 限制 | 中 | 创建时间不可读时不要判定 alive；结合 createdAt/uptime 或要求人工确认；提供 `--force-recover`。 |
| N-15 | `server/request-auth.ts:54`；`server/index.ts:12963-12974` | `SERVICE_ALLOW` 放行 `POST /api/testing/internal-capability`；该路由只检查 `EAC_TEST_INTERNAL_CAPABILITY_KEY` 非空和长度相等，没有最小长度/熵要求（同文件 org-library 测试 key 要求 `expected.length < 32` 即 404）。短 key 可被任意 bot shell 猜中，mint 任意 bot/thread 的 internal capability（可带 computer/data/email/device 权限）。 | 远程控制 | 中 | 测试 key 加最小 32 字符/熵检查；生产构建禁用该路由；或要求 admin session。 |
| N-16 | `server/request-auth.ts:143-152,157-165,619` | `EAC_DEV_TRUST_LOCAL_BROWSER=1` 时，浏览器请求只要 `isAllowedOrigin` 通过就获得 owner；`isAllowedOrigin` 只校验 host 是否 loopback，不校验端口。本机任意端口的网页都能改设置、批准卡片。 | 远程控制 | 低 | 校验完整 origin/端口，只信任 Vite 端口；默认关闭，warning 改为拒绝。 |
| N-17 | `server/host/webhook-room-post.ts:68-72` | `parseRoomPostPayload` 要求顶层 `text` 为非空字符串，否则 400；GitHub/Stripe 等以 JSON 对象投递的 webhook 没有顶层 `text`，房间投递全部失败。 | 限制 | 低 | 支持可配置 JSON path，或把对象序列化为 text；在 webhook 设置里给出示例。 |
| N-18 | `server/host/webhook-room-deps.ts:55-63`；`server/host/webhook-room-post.ts:138-140` | 带 `voiceNote` 的 room webhook 会调用 `tts.speak`，把 webhook 文本发到 TTS 提供方（可能是云）；这条出站不经过 `outbound-hold` 的 ask/allow 规则，持有 webhook secret 的发送方即可触发 TTS 调用和计费。 | 外发 | 低 | 把 TTS 记为出站/计费动作，沿用 bot 的 outbound 规则或在 webhook 设置里显式开关；限制频率。 |
| N-19 | `server/guarded-requests.ts:35` | `if (path.length >= 500) throw ... status: 413` 是硬上限；从 source 到 active leaf 的路径达到 500 条消息时，即使当前请求就在叶子上，guarded 接口也会拒绝。 | 限制 | 低 | 提高上限或分页/摘要；错误信息给出当前长度和可操作路径。 |
| N-20 | `server/outbound-hold.ts:12-13,31-36,53-104`；`shared/outbound.ts:107-108` | 没有为 bot 保存 `outbound` 规则时，`DEFAULT_OUTBOUND_POLICY` 是 `{"policy":"ask"}`：每一次 Connector 外发都会弹“Send on your behalf?”卡，等待 `OUTBOUND_HOLD_MS = 9 分钟`，无人应答就拒绝，且不能自动重试。只有 Full access 且没有自己的规则、或显式设为 `allow` 才直接发送。 | 限制 | 中 | 保留询问默认，但允许按 connector/动作设“本次会话内允许”；超时后给一次重新询问入口，不要把 9 分钟当成硬失败。 |

说明：原 N-01（`SERVICE_ALLOW` 跨 bot 路由）和 N-14（hosted 上 `EAC_LOOPBACK_TRUST=owner` 只警告）经对照已被 `06-account.md` 收录，故从本表移出，不重复计数。  
小结：网络组 18 条，高 2 条（N-02、N-03）、中 12 条、低 4 条。

## 三、浏览器（01 明确说未审计浏览器内的出站与表单行为，02 只覆盖了 15 秒动作超时）

| 编号 | 文件:行 | 问题 | 性质 | 严重度 | 建议 |
|---|---|---|---|---|---|
| Br-01 | `server/browser/egress/registry.ts:145`；`server/browser/egress/policy.ts:121-128`；`server/host/browser.ts:213` | 桌面端未设置 `browserEngine.egress.localNetwork` 时，`config?.localNetwork !== false` 得到 `true`；`policy.ts:121-128` 对 Private 地址直接放行。bot 打开的任意页面可访问 `192.168.x.x`、`10.x`、`172.16.x.x` 等内网地址（路由器管理页、NAS、内网后台），egress gate 的私网隔离默认失效；桌面设置页没有这个开关。 | 外发 | 中 | 桌面默认改为 `false`；`localhost`/`127.0.0.1` 仍由 `namesThisMachine` 放行，不影响本地开发服务器。增加桌面开关和 CIDR 白名单，开启时明确提示“bot 可访问局域网”。 |
| Br-02 | `server/browser/egress/reddit.ts:4-33`；`server/host/browser.ts:169-172` | `refusesReddit()` 仅在 `host === "cloud"` 时拒绝 `REDDIT_HOSTS`；`RuntimeRouter.refusal` 在调用到达浏览器前返回 `REDDIT_REFUSAL`，SOCKS gate 也按名字拒绝。EACbot Cloud 上所有 Reddit 域名都打不开，用户即使接受 Reddit 条款也没有本地覆盖开关。 | 限制 | 中 | 改成可配置策略：默认提示并拒绝，允许用户显式承担风险后放行；保留 `REDDIT_REFUSAL` 说明。 |
| Br-03 | `server/host/browser.ts:209-213`；`server/browser/egress/registry.ts:145-146` | `hostedServer = egressHost === "server" && Boolean(deps.HOSTED_WORKSPACE)`；随后 `config: () => (hostedServer ? undefined : cfg.browserEngine?.egress)`。托管工作区把管理员写入的 `egress.allow`/`localNetwork` 整体丢弃，`rules()` 退化为 `localNetwork: false`、`allowed: allowList(undefined)`，任何私网地址都被拒绝，内网系统/自建服务无法放行。 | 限制 | 中 | 为 hosted workspace 提供组织级 allowlist；或在校验时明确拒绝并提示“该设置在此部署无效”，不要静默忽略。 |
| Br-04 | `server/browser/egress/policy.ts:42-48,58-71` | `browserEgressConfigSchema.allow` 的每项都要经过 `parseAllowEntry()` 的 `isIP(network)` 校验，只接受 IP/CIDR（可带端口），不接受域名。只以 `intranet.example.com` 提供的内网站点无法加入白名单，只能放开整个 `localNetwork` 或写死 IP。 | 限制 | 中 | 支持域名白名单并在解析时固定 IP（防 DNS 重绑定），或提供“按域名放行”的独立配置，并写清 IP-only 限制。 |
| Br-05 | `server/browser/lent-chrome.ts:88-104,147-163`；`server/browser-engine.ts:599-603`；`server/host/browser.ts:312-318` | `LentChromeDoors` 在 `127.0.0.1` 开一个带 32 字节 token 的 WebSocket 门，`#connect()` 通过 `route.open()` 把 Cloud 的 CDP 连接接到借出电脑的 Chrome；`lentChromeDoor()` 在 My Chrome profile 下把该 URL 作为 `AGENT_BROWSER_CDP`。开启 lending 后 Cloud 侧获得本机 Chrome 的浏览器级控制通道，可读取/操作页面与登录态；代码本身不按标签限制，现有门槛只有 `lending.chrome`、`live()` 和 Chrome 的 Allow 提示。 | 远程控制 | 中 | 默认关闭；每次连接要求本机显式确认并显示常驻指示；限制到选定标签页或窗口，提供一键断开，并记录谁在何时驱动了哪个标签。 |
| Br-06 | `server/browser/egress/home-sites.ts:4-25`；`server/browser/egress/registry.ts:150-172` | `HOME_SITES` 写死 8 个基础域名（Instagram、YouTube、Google 及媒体域）和 Google 国家级域名正则；只有这些域在 My Cloud 上走借用电脑的出口，其他被数据中心风控的站点仍从 Cloud 出口。遇到 429 或 unusual traffic 时用户不能添加域名，只能等 Cloud 更新。 | 限制 | 低 | 把 `HOME_SITES` 做成 Cloud 可下发或用户可编辑的列表，或提供“全部走本机出口”的开关，并在 UI 标注当前路由。 |
| Br-07 | `server/browser/egress/registry.ts:17-20,28-35,76-82`；`server/browser/egress/policy.ts:121-130` | `SERVER_PORTS` 写死 `8080, 2019` 及 fleet 端口，`OwnListeners.has()` 对这些端口无条件返回 `true`；在自建服务器开启 `localNetwork` 后，`refusalFor()` 对私网地址先命中 `ownPort(port)` 并返回 `"omb"`。本机 8080/2019 上的其他开发或代理服务也会被当成 EACbot 自身而拒绝。 | 限制 | 低 | 只在确认监听者属于 EACbot 时屏蔽，不要仅凭静态端口号；把静态列表做成可配置。 |
| Br-08 | `server/routes/browser-viewers.ts:131-143`；`server/browser/viewers/live-v1.ts:201,265-322` | v1 的 `GET …/browser/live` 直接 `viewers.open()`，没有传 `canOperate`；`LiveV1.open()` 固定 `canOperate: true`，v1 `action()` 也不检查 `interactive`。能打开视图的人即可 `take` 并输入/点击；只有 v2 的 `?interactive=false` 会阻止输入。 | 远程控制 | 低 | 给 v1 增加 `interactive=false` 并落实到 `action()`/`input`；或在 UI 明确 v1 视图始终可操作。 |
| Br-09 | `server/browser-bundle-release.ts:10-11,40-50`；`server/browser/chrome/install.ts:11,22-24,147-152`；`server/browser-engine.ts:618-620`；`server/browser/chrome/resolve.ts:81-123` | Chrome 来源和版本被写死：打包资源固定 `CHROME_VERSION = "153.0.8010.47"`，运行时 `chromeForTestingPin` 也固定 153（`PINS` 只有 `darwin-arm64`）；打包引擎完整且没有本地 Chrome 路径时使用 bundle 里的固定 Chrome。默认只能跑 153，安全更新依赖应用更新，UI 没有版本/路径选择，只能靠 `EAC_CHROME_PATH` 或 `AGENT_BROWSER_EXECUTABLE_PATH` 覆盖。 | 限制 | 低 | 优先使用已安装 Chrome/Chromium 并给出安全警告；允许配置版本或镜像；企业策略命中时提供显式覆盖开关。 |

小结：浏览器组 9 条，高 0 条、中 5 条、低 4 条。

## 四、技能与记忆（01 只覆盖 skill-fetch 的下载地址，02 只覆盖 skillReview 等默认开关）

| 编号 | 文件:行 | 问题 | 性质 | 严重度 | 建议 |
|---|---|---|---|---|---|
| S-01 | `server/skills.ts:549-560`；`server/org-library-releases.ts:160-191` | `installOrgSkill()` 对 `org:` 来源直接 `enabled: true`，注释写明“the Admin is the review”；组织库 reconcile 新增技能时不经过本地 staged 审核，托管端推送即可改已安装 bot 的 prompt 与原生技能链接。 | 远程控制 | 中 | 组织技能默认 `disabled`，由 owner 明确启用；更新保留开关状态并写审计和回滚记录。 |
| S-02 | `server/skills.ts:220-239` | 旧 `skills.json` 迁移时执行 `migrated[name] = { ...visible, enabled: false }`；升级后所有旧技能被关闭，原启用状态不保留，必须逐项重开。 | 限制 | 中 | 只关闭校验失败或来源不明的条目，保留可信旧状态，并在迁移报告中列出被关闭项。 |
| S-03 | `server/memory-store.ts:237-242`；`server/workspace.ts:30-31,585-591` | `MEMORY_FILE_MAX_BYTES=256KB` 允许保存，但 `MEMORY_MAX_LINES=200`、`MEMORY_MAX_BYTES=24_000` 只把前 200 行或 24KB 注入 prompt；超出部分保存成功却永远进不了模型上下文。提示词里虽有一行说明，但写入接口不阻止。 | 限制 | 中 | 统一写入与注入上限；超限自动分流到 `memory/<topic>.md`，或在 API 明确拒绝并提示截断。 |
| S-04 | `server/memory-topics.ts:5-6` | `TOPIC_INDEX_MAX_TOPICS=40`、`TOPIC_INDEX_MAX_CHARS=2_000`；第 41 个主题起只显示 `and N more`，模型默认看不到其标题和描述，难以主动读取。 | 限制 | 中 | 按当前对话相关性动态选取主题，或把两个上限做成配置项。 |
| S-05 | `server/memory-dream.ts:9-13` | `DREAM_MIN_CONVERSATIONS=2`、`DREAM_MAX_CONVERSATIONS=20`、每段 `4_000` 字节且总计 `40_000` 字节；只有一个聊天的用户永远不会 dream，超过 20 个聊天只读最近的，较早内容不参与。 | 限制 | 中 | 降低最小会话数并做成配置；超过上限时按时间分页、分批总结。 |
| S-06 | `server/skill-fetch.ts:213-215` | `MAX_SKILLS_PER_IMPORT=30`、`MAX_FOLDERS_WALKED=24`、`MAX_CHILDREN_PER_FOLDER=60`；`discoverSkillDirs` 达到上限直接停止，调用方没有 truncated 或 skipped 信息，仓库中的技能可能被静默漏导。 | 限制 | 中 | 返回截断计数和跳过列表，或分页导入；至少给出明确告警。 |
| S-07 | `server/skill-fetch.ts:96-128` | URL 导入只解析 `github.com`、`raw.githubusercontent.com`、`skills.sh`；本地文件夹、zip、GitLab、Gitea 等来源无法走同一导入路径，URL 导入被固定到 GitHub 生态。 | 限制 | 中 | 增加本地目录和压缩包导入；对其他 Git 主机使用显式 allowlist，并要求用户确认。 |
| S-08 | `server/skill-share.ts:243-256` | `shareLearnedSkill` 只接受 `source` 以 `learn:` 开头且目录仅有 `SKILL.md` 的技能；导入技能和带 `references/` 的 learned 技能都不能共享，团队库无法分发完整技能。 | 限制 | 中 | 支持整目录共享和同步，或提供明确的“仅 SKILL.md”选项并说明会丢失哪些文件。 |
| S-09 | `server/skills-library-migration.ts:62-65` | 迁移时只要技能目录除 `SKILL.md` 外还有文件，就返回 `skipped`；开启技能库后，带脚本或参考文件的技能仍留在私有目录，无法被团队库统一管理。 | 限制 | 中 | 支持整目录迁移并校验哈希，或在迁移报告和 UI 中突出 skipped 原因。 |
| S-10 | `server/skill-storage.ts:9-11` | `STAGED_SKILL_FILE_MAX_BYTES=32KB`、`MAX_SKILL_REFERENCES=8`；复杂技能在 create/update 时直接报错，无法保存更多参考文件。 | 限制 | 中 | 上限做成配置，或允许引用文件按目录分片而不设固定数量。 |
| S-11 | `server/skills.ts:50-51` | `INDEX_MAX_SKILLS=30`、`INDEX_MAX_BYTES=4_000`；启用的技能超过 30 个或 4KB 后只出现在 omission notice 中，不进入系统 prompt；没有 `skills_list` 的引擎无法发现它们。 | 限制 | 中 | 按相关性动态选择技能，或提供可配置、可分页的技能索引。 |
| S-12 | `server/skills.ts:1039-1040` | 更新 learned 技能时，缺少 `appliedStageId` 的旧技能被拒绝，错误为 `predates reviewed updates — remove and learn it again first`；升级后旧技能无法原地修改，只能删除重建。 | 限制 | 中 | 提供一次性迁移或补发 `appliedStageId`，或允许用当前 sha256 建立新的审核基线。 |
| S-13 | `server/skill-review.ts:435-455` | `applyPending` 对 `deps.apply` 的失败只写日志并继续，不生成审批卡；在不能直接应用（例如 guest 或非 direct 会话）时，自动学习结果被静默丢弃。 | 限制 | 中 | 失败时创建 pending 卡片或通知用户，保留变更供人工确认。 |
| S-14 | `server/memory-upkeep.ts:31,160` | `MAX_PENDING_THREADS=50`，保存时每个线程只保留最后 `CAPTURE_MAX_TURNS=6` 个 `turnId`；崩溃或重启时更早的 turn 以及第 51 个线程的待捕获内容会被静默丢弃。 | 限制 | 低 | 持久化全部待处理项，或记录丢弃数量并在重启后提示。 |
| S-15 | `server/memory-spaces/store.ts:25-26` | 共享记忆文件最多 200 个 space、50,000 条 entry；达到上限时 `persist` 直接抛出 `the memory store is full`，没有归档或轮转。 | 限制 | 低 | 提供归档、分片或可配置上限，并在接近上限时提前提示。 |
| S-16 | `server/skill-fetch.ts:13` | `IMPORT_LIMITS` 为 128 次 API、1,000 次下载、64MB、120 秒；大型仓库导入直接失败，且没有断点续传。 | 限制 | 低 | 做成可配置或分段导入，失败时保留已下载清单。 |

小结：技能与记忆组 16 条，高 0 条、中 13 条、低 3 条。

## 五、例行任务（01~07 均未单独覆盖 routine 的远程暂停、自动生效与附件路径）

| 编号 | 文件:行 | 问题 | 性质 | 严重度 | 建议 |
|---|---|---|---|---|---|
| R-01 | `server/routes/cloud-signed.ts:126-140`；`server/host/routine-holds-host.ts:116-120`；`server/routine-holds.ts:37-44` | `POST /api/cloud/plan` 只验证 Admin 签名就调用 `deps.plan(cancelled)`；`routine-holds-host` 写入 `planCancelled` 并 `review()`，`routine-holds.ts:37` 把所有已启用 routine 置为 `enabled:false`、`nextRunAt:null`，只取消其中 `queued` 的运行。任何拿到 Cloud home `bootstrapSecret` 的请求都能批量暂停或恢复全部例行任务，无需 owner 确认；`running/waiting` 不停止，暂停期间错过的运行不补。 | 远程控制 | 中 | 把 plan 变更做成 owner 可见的双人确认或延迟生效；审计每次 `cancelled` 切换；resume 前提示漏跑范围并提供补偿。 |
| R-02 | `server/routine-requests.ts:1013-1031` | `submit()` 把 `submitted=true` 传入 `prepare`，`automatic=submitted`，随后以 `behavior:"allow"` 调用 `resolve` 直接执行；`grant` 只写入 `appliedBy`，不是放行条件。`create/update/pause/resume/run_now/delete` 全部无确认即时生效，guest 或无人值守 turn 也一样。 | 远程控制 | 中 | 至少对跨 bot、delete、run_now 和降低权限的变更恢复 owner 确认；把 `grant` 变成真正的闸门。 |
| R-03 | `server/routine-attachments.ts:6-12`；`server/routine-execution.ts:92-96` | `attachmentSchema` 只校验 id、kind、name、path 的字符串长度，不限制目录、不检查 `realpath` 或文件是否存在；`routine-execution.ts:92-96` 把 path 原样写进 `attached-file` 标签。maus 运行的 agent 可读取任意本机文件并随结果外发；云运行仅在新输入时拒绝附件（`routine-input.ts:70-71`），旧 `routines.json` 不会重新校验 `runOn` 与 `attachments` 的组合。 | 外发 | 低 | 把附件限制在工作区和允许根目录，校验 `realpath`、存在性与文件类型；云运行拒绝所有本地路径。 |
| R-04 | `server/host/routine-checks.ts:23,261-272`；`server/host/inbox-triage.ts:54-57` | brief 例行任务的 checks 每次读最多 100 封 Gmail，并把 `plan.batch` 交给 `deps.inbox.triage`；triage 把 From、Subject、preview 发给 extractor/decider helper 模型，`check-prompts.ts:27-38` 还会把邮件 preview、会议邀请正文放进 AI prompt。按配置发往 Jev（默认 `api.typesafe.ai`）、Cloud relay 或 OpenRouter，例行任务没有独立外发开关。 | 外发 | 中 | 增加按 routine 的 egress 开关和字段级脱敏；在创建/编辑时明确显示哪些内容会发给哪个 provider。 |
| R-05 | `server/routine-waits.ts:59-61`；`server/routines.ts:1012` | `activeMs` 扣除 `waitedMs` 和当前 `asked` 时间，`timeoutMinutes` 只按 activeMs 判断，等待审批或回答不计入 5-240 分钟运行上限。审批无人回答由 broker 15 分钟超时结束，普通提问没有平台级等待上限；`supersededBy` 只对非 once、非 checks 的 routine 生效，一次性或带 checks 的 waiting run 可长期占住同一 routine。 | 限制 | 中 | 给 waiting 设独立总时限；到期 fail 并释放占位；对 once 和 checks 也执行 supersede；把等待时长展示给 owner。 |
| R-06 | `server/host/routine-holds-host.ts:60-61,94-98`；`server/routine-holds.ts:37-44` | `causes()` 在 `mcpServers()==0` 且 `appsConnected()==false` 时返回 `no_connections`；`review()` 调用 `applyHolds`，把所有 enabled routine 置 off。删除最后一个 MCP 或连接会停掉全部例行任务，即使某些 cron 完全不依赖连接。 | 限制 | 中 | `no_connections` 只暂停声明依赖连接或应用的 routine；其他 routine 改为降级或仅提示。 |
| R-07 | `server/routine-check-pacing.ts:8-12,19-21,31-39` | `CHECK_RUNS_PER_DAY=24`，按 `routineId` 统计最近 24 小时的 `checkKey` AI 运行；连续失败从 15 分钟开始翻倍，封顶 4 小时，再乘 0.8-1.2 抖动。单个 routine 每天最多 24 次 AI 检查，失败退避可到约 4.8 小时；没有 workspace 级总上限，多个 routine 可叠加成本。 | 限制 | 中 | 增加 workspace 级每日 AI 检查预算；UI 显示剩余次数、退避截止和下次检查时间。 |
| R-08 | `server/routines.ts:618`；`server/routine-holds.ts:54-63` | `update` 只要 `patch.enabled` 不是 undefined 就 `delete routine.heldFor`；`shiftHolds` 只在 cause 集合变化时重新暂停。Admin 已 `plan_cancelled` 时，用户手动打开一个 routine 会清掉 hold 标记，此后不再被远程暂停拦住。 | 远程控制 | 中 | 把用户 `enabled` 与系统 hold 分开存；cause 仍存在时手动开启也要保持阻止，或要求 owner 明确覆盖并记录。 |
| R-09 | `server/routines.ts:641-660,672-680` | `remove` 只把该 routine 的 `queued` 运行改 cancelled；`running` 和 `waiting` 不处理。删除例行任务后当前 run 仍继续执行并可能继续发消息；`removeForBot` 才会调用 `interruptTurn` 或 `interruptGoal`，两条删除路径语义不一致。 | 远程控制 | 中 | 删除时同时中断 running/waiting，或把 delete 与 stop 分成两个明确动作并在 UI 说明。 |
| R-10 | `server/routines.ts:521-552`；`server/routine-requests.ts:1184-1187` | `create` 只做 `sanitizeInput`、目标存在检查和 `nextRunAt` 计算，没有 routine 数量、plan 或 credits 闸门；`requireCloudReadiness` 只对 `runOn=cloud` 探测。没有显式上限，成本要等 dispatch 时才以 `spend_cap` 失败暴露。 | 限制 | 中 | 在创建/更新时做 routine 数量、plan 和 credits 预检；超限直接拒绝并给出当前用量。 |
| R-11 | `server/routine-recovery.ts:88-92,109-115` | `dispatchRefusal` 把 `spend_cap` 标为 `cause=cap`，`classifyRoutineFailure` 对 cap 返回 final，`recoverRun` 直接 failed，不重试也不排到 cap 重置后。命中 workspace 花费上限的计划运行会丢失，只留下失败记录或通知。 | 限制 | 中 | `spend_cap` 改为排队到 cap 重置，或明确标记 missed 并提供一键补跑；不要当普通 final 失败。 |
| R-12 | `server/routine-requests.ts:1184-1200`；`server/index.ts:9017-9038` | `runOn=cloud` 的 create、update、resume、run_now 都先 `await cloudReady`；`cloudRoutineReadiness` 要求 `boatConfigured`、模型 snapshot 为 available、`findBoat` 成功，任一失败就 503 或拒绝。Boat 未配置或网络抖动时无法保存云 routine，也不能先存草稿。 | 限制 | 中 | 区分未配置与暂时不可达；探测失败时允许保存为 paused draft，恢复网络后再启用。 |
| R-13 | `server/routine-recovery.ts:179-187` | busy 的 run 每 30 秒重新排队；只有 `checkKey===undefined` 的运行在 60 分钟后失败，带 `checkKey` 的检查运行会一直等。bot 长期忙碌时，检查项会被 pending 锁住，后续检查也拿不到这些邮件或会议。 | 限制 | 中 | 给 `checkKey` 的 busy 等待设上限或降级为 missed；把 pending 项释放给下一次检查。 |
| R-14 | `server/routine-input.ts:60-82` | `runOn` 只接受 maus 或 cloud；room-goal 强制 maus，并禁止附件、continuity、modelSelection；cloud 加附件直接抛 `Attachments can only run on this computer...`。房间目标不能放云电脑，云任务不能带本地附件。 | 限制 | 低 | 在 UI 中提前说明这些组合限制，并给出替代方案。 |
| R-15 | `server/routine-input.ts:100`；`server/routine-attachments.ts:55-56` | `durationMinutes` 用 `Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) \|\| 30)))` 静默夹取：0 或 NaN 变 30，1 变 5，300 变 240；`timeoutMinutes` 却严格抛 5-240。两条输入路径行为不一致，用户设置会被悄悄改写。 | 限制 | 低 | `durationMinutes` 也严格校验并报错，或统一 clamp 并在响应中回显实际保存值。 |

小结：例行任务组 15 条，高 0 条、中 12 条、低 3 条（R-03、R-14、R-15）。

## 六、审查过但判定“不该算问题”的模块

这些模块逐段看过，确实有门或网络代码，但属于合理的安全边界、用户自选策略，或已被 01~07 收录，因此不进上表：

| 模块 | 结论 | 理由与证据 |
|---|---|---|
| `server/safety-floor.ts`、`safety-floor-gate.ts` | 保留 | 只拦递归删根/家目录/系统目录、格式化磁盘、覆盖磁盘设备、fork bomb；默认关闭，`EAC_SAFETY_FLOOR=1` 或配置才开（`safety-floor-gate.ts:14-16`）。这是防灾难的安全底线，不是商业限制。 |
| `server/bot-api-fence.ts` | 保留但需产品决策 | Bot API turn 只挂 `hooks` 工具、只允许三条内部路由（`:12-26`），并把引擎限制在 Ask。它是防“陌生人用 API key 注入后拿到工具”的安全边界；如果产品要求 API turn 也能用电脑/浏览器，需要重新设计，而不是直接删。 |
| `server/peer-roster.ts` | 保留 | `peers` 是用户可配置的名单，默认不设就是全开放（`:17-18,95-104`）；只有发送方名单和 audience 会收窄。不是隐藏限制。 |
| `server/host/room-access.ts` | 保留 | 只做房间成员、私聊不外写、房间 setup 未完成等成员资格判断（`:12-56`）；正常多用户安全边界。 |
| `server/thread-retention.ts` | 已被 07 覆盖 | 只有配置 `threads.eventLogRetentionDays` 才删空闲 thread 的 events/native 日志，不删 SQLite 记录；07 的 thread-retention 条已收录。 |
| `server/tool-count-limit.ts`、`tool-schema-profile.ts`、`tool-budgets.ts` | 已被 02/07 覆盖 | 128 工具、按 provider 拒绝学习上限、schema 64KB、每 bot 预算 1000 条，都是 provider 协议上限或内存保护；02 的 G-36、07 的 tool-budget 条已收录。 |
| `server/host/starter-bot-limit.ts`、`bot-thread-limits.ts`、`bot-api-host.ts` 的 Starter 分支 | 已被 02 覆盖 | 5 bot、1 线程、Bot API 不可用，02 的 G-18/G-19/G-20 已收录且标为商业许可边界。 |
| `server/bot-directory.ts` | 已被 01 覆盖 | 固定 `api.botdirectory.ai` 的 GET 目录，01 第 36 条已收录；不发项目内容。 |
| `server/request-auth.ts` 的普通鉴权 | 已被 02/06 覆盖 | 绑定地址、配对、session、scope、SERVICE_ALLOW 的常规行为由 02/06 收录；本表只补 06 没写的 socket 对端与测试 key 两点。 |
| `server/webhooks.ts` 的常规限流 | 已被 02/07 覆盖 | 10 次/分钟、3 个待办、256KB、48k 字符等由 02 的 G-53/G-54 收录。 |

## 七、覆盖范围与统计

已逐个打开的非测试 `.ts` 范围：

- `server/webhook-*.ts`、`server/routes/webhooks.ts`、`server/host/webhook-room-*.ts`
- `server/mcp-*.ts`、`server/host/mcp-*.ts`、`server/routes/mcp-servers.ts`
- `server/browser-*.ts`、`server/browser/**/*.ts`、`server/routes/browser-*.ts`、`server/host/browser*.ts`
- `server/skill*.ts`、`server/skills*.ts`、`server/host/skill*.ts`、`server/routes/bot-skills.ts`、`server/routes/skill-share.ts`
- `server/memory-*.ts`、`server/memory-spaces/**/*.ts`、`server/routes/bot-memory.ts`
- `server/routine*.ts`、`server/host/routine-*.ts`、`server/routes/cloud-signed.ts` 的 plan 分支
- `server/room-*.ts`、`server/peer-*.ts`、`server/bot-*.ts`、`server/thread-*.ts`、`server/tool-*.ts`、`server/safety-floor*.ts`
- `server/outbound-*.ts`、`server/guarded-requests.ts`、`server/request-auth.ts`、`server/data-dir-lease.ts`、`electron/data-dir-lease.mjs`

| 模块组 | 条数 | 高 | 中 | 低 |
|---|---:|---:|---:|---:|
| MCP | 16 | 1 | 11 | 4 |
| 网络入口与出站 | 18 | 2 | 12 | 4 |
| 浏览器 | 9 | 0 | 5 | 4 |
| 技能与记忆 | 16 | 0 | 13 | 3 |
| 例行任务 | 15 | 0 | 12 | 3 |
| **合计** | **74** | **3** | **53** | **18** |

独立复核：初判有 10 条“高”，二次回源码核对后，M-02（工具会静默消失但用户会收到一次通知，且可立即重查）、M-03（桌面端添加后会测试再 PATCH 开启，主要影响直接调 API 的第三方）、Br-01（是 schema 注释写明的产品默认，metadata/link-local 仍拦）、S-01（组织库与 soul/playbooks 属同一管理员信任域）、R-01（是 `plan_cancelled` 的既定设计，带签名与 nonce）、R-02（guest/outside 对 update/pause/resume/run_now/delete 另有 403 闸门）、R-03（只是 prompt 里的路径标签，agent 本就有本机文件权限）均降为中/低。最终保留的 3 条高严重度是：

- **M-01**：远程 MCP 允许 `http://`，Bearer/API key 明文过网。
- **N-02**：SSH `-L`/socat 等 TCP 转发可被当成本机 owner，绕过配对。
- **N-03**：webhook 增删改即时生效，事件驱动 turn 可注入改写下一次投递的 prompt。

去重说明：原稿还有两条高/中条目（`SERVICE_ALLOW` 跨 bot 路由、hosted 上 `EAC_LOOPBACK_TRUST=owner` 只警告）已被 `06-account.md` 收录，因此从本表移出；`bot-directory`、Starter 计划、MCP 结果预算、通用配额也已分别由 01/02/07 收录，未重复计数。

行号口径：本文按 2026-11-14 扫描期间的当前工作树记录；期间 `request-auth.ts`、`bot-thread-limits.ts`、`image-daily-cap.ts` 等仍在被并行修改，落地前请按符号名复核。



