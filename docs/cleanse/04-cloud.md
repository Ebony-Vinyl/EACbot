# 04 云依赖审计：Cloud、Boat、VPS、共享电脑与外连边界

采集日期：2026-11-14  
仓库：`D:\workspace\EACbot-clean-core`  
分支：`codex/clean-core`  
审计基线：`781c57e9a6fbf0f504704d358f4c82a1860490c2`（审计期间主线程提交了 `b5ca7fd`，当前 HEAD 已前进；本文行号按各节说明）  
审计范围：`server/` 下与 `cloud-*`、`boat*`、`hosted-*`、`tunnel.ts`、`tailscale.ts`、`fleet*`、`control-*`、`local-vm-*`、`vps-*`、`container-*`、`lent-*`、`shared-computer*`、`computer-*`、`places-elsewhere.ts`、`managed-*` 匹配的生产文件；`routes/`、`host/`、`testing/` 只审生产代码，测试文件仅用于理解行为。  
方法：只读静态审计。用 `rg -n` 定位导入、构造、路由挂载、定时器和外连，再用 `Get-Content` 逐段核对真实行号；没有编译、没有启动服务、没有联网。  
前提：审计开始时 `00-baseline.md` 仍写 BLOCKED（缺 `node_modules`）；`08-evidence-audit.md` 抽查发现依赖已由其它小组在 12:07 后安装（`node_modules` 目录创建于 12:07:37，`tsc.cmd`/`vitest.cmd` 创建于 12:07:47），但本报告仍未编译、未启动，所有结论仍是静态审计（`docs/cleanse/08-evidence-audit.md:13`）。主线程随后提交了 `b5ca7fd`（默认关闭三项外连），工作树另有 `limits`、`request-auth` 等未提交修改；本文只读，未改源码、配置、依赖或 git 状态。

## 一、直接回答

### 1. 哪些云功能在 `server/index.ts` 启动模块图里被静态 import、构造、定时启动

`server/index.ts` 的静态导入区从第 1 行开始，整张 ESM 图在进程主体执行前求值；因此“被 import”不等于“会联网”，但任何被 import 的文件缺失都会让进程在创建目录之前退出（`server/index.ts:1-645`）。本范围内实际进入服务进程的模块分四层。

第一层是启动即求值的配置与协议层。`cloud-secrets-boot.ts` 是第一条 import，导入时立即执行 `takeCloudSecrets()`（`server/index.ts:2`；`server/cloud-secrets-boot.ts:1-5`）。`cloud-home.ts` 的 `cloudHomeConfiguration(CLOUD_ENV)` 在模块主体同步执行（`server/index.ts:695-698`）。`hosted-model-policy` 在 `loadConfig()` 之后、ProviderRegistry 创建之前同步执行（`server/index.ts:782-785`）。这三个点都不 `await`，失败会直接抛错，属于启动硬失败；没有对应环境变量时分别返回 `{}`、`null`、`null`。

第二层是启动即构造、但默认不联网的对象。`SharedComputers`、`LentComputers`、`DeviceLinks` 在 `server/index.ts:693` 构造；`placesElsewhere` 在 `:868` 构造；`ManagedDesktopPolicy` 在 `:1515`、`ManagedDesktopProviders` 在 `:1530` 构造；`cloudPlanTier` 在 `:2863`、`cloudHealth/cloudSigned` 在 `:2864`、`cloudComputerPower` 在 `:5681` 构造；`cloudMoveRoutes` 在 `:12154`、共享电脑路由在 `:12160`、`cloudSendRoutes` 在 `:12270`、公告与更新路由在 `:12493`。这些构造本身通常只建内存对象、读一个小文件或注册路由，不主动访问厂商服务。例外是 `createCloudSignedHost` 只在 `CLOUD_HOME` 非空时创建健康账本（`server/host/cloud-signed-host.ts:31-38`），以及 `cloudComputerPower` 的构造只建映射和闭包（`server/host/cloud-computer-power.ts:43-50`）。

第三层是异步、非 await 的启动动作。`cloudCredit.start()` 在 `server/index.ts:1546-1557` 启动，外层 `.catch` 把失败降级为日志；只有空数据目录首次播种时，`:2873` 会用 15 秒 `Promise.race` 等它。主端口监听回调里，`:15509` 启动 Team 规则拉取和 Cloud Connected Apps 注册，二者都不 `await`；`:15514` 以 `void` 调用 `cloudComputerPower.armRunning()`。这些动作失败不会退出进程，只会记录并重试或保持空结果。

第四层是真正的定时器。`cloudPower` 在 `CLOUD_HOME` 下每 5 秒 tick（`server/cloud-power.ts:154-161`）；`workspaceAccess` 每 10 秒 revalidate（`server/index.ts:15452-15457`；`enterprise/server/workspace-access.ts:158-163`）；Team 规则每 5 分钟加抖动拉取（`server/cloud-team-policy.ts:26,224-229`）；Connected Apps 按 30 秒到 30 分钟退避（`server/cloud-connected-apps.ts:20,104-110`）；试用额度按 15 秒到 10 分钟退避（`server/cloud-credit-provider.ts:21-22,122-134`）；公告源在设置了 URL 时启动约 1 秒后拉取，之后每 10 分钟（`server/index.ts:12493`；`server/announcement-feed.ts:10-11,116-125`）。`cloudComputerPower` 只有在 Boat 已配置时才在启动后列出云电脑并给它们计时（`server/host/cloud-computer-power.ts:163-177`）。

不进入 `server/index.ts` 的服务入口有四个：`server/tunnel.ts` 和 `server/tailscale.ts` 只被 CLI 使用（`server/cli.ts:34-62`）；`server/fleet.ts`、`fleet-agent.ts`、`fleet-cli.ts` 只被 CLI 使用（`server/cli.ts:34-36`）；`server/cloud-home-start.ts` 是 Cloud 镜像的独立 supervisor，不属于 `node server/index.ts`。因此“有文件”不等于“服务启动时会跑”。

失败语义要分开看。静态 import 缺失、`cloud-secrets` 的 FD 非法、Cloud 变量只配一半、`hostedModelPolicy` 只配一半，都会让进程在监听前退出（`server/index.ts:1-645,697,785`；`server/cloud-secrets.ts:24-42`；`server/cloud-home.ts:69-87`；`server/hosted-models.ts:24-35`）。`loadEnterpriseLayer()` 虽然 `await` 且在主端口前执行，但内部捕获所有错误并降级为 OSS（`server/index.ts:15437`；`server/enterprise.ts:119-151`）。端口监听后的 Cloud 服务失败、Boat 失败、VPS 失败、Team 规则拉取失败，通常只影响该功能，不会让已经监听的服务退出。

### 2. 完全没有 `EAC_CLOUD_*` / `EAC_CONTROL_*` 时，逐模块会发生什么

`server/cloud-home.ts`：`cloudHomeConfigured({}) === false`，`cloudHomeConfiguration({}) === null`，不抛错（`server/cloud-home.ts:49-51,69-71`）。因此 `server/index.ts:697` 得到 `CLOUD_HOME = null`，`:698` 的 `CLOUD_TEAM`、`CLOUD_PERSONAL` 都为空，`:15501` 不创建 Cloud power，`:2864` 的 signed host 返回 `{cloudHealth:null,cloudSigned:null}`。没有任何 Cloud API 被注册成可用。

`server/cloud-secrets.ts`：没有 `EAC_CLOUD_SECRETS_FD` 时 `takeCloudSecrets()` 直接返回 `{}`，不读文件、不抛错（`server/cloud-secrets.ts:24-27`）。`server/index.ts:695-696` 合并空对象；`:730` 删除一组本来就不存在的变量，也不会失败。只有在 FD 被设置但非法、不可读或内容不是 JSON 对象时才抛 `Cloud home configuration is invalid`（`server/cloud-secrets.ts:29-42`）。

`server/control-client.ts`：`url = options.url ?? process.env.EAC_CONTROL_URL ?? ""`，`token = ... ?? ""`，`configured = Boolean(url && token)`（`server/control-client.ts:60-65`）。两者都空时 `configured === false`，`state()` 在发请求前返回 `DISENGAGED = { held:false, helpOpen:false }`（`:46,96-103`）。它不会尝试联网，也不会抛错。只设置其中一个同样视为未配置，因为要求布尔与；这会让“谁在操作电脑”的拦截静默失效，而不是启动失败。

`server/fleet-client.ts`：没有 `EAC_FLEET_SOCKET` 时默认 `/run/eacbot/fleet.sock`（`server/fleet-client.ts:10-12`）。`fleetAvailable` 只是 `existsSync`（`:14-16`）；文件不存在返回 `false`，不抛错。`fleetRequest` 只有在实际调用时才连接 Unix socket，失败时抛出“no fleet agent…”（`:18-44`）。因此没有变量、没有 socket 时，服务启动不受影响，`/api/fleet` 路由会返回 404。

`server/hosted-contract.ts`：只有版本常量、header 名和 `hostedContractCompatible` 纯函数，没有环境变量读取、没有网络、没有文件 I/O（`server/hosted-contract.ts:1-15`）。没有 `EAC_CLOUD_*` 时它仍被 import，但只在 hosted readiness 中把 header 设为 `1`（`server/index.ts:12665-12667`），不会产生任何请求。

相邻模块也要一起看。`cloud-sync` 的路由在非 Cloud 时直接 `PASS`，后续没有同路径处理器就表现为 404；它不会读同步目录，因为 `createCloudSync` 是首次请求才构造（`server/routes/cloud-sync.ts:30-40`）。`cloud-send` 路由仍被挂载，但 `cloudSendOwner` 在非 Cloud、非 ownHome 时返回 `null`，读写会被 403 拒绝（`server/index.ts:12270`；`server/routes/cloud-send.ts:80-91` 的 owner 与 refusal 逻辑）。`cloudPower` 只在 `CLOUD_HOME` 下创建，否则 `cloudPowerNow()` 是 `null`（`server/cloud-power.ts:230-235`）。`cloudConnectedApps` 在 `cloudHome:false` 时直接返回，不注册 broker（`server/cloud-connected-apps.ts:196-205`）。`cloudCredit` 在没有 `CLOUD_HOME` 时是 `null`（`server/index.ts:1546`）。`boat` 没有 token 时 `boatConfigured(cfg) === false`，状态查询直接返回 `{configured:false}`，启动后的 `armRunning` 也先检查这个布尔再决定是否列云电脑（`server/boat.ts:890-901,1062-1069`；`server/host/cloud-computer-power.ts:163-166`）。`vps` 没有 `cfg.vps.sshAlias` 时 `vpsSshAlias` 返回 `null`，不会启动 SSH 或 Docker（`server/config.ts:622-624`；`server/vps-hosts.ts:5-12`）。`shared-computers` 的配置开关默认 false，路由虽挂但功能 404（`server/config.ts:704-705`；`server/routes/shared-computers.ts:52-56`）。

### 3. 哪些是硬依赖，哪些只是可选功能

严格意义上的启动硬依赖只有三类。第一，所有静态 import 的文件必须存在，否则 ESM 图求值失败；这包括本文范围内被 `server/index.ts` 直接或间接 import 的 Cloud、Boat、VPS、共享电脑和本地 VM 文件（`server/index.ts:1-645`）。第二，Cloud home 的四元组一旦只配一半、值非法，或 `EAC_DESKTOP_PARENT=1` 与 Cloud 同时出现，就会在 `:697` 抛错退出（`server/cloud-home.ts:69-87`）。第三，`EAC_HOSTED_MODELS` 或 `EAC_HOSTED_MODEL_TOKEN` 一旦设置但不满足 hosted workspace、token 形状和 JSON 目录要求，`:785` 会抛错退出（`server/hosted-models.ts:24-35`）。

条件性硬依赖有两个。hosted workspace 模式要求 enterprise 层提供 `workspaceAccess`；没有层时 `createWorkspaceAccess` 返回 `null`，服务仍能监听，但 hosted 登录、hosted readiness 和浏览器鉴权返回 503（`server/enterprise.ts:107-110`；`server/index.ts:15452,12659-12678`）。Fleet 的 Web 路由要求 `entitled("admin")`，否则 403；fleet agent 本身是独立 root 进程，不由主服务启动（`server/routes/status.ts:82-86`；`server/fleet-agent.ts:205-221`）。

除此之外，Cloud、Boat、VPS、共享电脑、Local VM、Places、tunnel、tailscale 都是可选功能。缺 Boat key 只会让云电脑不可用；缺 VPS alias 只会让 VPS 电脑不可用；缺共享电脑开关只会让 lending 404；缺本地容器只会让 Local VM 不可用；缺 tunnel/tailscale 只影响 CLI 的远程访问命令。最小本地运行不需要任何云服务账号，也不需要这些网络路径。

最小本地运行保留清单（指“不编辑源码、只运行”这一层）：保留 `cloud-secrets-boot.ts`、`cloud-secrets.ts`、`cloud-home.ts`、`hosted-contract.ts`、`fleet-client.ts`，因为 `server/index.ts` 直接 import 它们；保留 `shared-computers.ts`、`shared-computer-control.ts`、`lent-computers.ts`、`lent-copies.ts`、`lent-clone.ts`、`lent-mcp.ts` 只要还要本机共享电脑；保留 `computer-control.ts`、`container-computer.ts`、`local-vm-*`、`computer-*` 只要还要本地桌面/VM；保留 `vps-*` 只要还要自带 VPS；保留 `places-elsewhere.ts` 和路由，因为它是纯本地元数据。Cloud home、Cloud Send、Cloud Sync、Cloud Connected Apps、Cloud Credit、Cloud Health、Cloud Power、Cloud Team、Cloud Plan、Boat、hosted 模型、Fleet、tunnel、tailscale 都可以在不使用相应产品时删除，但删除时必须同步改 `server/index.ts` 的 import 和构造点，否则会先触发模块缺失。

### 4. 能否降级为纯本地，按模块给建议

可以，但要区分“运行时不配置”和“源码里删掉”。不配置就能纯本地运行：`EAC_CLOUD_*` 全空、`EAC_CONTROL_*` 全空、没有 Boat token、没有 `cfg.vps.sshAlias`、`features.sharedComputers` 保持 false。此时没有 Cloud home、没有 signed 路由、没有 Cloud power 定时器、没有 Connected Apps 注册、没有试用额度轮询；Boat 和 VPS 只在用户显式操作时才会碰网络。

若要做源码级降级，建议按以下耦合点处理，不改代码只给建议：

`cloud-home.ts`、`cloud-secrets*`、`hosted-contract.ts`：保留最小空实现或删除后改 `server/index.ts:2,280` 的 import；`cloudHomeConfiguration` 必须仍能被调用并返回 `null`，否则启动会断。

`cloud-signed-host.ts`、`routes/cloud-signed.ts`、`cloud-health.ts`、`cloud-power.ts`、`cloud-plan-tier.ts`、`cloud-team-policy.ts`：Cloud-only，可整组删除；同时改 `server/index.ts:282-283,2863-2864,15501` 和 `server/routes` 的挂载。删除后 Cloud Admin 的签名请求不再可用，这是产品边界，不是功能降级 bug。

`cloud-sync.ts`、`routes/cloud-sync.ts`、`cloud-sync-store.ts`、`cloud-sync-paths.ts`、`lent-copies.ts`、`lent-clone.ts`：Cloud Files 专用；删除要同时处理 `server/index.ts:284` 的 `lentCopies` 和 `:12160` 的共享电脑依赖。保留本地共享电脑但不要 Cloud Files 时，需把 `lentCopies` 换成纯本地实现或空对象。

`cloud-send*`、`cloud-connections*`、`cloud-chat-merge.ts`：Move to Cloud 专用；删除要处理 `server/index.ts:595,12270` 和 `server/routes/cloud-signed.ts` 的 verify 路由。它们是用户显式操作，不会后台自行发送。

`cloud-connected-apps.ts`、`cloud-credit-provider.ts`、`hosted-models.ts`、`managed-desktop.ts`：分别对应 Cloud 计划、试用额度和企业公司模型；都带商业许可边界，不能通过改 key 或伪造 entitlement 绕过。合法 OSS 降级是删掉 `enterprise/` 并让 `entitled()` 恒假；如果还要托管功能，应保留这些模块和许可校验。

`boat*.ts`、`cloud-computer-*.ts`：Boat 云电脑专用；删除要处理 `server/index.ts:99,117-120,136-139,15514,15224-15411` 和 `server/host/cloud-computer-power.ts`。若保留云电脑但只想支持自建 VPS，可把 Boat 路径默认关闭，保留 VPS 路径。

`vps-*.ts`、`container-*.ts`、`local-vm-*.ts`：不是厂商云依赖。VPS 走用户自己的 SSH，容器走本机 Docker/Podman；若目标是“纯本地”，建议保留，并把 VPS 默认关闭、Local VM 默认仍为 shared、限制端口和密码。

`shared-computer*`、`lent-*`、`places-elsewhere.ts`、`computer-*.ts`：纯本地或点对点能力。建议保留；它们没有厂商端点，只有用户自己的电脑和本机进程。

`tunnel.ts`、`tailscale.ts`、`fleet*.ts`：独立 CLI 或独立 root agent；不进入 `server/index.ts`。若不做远程访问或共享服务器，可从发布物删除，但 `server/cli.ts:34-62` 也要改。

### 5. 有没有上传用户数据的路径

有，但绝大多数是显式操作或只在 Cloud/企业模式。按“会发用户内容”和“只发元数据”分开：

会发用户聊天内容或文件内容的路径有六类。第一，模型回合本身：所选 provider 的 base URL 会收到对话正文、附件和工具结果，`server/drivers/openai-chat.ts:297,490-517` 是 HTTP 回合的发送点；这不是云模块新增的，但 Cloud 托管模型和试用额度会改变目的地。第二，托管公司模型：`hosted-models.ts:80-93` 把 Claude/Codex/OpenRouter 的 base URL 指到 `EAC_ADMIN_URL/api/gateway/<workspace>`，回合内容会经过 Admin 网关。第三，试用额度：`cloud-credit-provider.ts:43-49` 把 OpenAI 兼容实例指到 `EAC_CLOUD_AI_URL`，用户选择该模型后对话会发到该 relay。第四，Move to Cloud：`cloud-send-chats.ts:379-383` 返回聊天行，`cloud-send-files.ts:1-5` 和 `cloud-send-memory.ts:1-4` 处理文件、记忆、自动化和附件；由已认证的桌面发起，服务器本身不主动推送。第五，Cloud Files：`cloud-sync.ts:1-4,113-122` 接收桌面上传，包含 `pcPath`、`computerName`、相对路径、内容和 sha256；由桌面驱动每一轮，不是服务端定时上传。第六，Boat 云电脑：`cloud-computer-files.ts:75-100,120-130,197-206` 在用户/机器人复制文件时把内容发到 Boat sandbox；`cloud-computer-tools.ts:27-42` 的 `exec`、`copy_*` 也会把命令、文本和文件送到沙箱。

会发凭据或凭据派生物的路径有三类。第一，Move to Cloud 的 `cloud-send-verify.ts:17-27` 会把已保存登录做 HMAC 指纹；它明确注明“持有 owner session 的人可以离线猜弱密码”（`cloud-send-verify.ts:5`）。第二，`cloud-connections-host.ts:88-99` 的 `handoff` 会把 MCP OAuth、Composio、邮箱等连接交给目标 Cloud；这是用户主动搬迁。第三，Boat 的 API token 和包含 token 的 relay 只发往 `boatAccount(cfg).api`，不会发到任意地址（`server/boat.ts:139-149`；`server/included-services.ts:31-43,79-81`）。

只发元数据、不发聊天正文的路径有四类。第一，`GET /api/cloud/health` 的签名健康报告只含固定代码、计数、时间、版本、引擎种类、随机 id、连接器 slug 和布尔值，明确不包含失败原文、bot 名、thread 标题、prompt、URL 或 token（`server/cloud-health.ts:1-3,294-314`）。第二，`/api/cloud/power` 只含状态码和时间（`server/cloud-power.ts:16-28,205-208`）。第三，Team 规则拉取只发 fingerprint、version、problem、machine id、时间戳、nonce 和 HMAC（`server/cloud-team-policy.ts:176-184`）。第四，Connected Apps 首次注册发 `{}`，之后 grant 只作为 `{grant}` 发送（`electron/managed-composio.mjs:76-91`；`server/cloud-connected-apps.ts:114-130`）。

还有一条容易被忽略的元数据拉取：Team admin 摘要会被 Admin 的签名请求读取，包含连接器 slug、账号 id/别名/状态、MCP 名称和 host、密钥是否配置、引擎账号的 email/organization/method；它不发 key 或 token 值，但会暴露人员邮箱和账号身份（`server/cloud-team-admin.ts:1-3,14,20,41-67`）。

默认不联网的检查项：`server/update-check.ts:11-20,108-120` 只有显式 `EAC_UPDATE_CHECK_URL` 才请求；`server/announcement-feed.ts:27,116-125` 只有显式 `EAC_ANNOUNCEMENTS_URL` 才定时拉取；两者都不携带用户数据。`server/index.ts:15526-15535` 的 `EAC_TUNNEL_SOCKET` 只是本机 Unix socket，不是 cloudflared 出站；真正的 cloudflared 在 `server/cloud-home-start.ts:396-457` 或 `server/tunnel.ts:255-290`。

模型目录需要单独说明：`server/model-catalog/catalog.ts:43,47,160-166,221-224` 定义了 `https://models.dev/api.json` 抓取、24 小时缓存和 `EAC_DISABLE_MODEL_CATALOG_FETCH=1` 关闭开关；但我在当前 `server/` 中没有找到对 `model-catalog/catalog.ts` 的 import，也没有在 `server/index.ts` 的启动链找到调用。因此这是一条“代码存在、当前未接入”的候选外连，不能写成启动时一定发生；这是推断，证据缺口见末节。

### 6. 云电脑、共享电脑、VPS、容器的权限边界

Cloud home 是最严格的单人多设备模型。只有 owner 的 admin session 能登录；启动时 `sessions.requireAdmin` 被设置（`server/index.ts:702`），lending 的 principal 只有 `CLOUD_PERSONAL && cloudOwnerSession(auth)` 才返回 `cloud-home`（`:936-938`），guest 只能写自己开的会话（`:950-955`）。Cloud home 的 lending 不是默认对所有人开放；它是 owner 的电脑借给 owner 的 Cloud。

Team Cloud 是多人模型，但 lending 被明确关闭：`sessionLendingPrincipal` 在 `CLOUD_HOME` 下要求 `CLOUD_PERSONAL`，Team 为 false（`server/index.ts:936-938`），`:2853` 的注释也写明“a team Cloud lends nothing”。Team 成员只有 client scope，owner/admin 才有 admin scope，且 Team session 最多 1 小时（`server/cloud-team.ts:27-37`）。Team 电脑是 section 级共享资源，只有 Auto 目的地的 bot 会继承；显式 `computer` 目的地不会继承（`server/team-computers.ts:56-58`）。

共享电脑（lending）的权限在桌面端，不在服务端。注册时必须带 session 和 `x-omb-computer-secret`；Cloud home 还要求 admin scope（`server/routes/shared-computers.ts:52-66`）。服务端只按注册的 `folders`、`terminal`、`computer`、`internet`、`chrome` 范围排队，真正的授权由桌面端再次检查（`server/shared-computers.ts:95-129`）。默认 `features.sharedComputers` 为 false（`server/config.ts:704-705`），Cloud home 才会把它打开。

“谁在操作电脑”由 `ComputerControl` 管：只有人 take/release，bot 只能 `requestHelp`，人持有期间 bot 的动作被拒绝而不是排队（`server/computer-control.ts:1-3,64-70,109-117`）。控制租约有过期时间，避免 Electron 崩溃后永久占屏（`server/shared-computer-control.ts:3-4,17-61`）。本地 `/api/desktop/shared-computer-control` 只接受 loopback，且只做互斥，不授予任何新权限（`server/index.ts:12926-12939`）。

Boat 云电脑的权限是“Boat 账号 + 安装前缀”。`boatAccount` 返回 own token 或 included relay；`boatConfigured` 只看是否有 token（`server/boat.ts:886-901`）。列出和删除只处理本安装命名形状的 sandbox，别家账号的行不会被采纳为删除目标（`server/boat.ts:477-484`）。但拥有 Boat token 的人可以在 boat.dev 账号层看到/删除该账号的机器；服务端的名字前缀只是防误删，不是云端 ACL。云电脑里的 `exec` 是完整 shell，命令最长 4000 字符（`server/cloud-computer-tools.ts:27-30`；`server/boat.ts:41`），权限取决于 sandbox 内部用户，不是宿主。

VPS 的边界是“SSH alias 能到哪，Docker 就能控哪”。`vpsDockerArgs` 把 `-H ssh://<alias>` 交给 Docker（`server/vps-computer.ts:182-186`），SSH 配置包含用户自己的 `~/.ssh/config` 并优先于系统配置（`server/vps-ssh.ts:47-62`）。容器本身做了 `--cap-drop ALL`、只加 SETUID/SETGID、4GB 内存、2 CPU、4096 pids、bridge 网络、无宿主挂载（`server/vps-computer.ts:831-878`），但 SSH alias 指向的账号如果是 root 或 Docker 组，容器外的宿主仍由该账号的 Docker daemon 控制。默认没有 alias 就不启用；`vpsStartsForTurn` 只在显式 cloud、`autoStartVps=true` 或自动化来源时为 true（`server/vps-computer.ts:112-115`）。

Local VM 的边界是本机容器运行时。默认 shared 模式、最多 2 个、空闲 480 分钟（`server/local-vm-settings.ts:4-10`）。容器默认发布 `127.0.0.1:6080` 到 noVNC；自动创建路径使用 `randomBytes(6).toString("base64url")` 生成随机 VNC 密码（`server/container-computer.ts:973-975`）。固定 `CHANGE_ME` 只出现在 `setupCommands()` 手动安装展示命令里（`:1177-1219`），函数签名的默认参数也是 `CHANGE_ME`（`:825-827`），但当前两条实际调用点分别是自动随机和展示命令固定值。风险因此不是“自动启动的默认密码可预测”，而是用户复制展示命令创建容器，或人工创建了旧容器；它只绑回环，但同机任何本地进程仍能访问固定端口。这是手动路径的本地风险，不是厂商云风险。

Fleet 是最高权限的独立面：root agent 在 Unix socket 上监听，socket 权限 0660，chown 给 operator 组（`server/fleet-agent.ts:205-219`），能创建 OS 用户、systemd 服务和租户数据目录；Web 侧 `/api/fleet` 要求企业 `admin` entitlement（`server/routes/status.ts:82-86`）。它不由 `server/index.ts` 启动，只有执行 `eacbot fleet init/agent` 才出现。

## 二、与共享资料的差异

**与 02 的 G-24 不一致（范围缺失，重要）。** 02 写“无策略即全开”，这在 `ManagedDesktopPolicy` 本身成立（`server/managed-policy.ts:134-139`），但 Cloud home 在策略之前还有一道固定拒绝：`computerPlaceRefusal` 先调用 `cloudHomePlaceRefusal`，Cloud home 会把 `thisComputer` 映射为 `local`、`localVm` 映射为 `vm` 并直接拒绝（`server/index.ts:1520-1524`；`server/cloud-home.ts:116-119`）。因此“没有企业策略”并不等于 Cloud home 上所有电脑都开放；Cloud desktop 和 VPS 仍可用，本机桌面和本地 VM 被产品设计拒绝。02 的 G-24 应补上“仅对 managed policy 而言，Cloud home 另有 place 限制”。

**与 02 的 G-21 表述不一致（轻微）。** G-21 说“计划层级来自 Admin 的签名文件”；实际 `cloud-plan-tier.json` 是 Admin 的签名 `POST /api/cloud/plan` 写入的本地缓存，不是签名文件本身（`server/host/cloud-plan-tier.ts:1-3,20-43`；`server/routes/cloud-signed.ts:126-140`）。结论“无文件即非 Starter”不变。

**与 01 第 11 条不一致（不完整）。** 01 写 Connected Apps 只 `PUT /v1/installation/cloud`，body 只有 `grant`；这只描述已有 installation token 的情况。首次没有 token 时，`ensureManagedComposioCredentials` 会先 `POST /v1/installations`，body 为 `{}`，拿回 token 后再 PUT grant（`server/cloud-connected-apps.ts:146-168`；`electron/managed-composio.mjs:76-91`）。数据仍然只是安装注册和 grant，不是聊天内容，但请求次数和端点比 01 写的多一个。

**与 01 第 16 条的措辞有证据缺口。** 01 写 Cloud Files 会发“完整本地路径、主机名”；代码确认注册体含 `pcPath` 和 `computerName`（`server/cloud-sync.ts:113-120`），但 `computerName` 是否等于主机名由桌面端决定，仓库内没有在服务端证明。应写成“桌面提供的 computerName，通常是主机名”，不要当成服务端已验证的主机名。

**与 02 的 G-27 一致。** 非 Cloud home 时 `/api/sync` 直接 `PASS`，随后没有同路径处理器；Cloud 才要求 admin session（`server/routes/cloud-sync.ts:35-40`）。这一点没有冲突。

## 三、主体表

| 编号 | 文件:行 | 限制或行为 | 触发条件 | 默认值 | 技术限制/商业许可 | 建议（删除/默认关闭/改可配置/保留） |
|---|---|---|---|---|---|---|
| C01 | `server/cloud-home.ts:16-17,49-51,69-87`；`server/index.ts:695-698` | 任一 Cloud home 变量出现即进入 Cloud 模式，四元组必须齐全且合法 | 设置任一 `EAC_CLOUD_ROLE`、`EAC_CLOUD_MACHINE_ID`、`EAC_CLOUD_ADMIN_URL`、`EAC_CLOUD_BOOTSTRAP_SECRET` | 未设置时返回 null，不进入 Cloud 模式 | 技术限制 | 保留 |
| C02 | `server/cloud-secrets.ts:6-7,24-42`；`server/index.ts:2,695-696,730` | 只从继承 FD 读取已知 Cloud 密钥，读完关闭，缺失时返回空对象 | 启动时存在 `EAC_CLOUD_SECRETS_FD` | 无 FD 时 `{}`；FD 非法或 JSON 坏时抛错 | 技术限制 | 保留 |
| C03 | `server/cloud-home.ts:171-222`；`server/routes/cloud-signed.ts:160-168` | Admin 用 bootstrap secret 的 HMAC 签名开配对窗口，支持 admin/client 或 Team member scopes | Cloud home 收到 `POST /api/cloud/pairing` | 无 Cloud 时不注册该路由 | 技术限制 | 删除 |
| C04 | `server/cloud-health.ts:19-21,294-314`；`server/host/cloud-signed-host.ts:31-38` | 健康报告只含固定代码、计数、时间、版本和 id，不含聊天原文 | Cloud home 的签名 `GET /api/cloud/health` 或 `/api/cloud/box` | 无 Cloud 时 `cloudHealth=null` | 技术限制 | 删除 |
| C05 | `server/cloud-power.ts:106-161,205-219`；`server/index.ts:15501` | 每 5 秒采样忙碌状态，向 Admin 报告是否可休眠；不自行关机 | Cloud home 且 Admin 调用 `/api/cloud/power` | 非 Cloud 不创建，5 秒 tick 仅 Cloud | 技术限制 | 删除 |
| C06 | `server/host/cloud-plan-tier.ts:20-43`；`server/routes/cloud-signed.ts:126-140` | 把 Admin 签名 POST 的计划层级写入本地缓存，决定 Starter 限制 | Cloud home 收到 `/api/cloud/plan` | 无文件即非 Starter | 商业许可 | 保留 |
| C07 | `server/cloud-team-policy.ts:26,176-184,224-229,278-291` | Team Cloud 每 5 分钟拉规则，规则只能收紧；失败保留上一版 | `EAC_CLOUD_ROLE=team` 且已配对 | 无规则即不限制 | 商业许可 | 保留 |
| C08 | `server/cloud-connected-apps.ts:20,138-168,176-179`；`server/index.ts:15509` | Cloud home 自动注册 Connected Apps，失败按 30 秒到 30 分钟退避 | Cloud home 启动且 broker URL 可解析 | 非 Cloud 直接 no-op | 技术限制 | 删除 |
| C09 | `server/cloud-connected-apps.ts:114-135`；`electron/managed-composio.mjs:76-91` | 首次注册 `POST /v1/installations`，之后 `PUT /v1/installation/cloud` 只带 grant | 已有 installation token 或首次注册 | 无 broker URL 不注册 | 技术限制 | 删除 |
| C10 | `server/cloud-credit-provider.ts:21-22,86-97,105-107`；`server/index.ts:1546-1557` | 试用额度启动时 GET relay 的 `/models`，失败退避重试 | Cloud home 且 `EAC_CLOUD_AI_URL/TOKEN` 合规 | 无 Cloud 或无效 token 时 no-op | 商业许可 | 保留 |
| C11 | `server/cloud-credit-provider.ts:43-49`；`server/drivers/openai-chat.ts:297,490-517` | 选中 trial-credit 实例后，对话正文发到 `EAC_CLOUD_AI_URL` 的 OpenAI 兼容端点 | 用户选择 `trial-credit` 模型并开始回合 | 不选择该模型就不走 relay | 商业许可 | 保留 |
| C12 | `server/hosted-models.ts:24-35,80-93` | 公司模型把 Claude/Codex/OpenRouter 的 base URL 指到 Admin 的 gateway，并限制目录 | 托管工作区配置了 `EAC_HOSTED_MODEL*` | 未配置即 null | 商业许可 | 保留 |
| C13 | `server/managed-desktop.ts:58-77,102-159` | 企业桌面连接把 provider 指到 `portalOrigin/api/desktop/gateway`，token 只在内存 | Electron 私有 parent port 推送 `eacbot:managed-desktop` | 无连接时不加载任何公司实例 | 商业许可 | 保留 |
| C14 | `server/enterprise.ts:71-88`；`server/index.ts:755,12659-12678` | 任一 `EAC_ADMIN_*` 进入 hosted 模式；缺完整配置时不退出但登录和 readiness 不可用 | 设置任一 hosted 变量 | 未设置时 `HOSTED_WORKSPACE=false` | 商业许可 | 保留 |
| C15 | `server/enterprise.ts:119-151`；`server/index.ts:15437,15452` | enterprise 层动态 import，失败、缺 key 或过期都降级 OSS | 启动时存在 enterprise 目录或许可证 | 无目录、无 key 一律 OSS | 商业许可 | 保留 |
| C16 | `server/announcement-feed.ts:27,116-125`；`server/index.ts:12493` | 只有设置 URL 才在约 1 秒后拉取公告，之后每 10 分钟 | `EAC_ANNOUNCEMENTS_URL` 非空 | 空 URL 不建定时器 | 技术限制 | 默认关闭 |
| C17 | `server/update-check.ts:11-20,108-120`；`server/index.ts:12493` | 只有显式 URL 才发 release GET，8 秒超时，缓存 1 小时 | 客户端请求 `/api/updates/check` 且 `EAC_UPDATE_CHECK_URL` 合法 | 空 URL 返回 `checked:false` | 技术限制 | 默认关闭 |
| C18 | `server/model-catalog/catalog.ts:43,47,160-166,221-224` | 定义了 models.dev 抓取、24 小时缓存和禁用开关；当前未见接入启动链 | 只有调用 `refresh()` 才会请求 | `EAC_DISABLE_MODEL_CATALOG_FETCH=1` 可禁用；当前未接入 | 技术限制 | 保留 |
| C19 | `server/cloud-sync.ts:1-4,113-122`；`server/routes/cloud-sync.ts:35-40` | 桌面注册文件夹，上传内容、路径和 computerName；服务端接收并保存 | Cloud home 的 admin session 调用 `/api/sync` | 非 Cloud 直接 PASS；无定时器 | 技术限制 | 删除 |
| C20 | `server/cloud-sync.ts:200-205,232-252`；`server/lent-copies.ts:74-92` | 下载云端文件、回收站恢复、lent folder 暂存 | 桌面拉取或恢复，或 lent 电脑离线 | 无 Cloud 不读同步目录 | 技术限制 | 删除 |
| C21 | `server/cloud-send-chats.ts:379-383`；`server/routes/cloud-send.ts:1-7` | Move to Cloud 按行返回聊天，含正文和附件名 | 已认证桌面请求 `/api/cloud-send/chats/rows` | 非 owner 403；无后台定时器 | 技术限制 | 删除 |
| C22 | `server/cloud-send-files.ts:1-5`；`server/cloud-send-memory.ts:1-4`；`server/cloud-send-kinds.ts:1-5` | Move 携带 bot 文件、记忆、例程、技能、设置和自动化 | 用户执行 Move，目标端按同一 id 接收 | 非 Move 不扫描这些目录 | 技术限制 | 删除 |
| C23 | `server/cloud-send-verify.ts:1-5,17-27` | 凭据只回 HMAC 指纹；但 owner session 可离线猜弱密码 | 目标 Cloud 请求 `/api/cloud-send/verify-secrets` | 非 Cloud 不提供该验证 | 技术限制 | 删除 |
| C24 | `server/cloud-connections-host.ts:88-99`；`server/index.ts:2853` | 搬迁时把 MCP OAuth、Composio、邮箱等连接交给目标 Cloud | 用户执行 Move 或桌面 handoff | 没有 Move 不触发 | 技术限制 | 删除 |
| C25 | `server/boat.ts:139-149,886-901`；`server/included-services.ts:11,75,79-81` | Boat API 请求带 Bearer token，own token 直连 boat.dev，included token 只去 relay | 配置了 `cfg.box.token` 或 `EAC_CLOUD_BOAT_URL/TOKEN` | 无 token 时 `configured:false`，不请求 | 技术限制 | 删除 |
| C26 | `server/boat.ts:64-65,1062-1108`；`server/host/cloud-computer-power.ts:15-21` | 云电脑默认 8 小时 TTL，试用 2 小时；创建等待 90 秒，启动预算 150 秒 | 用户显式 provision/wake 或回合需要云电脑 | 无 Boat 不创建 | 技术限制 | 删除 |
| C27 | `server/cloud-computer-files.ts:75-100,120-130,197-206` | Boat 传输链接只允许 HTTPS 或 loopback HTTP；复制上限 2 GiB | 用户或 bot 调用 `copy_from_computer`、`copy_to_computer` | 无云电脑不触发 | 技术限制 | 删除 |
| C28 | `server/cloud-computer-tools.ts:17-43,27-30` | 云电脑工具可截图、点击、输入、打开 URL、执行完整 shell、传文件 | 回合挂载 Cloud computer MCP 后调用 | 无 Boat 或未挂载不可用 | 技术限制 | 删除 |
| C29 | `server/hosted-slack.ts:1-14`；`server/routes/hosted-slack.ts:1-21` | 只返回 Admin 的 `/slack?workspace=&bot=` 深链，不持有 Slack 逻辑 | hosted workspace 且已登录 | 非 hosted 返回 `{available:false}` | 商业许可 | 保留 |
| C30 | `server/cloud-team-admin.ts:1-3,14,20,41-67` | Team Admin 摘要含连接器 slug、账号 id/别名、MCP host、密钥是否配置、引擎账号 email | Team Admin 的签名 GET `/api/cloud/team/admin` | 无 Team 不注册该路由 | 商业许可 | 改可配置 |
| C31 | `server/cloud-home-start.ts:396-457` | Cloud supervisor 启动 Caddy，并在有 tunnel token 时启动 cloudflared，失败重启 | 执行 `startCloudHome()` 的 Cloud 镜像 | 不执行该入口则完全不发生 | 技术限制 | 默认关闭 |
| C32 | `server/tunnel.ts:180-195,255-290`；`server/cli.ts:34-62` | 控制面发放公网 endpoint/token，cloudflared 建立公网入口 | `eacbot serve --tunnel` 或桌面远程访问 | 默认不启动，非 `server/index.ts` 路径 | 技术限制 | 默认关闭 |
| C33 | `server/tailscale.ts:101-113`；`server/cli.ts:37,706,772` | 调用 `tailscale serve --bg --https` 把本地端口发布到 tailnet | 用户显式运行 CLI | 默认不调用 | 技术限制 | 默认关闭 |
| C34 | `server/fleet-agent.ts:205-221`；`server/routes/status.ts:82-86` | root agent 在 Unix socket 上管理租户，Web 路由要求企业 admin entitlement | 执行 `eacbot fleet init/agent` 并调用 `/api/fleet` | 主服务不启动 agent | 商业许可 | 保留 |
| C35 | `server/fleet.ts:235-242,385`；`server/fleet-cli.ts:330-336` | 把 license、Anthropic/OpenRouter key 写入租户 env 文件，mode 0600 | 创建或更新 Fleet workspace | 无 Fleet 不发生 | 商业许可 | 保留 |
| C36 | `server/container-computer.ts:26-29,105-113` | Local VM 基础镜像固定 digest，Cua wheel 带 SHA-256，首次准备时拉取 | 首次使用 Local VM 或镜像不匹配 | 不启用 Local VM 不拉取 | 技术限制 | 保留 |
| C37 | `server/container-computer.ts:825-827,973-975,1177-1219` | 容器 4GB 内存、2 CPU、4096 pids、cap drop、共享容器发布 127.0.0.1:6080；自动创建用随机 VNC 密码，手动 setup 展示命令用固定 CHANGE_ME | 自动创建 shared Local VM，或用户复制 setup 展示命令 | 自动随机；展示命令 CHANGE_ME；函数默认参数 CHANGE_ME | 技术限制 | 改可配置 |
| C38 | `server/vps-computer.ts:182-186`；`server/vps-ssh.ts:47-62` | Docker 通过 `ssh://alias` 访问远端 daemon，SSH 配置先包含用户自己的 config | `cfg.vps.sshAlias` 合法且用户操作 VPS | 无 alias 不启用 | 技术限制 | 保留 |
| C39 | `server/vps-computer.ts:831-878` | VPS 容器 cap drop ALL、只加 SETUID/SETGID、4GB/2CPU、bridge、无宿主挂载、unless-stopped | 首次 provision 或 start | 无 alias 不创建 | 技术限制 | 保留 |
| C40 | `server/shared-computers.ts:164-180`；`server/routes/shared-computers.ts:52-66` | 注册需要 session 和每电脑 secret；Cloud home 还要求 admin scope | 桌面开启共享并调用 `/api/shared-computers/connect` | `features.sharedComputers=false` | 技术限制 | 保留 |
| C41 | `server/shared-computers.ts:95-129,360` | 服务端按 folders、terminal、screen、MCP 范围排队，桌面端仍要再授权 | bot 调用共享电脑操作 | 无共享电脑无操作 | 技术限制 | 保留 |
| C42 | `server/shared-computer-control.ts:3-4,17-61` | 屏幕互斥租约 40 秒过期，避免 Electron 崩溃永久占屏 | 本机 bot 与 lent screen 同时要屏幕 | 无共享/无控制不创建租约 | 技术限制 | 保留 |
| C43 | `server/computer-control.ts:1-3,64-70,109-117` | 只有人能 take/release，bot 只能 requestHelp；人持有期间动作拒绝 | 用户点击 Take control | 默认未持有 | 技术限制 | 保留 |
| C44 | `server/control-client.ts:60-65,96-103` | 没有 URL 或 token 时 configured=false，返回 DISENGAGED，不请求 | 构造 control client 时读取 `EAC_CONTROL_URL`、`EAC_CONTROL_TOKEN` | 两者都空即未配置 | 技术限制 | 保留 |
| C45 | `server/places-elsewhere.ts:1-7,74-124`；`server/routes/places-elsewhere.ts:10-20` | 只保存其他 place 的名字和 bot 名，不保存地址、id 或消息 | 本机 owner 的 app PUT `/api/places/elsewhere` | 无文件返回空列表 | 技术限制 | 保留 |
| C46 | `server/index.ts:15526-15535` | 设置 `EAC_TUNNEL_SOCKET` 时监听本地 IPC，请求按代理处理并要求 session | 启动时设置该变量 | 未设置不监听 | 技术限制 | 默认关闭 |
| C47 | `server/computer-previews.ts:1-15` | 每个电脑同时只抓一张预览，预览不持生命周期锁 | 面板请求预览 | 无请求不抓 | 技术限制 | 保留 |
| C48 | `server/cloud-sync-paths.ts:9-15` | 同步根默认是数据目录父级的 `Synced`，可用 `EAC_SYNC_ROOT` 覆盖；lent 副本在 data/sync/lent | 首次使用 Cloud Files | 非 Cloud 不创建 | 技术限制 | 删除 |
| C49 | `server/routes/cloud-sync.ts:35-40` | `/api/sync` 只在 Cloud home 且 admin session 下工作 | Cloud Files 请求 | 非 Cloud 直接 PASS | 技术限制 | 删除 |
| C50 | `server/routes/cloud-send.ts:80-91`；`server/index.ts:12270` | Cloud Send 的 owner 只接受 Cloud owner、ownHome owner 或 Team move 的受限 scope | Move to Cloud 请求 | 非 owner 403 | 技术限制 | 删除 |
| L01 | `server/index.ts:1520-1524`；`server/cloud-home.ts:116-119` | Cloud home 固定拒绝 local 和 VM，即使没有 managed policy | Cloud home 选择 Works on 为本机或 VM | 非 Cloud 不受这条限制 | 技术限制 | 改可配置 |
| L02 | `server/local-vm-settings.ts:4-10` | Local VM 默认 shared、最多 2 个、空闲 480 分钟 | 使用 Local VM | shared/2/480 | 技术限制 | 改可配置 |
| L03 | `server/container-computer.ts:64-70,825-827,973-975,1219` | 共享容器固定 127.0.0.1:6080；自动创建随机密码，手动 setup 展示命令 CHANGE_ME | 启动 shared Local VM | 6080；自动随机；展示命令 CHANGE_ME | 技术限制 | 改可配置 |
| L04 | `server/local-vm-settings.ts:20-22` | Local VM 空闲停止默认 480 分钟，范围 5 到 1440 | 容器空闲 | 480 分钟 | 技术限制 | 改可配置 |
| L05 | `server/vps-computer.ts:112-115` | VPS 只在显式 cloud、autoStartVps 或自动化来源时启动 | 回合选择 VPS 或例行任务 | 默认不自动启动 | 技术限制 | 改可配置 |
| L06 | `server/vps-computer.ts:873-875` | VPS 容器 `--restart unless-stopped`，没有服务端空闲停止 | 创建 VPS 容器后 | 始终保持运行除非手动 stop | 技术限制 | 改可配置 |
| L07 | `server/team-computers.ts:56-58` | Team 电脑只被 Auto 目的地的 bot 继承，显式目的地不继承 | bot.section 有 Team 电脑且 bot.computer 未设置 | 无 Team 电脑不继承 | 技术限制 | 保留 |
| L08 | `server/config.ts:704-705` | 共享电脑功能默认关闭 | `features.sharedComputers` 为 true 或 Cloud home | false | 技术限制 | 默认关闭 |
| L09 | `server/mcp-bridge.ts:333-335,369-373`；`server/container-mcp.ts:17-26` | 没有 gate 就不拦截电脑调用；有 gate 但读取失败时 fail-closed | 子进程带 `EAC_CONTROL_URL/TOKEN` | 不配置则不拦截 | 技术限制 | 保留 |
| L10 | `server/places-elsewhere.ts:59-64,103-123` | 只把“bot 在别处”的解释给 bot 和人，不连接对方 | bot 找不到同名 bot 或 @ 提及其他 place | 无文件只给 ONE_PLACE 提示 | 技术限制 | 保留 |
| L11 | `server/index.ts:15526-15535` | 本地 IPC 监听，请求没有 peer address，按代理处理 | 设置 `EAC_TUNNEL_SOCKET` | 不设置不启动 | 技术限制 | 默认关闭 |
| L12 | `server/tailscale.ts:101-113` | 把本地端口通过 tailscale serve 发布到 tailnet，HTTPS 端口默认 443 | 用户显式调用 CLI | 不调用不发布 | 技术限制 | 默认关闭 |
| L13 | `server/host/cloud-computer-power.ts:15-18,63-100` | 云电脑空闲 10 分钟后休眠，临近例行任务则保持 | Boat 已配置且有运行中的云电脑 | 10 分钟 | 技术限制 | 改可配置 |
| L14 | `server/computer-previews.ts:1-15` | 预览抓取不占生命周期锁，避免看面板阻塞操作 | 面板打开 | 无 | 技术限制 | 保留 |
| L15 | `server/cloud-sync.ts:1-4`；`server/cloud-send.ts:1-3` | 同步和 Move 都由桌面驱动，没有服务端定时推送 | 用户打开 Files 或 Move | 无用户操作不发生 | 技术限制 | 删除 |
| A01 | `server/index.ts:702,936-938`；`server/cloud-owner.ts:1-4` | Cloud home 只有 owner 的 admin session 能登录并 lending | Cloud home 启动 | 非 Cloud 不适用 | 技术限制 | 保留 |
| A02 | `server/index.ts:936-938,2853`；`server/cloud-team.ts:27-37` | Team Cloud 不 lending；成员只有 client scope，session 最多 1 小时 | Team Cloud | 非 Team 不适用 | 商业许可 | 保留 |
| A03 | `server/cloud-team.ts:27-37,50-60` | Team member 的配对 claim 必须带邮箱和角色，owner/admin 才有 admin scope | Admin 签名配对 | 无 claim 拒绝 | 商业许可 | 保留 |
| A04 | `server/cloud-home.ts:138-162`；`server/routes/cloud-signed.ts:160-168` | pairing/health/power 各有独立 nonce 集；签名先常数时间比较，再查时钟和重放 | Admin 签名请求 | 无 Cloud 不注册 | 技术限制 | 保留 |
| A05 | `server/routes/cloud-signed.ts:64-75,149-158` | 签名路由在 session gate 之前运行，签名本身就是凭据 | Cloud home 的 signed path | 无 Cloud 不注册 | 技术限制 | 保留 |
| A06 | `server/enterprise.ts:107-110`；`server/index.ts:12659-12678` | hosted 模式缺 enterprise 层时 `workspaceAccess=null`，登录/readiness 503 | `EAC_ADMIN_*` 已配但层缺失 | 未配 hosted 不触发 | 商业许可 | 保留 |
| A07 | `server/managed-policy.ts:83-97,134-147` | 无策略时 managed policy 全开；有策略可禁引擎、MCP、电脑、远程访问 | Electron parent 或 Team 规则下发 | 无策略不限制 | 商业许可 | 保留 |
| A08 | `server/routes/status.ts:82-86`；`server/fleet-agent.ts:205-219` | `/api/fleet` 需要 admin entitlement；socket 只给 root 和 operator 组 | 企业 Fleet | 无 entitlement 403 | 商业许可 | 保留 |
| A09 | `server/routes/shared-computers.ts:52-66`；`server/shared-computers.ts:164-180` | 共享电脑注册绑定 session 和 secret，不能跨 session 接管 | 桌面注册 | 功能默认关 | 技术限制 | 保留 |
| A10 | `server/vps-computer.ts:182-186`；`server/vps-ssh.ts:48-62` | VPS 权限等于 SSH alias 的账号权限；代码不限制目标主机 | 用户配置 alias | 无 alias 不适用 | 技术限制 | 改可配置 |
| A11 | `server/boat.ts:477-484,886-901` | Boat token 是账号级能力；服务端只用名字前缀防误删 | 配置 Boat token | 无 token 不适用 | 技术限制 | 改可配置 |
| A12 | `server/index.ts:12926-12939` | 本地屏幕互斥只接受 loopback，不授予新能力 | 桌面调用 control 路由 | 功能关时 404 | 技术限制 | 保留 |
| A13 | `server/routes/places-elsewhere.ts:10-20` | Places 只有本机 owner 可写，Team/shared/hosted 不可写 | PUT `/api/places/elsewhere` | 非 owner 403 | 技术限制 | 保留 |
| A14 | `server/routes/cloud-sync.ts:37-40` | Cloud Files 只接受 Cloud home 的 admin session | 同步请求 | 非 Cloud 404 | 技术限制 | 删除 |
| A15 | `server/routes/cloud-send.ts:80-91`；`server/index.ts:12270` | Cloud Send 只接受 owner 或受限 Team move scope | Move 请求 | 非 owner 403 | 技术限制 | 删除 |
| Q01 | `server/cloud-home.ts:22-31,207` | 配对默认 300 秒，最大 600 秒；浏览器登录最大 120 秒；时钟偏差 300 秒；nonce 保留 10 分钟 | Admin 配对 | 300/600/120/300/10 分钟 | 技术限制 | 改可配置 |
| Q02 | `server/cloud-health.ts:19-21` | 健康报告最大 64KB，最多 200 个 incident bucket | Admin 拉健康 | 64KB/200 | 技术限制 | 保留 |
| Q03 | `server/cloud-power.ts:47-59,154-161` | 空闲 10 分钟、工作后 2 分钟、唤醒后 2 分钟、到期前 5 分钟、sleep 挂起 120 秒；tick 5 秒 | Cloud home power | 10/2/2/5/2 分钟 | 技术限制 | 改可配置 |
| Q04 | `server/cloud-connected-apps.ts:20,104-110` | 注册退避 30 秒、60 秒、120 秒、300 秒、600 秒、1800 秒，带 20% 抖动 | Cloud home 启动注册 | 30 秒起，最多 30 分钟 | 技术限制 | 改可配置 |
| Q05 | `server/cloud-team-policy.ts:26-29,224-229` | Team 规则 5 分钟刷新，15 秒超时；15 分钟未新鲜则 requireFresh 会拒绝新回合 | Team Cloud | 5/15 分钟 | 商业许可 | 改可配置 |
| Q06 | `server/cloud-credit-provider.ts:21-22,122-134` | 试用额度重试 15 秒到 10 分钟，指数退避 | 试用 relay 不可用 | 15 秒起 | 商业许可 | 保留 |
| Q07 | `server/boat.ts:64-65,1102-1103`；`server/host/cloud-computer-power.ts:15-21` | Boat TTL 8 小时，试用 2 小时；创建等待 90 秒；启动预算 150 秒 | Boat 创建/唤醒 | 8h/2h/90s/150s | 技术限制 | 改可配置 |
| Q08 | `server/boat.ts:41,68-70` | 远程命令最长 4000 字符；库存每页 200，最多 10 页 | Boat exec/列表 | 4000/200/10 | 技术限制 | 改可配置 |
| Q09 | `server/vps-computer.ts:331-353,858` | Docker over SSH 默认 120 秒超时，终止宽限 5 秒；pids 4096 | VPS 命令 | 120s/5s/4096 | 技术限制 | 改可配置 |
| Q10 | `server/local-vm-settings.ts:4-10` | Local VM 最多 8 个，空闲 5 到 1440 分钟 | Local VM 配置 | 2/480 | 技术限制 | 改可配置 |
| Q11 | `server/shared-computers.ts:49-59,77-84` | 默认命令 120 秒，旧桌面上限 240 秒，MCP 工具 145 秒/调用 315 秒；任务保留 14 天 | 共享电脑调用 | 120/240/145/315/14 天 | 技术限制 | 改可配置 |
| Q12 | `server/cloud-sync.ts:13-17,151-154` | 单次上传 part 最大 64MB，上传 24 小时过期，变更日志 1000 条，磁盘保留由 `cloudReserveBytes` 决定 | Cloud Files | 64MB/24h/1000 | 技术限制 | 改可配置 |
| Q13 | `server/cloud-send-chats.ts:21-27`；`server/cloud-send-files.ts:20-28` | 聊天分页 300 行/2MB，单请求 64MB；文件 part 8MB，最多 20 万文件，partial 24 小时 | Move to Cloud | 300/2MB/64MB/8MB/200k | 技术限制 | 改可配置 |
| Q14 | `server/fleet-agent.ts:27,205-219` | Fleet 请求体最大 256KB；socket 0660，root 和 operator 组可连 | Fleet agent | 256KB/0660 | 商业许可 | 保留 |
| Q15 | `server/control-client.ts:4-9,62-64` | 控制等待 45 秒，动作必须在 5 秒内完成，读取超时 55 秒，缓存 750 毫秒 | 电脑控制 gate | 45s/5s/55s/750ms | 技术限制 | 保留 |

## 四、边界条件与失败矩阵

Cloud home 的校验不是“有变量就启用”，而是逐项拒绝。缺 `EAC_CLOUD_ROLE` 时角色不是 home 或 team，`cloudHomeConfiguration` 抛错（`server/cloud-home.ts:74-75`）。角色是 team 但缺 `EAC_CLOUD_TEAM_ID` 或缺 `EAC_CLOUD_TEAM_NAME`，同样抛错（`:95-102`）。`EAC_CLOUD_ADMIN_URL` 与 `EAC_PUBLIC_URL` 必须是精确的 https origin，不能带路径、用户名、密码或查询串（`:57-67,79-80`）。`EAC_CLOUD_MACHINE_ID` 必须是 3 到 128 位的字母、数字、下划线或连字符（`:77-78`）。`EAC_CLOUD_BOOTSTRAP_SECRET` 必须是 43 到 128 位的 base64url（`:81-82`）。`EAC_DESKTOP_PARENT=1` 与 Cloud 同时出现会拒绝（`:72`）。Cloud 与 hosted workspace 同时配置会拒绝（`:73`）。这些条件都在 `server/index.ts:697` 同步执行，失败发生在监听之前。

`EAC_CLOUD_IMAGE` 不在 `CLOUD_HOME_KEYS` 中，单独设置不会进入 Cloud 模式；它只在没有 Cloud 时被 `cloud-health` 当作版本信息读取（`server/cloud-home.ts:16-17`；`server/index.ts:2864` 的 health 依赖里传 `EAC_CLOUD_IMAGE`）。同理，单独设置 `EAC_CLOUD_BOAT_TOKEN` 或 `EAC_CLOUD_AI_TOKEN` 只影响 included service，不会触发 Cloud home 的四元组校验（`server/included-services.ts:14,37-43`）。

Cloud secrets 的失败也是启动失败。`EAC_CLOUD_SECRETS_FD` 必须是 3 到 1024 的整数（`server/cloud-secrets.ts:25-29`）；FD 不可读时抛错并关闭 FD（`:30-37`）；内容不是 JSON 对象时抛错（`:38-42`）。它只读取 `CLOUD_HOME_SECRET_KEYS` 白名单，不会把任意 JSON 字段带进环境（`:6,42`）。读完会从 `process.env` 删除 FD 名，避免子进程继承（`:27`）。

hosted workspace 的失败是“半可用”。`hostedWorkspaceConfigured` 只看三个 `EAC_ADMIN_*` 是否出现（`server/enterprise.ts:71-73`）；`hostedWorkspaceConfiguration` 要求 workspace 形状合法、admin/tenant 是精确 https origin、membership 只能是 local 或 portal（`:76-88`）。不合法时返回 null，但 `HOSTED_WORKSPACE` 仍为 true（`server/index.ts:755`），于是服务启动、hosted 登录被 403 拒绝、readiness 返回 503（`:12659-12678`）。这不是启动硬失败，但对托管部署是不可用状态。

`hostedModelPolicy` 的失败是启动硬失败。只要 `EAC_HOSTED_MODELS` 或 `EAC_HOSTED_MODEL_TOKEN` 任一存在，就必须同时有 `EAC_ADMIN_*`、portal membership、非桌面、token 形状正确、JSON 目录合法；否则抛错（`server/hosted-models.ts:24-35`）。它还会在 Cloud home 上直接返回 null，避免 Cloud 误用托管模型（`:26`）。

enterprise 层的失败是 OSS 降级。没有目录、没有 `EAC_LICENSE_KEY`、key 过期、register 抛错，都会返回 `{edition:"oss",features:[]}` 而不是退出（`server/enterprise.ts:119-151`）。许可证到期后还有 7 天宽限，之后 `entitled()` 一律 false（`:160-163,193-195`）。这是合法的产品降级路径；删除 `enterprise/` 目录是允许的 OSS 决策，修改 key 或伪造 entitlement 不是。

`control-client` 的失败分两种。没有 URL 或 token 时 `configured=false`，`state()` 返回 DISENGAGED，所有电脑调用照常进行（`server/control-client.ts:60-65,96-103`）。两者都有但服务不可达、HTTP 非 2xx、JSON 形状不对或超时，`read()` 返回 `UNCONFIRMED`，`controlRefusal` 会拒绝调用（`:71-92`；`server/control-client.ts:28-30,49-51`）。这是 fail-closed，不是 fail-open。

`fleet-client` 的失败不影响启动。默认 socket 是 `/run/eacbot/fleet.sock`（`server/fleet-client.ts:10-12`）；不存在时 `fleetAvailable=false`，路由 404（`server/routes/status.ts:85-86`）。socket 存在但连接被拒、权限不足或超时，`fleetRequest` 抛错，路由 502（`server/fleet-client.ts:34-41`；`server/routes/status.ts:96-100`）。它没有自动重试，也没有后台心跳。

`boat` 的失败按功能降级。没有 token 时 `boatStatus` 返回 `{configured:false,box:null}`（`server/boat.ts:1062-1069`）；`provisionBoat` 抛“Boat is not configured”（`:1072-1076`）；`listManagedBoats` 返回 `configured:false` 的空列表（`:483-485`）。token 被 401/403 拒绝时返回 `credentialRejected` 和 problem，不会清空本地配置（`:487-488`；`verifyToken` `:904-920`）。网络失败时返回 problem，调用方通常把它变成“云电脑不可用”，不影响本地回合。

`vps` 的失败是功能不可用。alias 不合法时 `vpsSshAlias` 返回 null（`server/config.ts:622-624`）；没有 alias 时 inventory 返回 `configured:false`（`server/vps-computer.ts:805-809`）；SSH 不通时 status 失败，但在回合中会被转成 place-failed（`server/index.ts:1890-1910`）。它不会自动启动，也不会在启动时扫描所有 alias；只有 `vpsAliasesInPlay` 被显式调用时才枚举（`server/vps-hosts.ts:15-23`）。

`container` 的失败是本机功能不可用。Docker/Podman/container 都不在 PATH 时，状态探测返回不可用；Local VM 的启动/停止抛错，但主服务继续（`server/container-computer.ts:48-50,826-905`）。它可能拉取镜像，但只在首次准备或镜像不匹配时发生；没有 Local VM 请求就不会拉（`:26-35,105-113`）。

`shared-computers` 的失败是 404 或排队拒绝。功能关时 GET/POST 都 PASS，随后没有同路径处理器（`server/routes/shared-computers.ts:36-56`）。session 不匹配、secret 不匹配、电脑离线、job 过期都会返回 403/409 或错误文本（`server/shared-computers.ts:164-180,360`）。它不会回退到“直接在服务器上执行”。

`cloud-sync` 的失败是 404/410/507。非 Cloud 直接 PASS（`server/routes/cloud-sync.ts:35-37`）；文件夹不存在返回 404，路径是链接返回 400，磁盘不足返回 507（`server/cloud-sync.ts:57-73,151-154`）。上传的 part 用临时文件，commit 校验 sha256 后才 rename（`:177-198`）。

`cloud-send` 的失败是 403/404/409。非 owner 被 403（`server/routes/cloud-send.ts:80-82`）；不支持的路由 404；冲突或未完成的上传由具体子路由返回 409/422。它没有后台队列，桌面不请求就不会发送。

## 五、逐模块删改顺序

如果目标是“纯本地产品”，建议按依赖从外到内删，避免先删底层导致 import 断裂：

第一组，保留但不配置：`cloud-secrets-boot.ts`、`cloud-secrets.ts`、`cloud-home.ts`、`hosted-contract.ts`、`fleet-client.ts`。它们被 `server/index.ts` 直接 import（`server/index.ts:2,201-202,280`）。`cloud-home.ts` 可以缩成只导出 `cloudHomeConfiguration() { return null; }` 和类型，但这会改变 Cloud 产品；纯本地保留原实现也完全可用。

第二组，整组删除但必须改 import：`cloud-signed-host.ts`、`routes/cloud-signed.ts`、`cloud-health.ts`、`cloud-power.ts`、`cloud-plan-tier.ts`、`cloud-team-policy.ts`、`cloud-team-admin.ts`。耦合点是 `server/index.ts:282-283,2863-2864,15501,15509` 和 `server/routes/cloud-signed.ts` 的调用；删除后 Admin 的签名请求全部消失，Cloud home 也不再可管理。这是产品决策，不是技术清理。

第三组，Cloud Files 与 Move：`cloud-sync.ts`、`routes/cloud-sync.ts`、`cloud-sync-store.ts`、`cloud-sync-paths.ts`、`lent-copies.ts`、`lent-clone.ts`、`cloud-send*.ts`、`cloud-chat-merge.ts`、`cloud-connections*.ts`。耦合点是 `server/index.ts:284,595,12270` 和 `server/routes/cloud-signed.ts` 的 verify；如果只删服务端而保留 Electron 的 Cloud Files 按钮，会出现“按钮在、请求 404”的假功能。应先删桌面入口，再删服务端路由。

第四组，Cloud 计划与托管模型：`cloud-connected-apps.ts`、`cloud-credit-provider.ts`、`hosted-models.ts`、`managed-desktop.ts`、`managed-policy.ts`。这些与商业许可/企业策略绑定，不能为了“去云”而绕过校验。合法路径是产品明确选择 OSS：删 `enterprise/`、让 `entitled()` 恒假、删 hosted 路由；或者保留企业版，只把 Cloud 默认关闭。

第五组，Boat：`boat*.ts`、`cloud-computer-*.ts`、`host/cloud-computer-power.ts`。耦合点是 `server/index.ts:99,117-120,136-139,15514,15224-15411` 和 `server/host/cloud-computer-power.ts` 的 `boat` 调用。若只想保留自建远程电脑，优先保留 VPS，把 Boat 默认关闭；不要同时删掉 VPS 和 Boat，否则“cloud computer”产品面会完全消失。

第六组，本地能力：`shared-computers.ts`、`shared-computer-control.ts`、`lent-computers.ts`、`lent-copies.ts`、`lent-clone.ts`、`lent-mcp.ts`、`computer-control.ts`、`computer-asks.ts`、`computer-frames.ts`、`computer-previews.ts`、`computer-selection.ts`、`computer-tool-list.ts`、`computer-wait.ts`、`container-*.ts`、`local-vm-*.ts`。这些是纯本地或点对点能力，建议保留；删除会让本机共享电脑、Local VM 和电脑面板一起消失。

第七组，独立 CLI：`tunnel.ts`、`tailscale.ts`、`fleet.ts`、`fleet-agent.ts`、`fleet-cli.ts`。它们不进入 `server/index.ts`；删它们只需要改 `server/cli.ts:34-62` 和发布脚本。若保留 Fleet 作为企业功能，应同时保留 `routes/status.ts:82-100` 的管理入口。

## 六、数据流目的地与关闭方式

按目的地分，Cloud Admin 是最主要的元数据接收方：Team 规则请求、健康报告、power 报告、Team admin 摘要、plan 请求都指向 `EAC_CLOUD_ADMIN_URL`（`server/cloud-team-policy.ts:21,181`；`server/routes/cloud-signed.ts:75-158`）。这些请求都由 Admin 主动拉取或由 Cloud 定时拉取；关闭方式是不要配置 Cloud home 或删对应 signed 路由。

Boat 是云电脑内容和计费接收方：API 请求直连 `https://boat.dev/api/v1` 或 included relay（`server/boat.ts:139-149`；`server/included-services.ts:11,75`）。关闭方式是不配置 Boat token，或把 `cloudBackend` 改为 `vps`/本地；仅关闭 UI 不足以阻止已配置的定时 `armRunning`。

Connected Apps broker 是 Cloud 计划的注册接收方：首次 `POST /v1/installations`，之后 `PUT /v1/installation/cloud`（`electron/managed-composio.mjs:76-91`；`server/cloud-connected-apps.ts:114-135`）。关闭方式是不设 `EAC_COMPOSIO_BROKER_URL` 且不在打包版默认地址上启用 Cloud home；源码构建默认 broker URL 为空（`electron/managed-composio.mjs:4-11`）。

Admin 模型网关是对话正文接收方：`hosted-models.ts:80-93` 把 provider base URL 指到 `/api/gateway/<workspace>`；`managed-desktop.ts:58-77` 把企业桌面指到 `/api/desktop/gateway`。关闭方式是不要选择这些实例；选择本地/自带 key 的实例不会经过它们。

试用额度 relay 是对话正文接收方：`cloud-credit-provider.ts:43-49` 生成 `openai-compat` 实例，`apiKeyEnv` 只在子进程环境里。关闭方式是不配置 `EAC_CLOUD_AI_URL/TOKEN`，或不要选 `trial-credit` 模型。

用户自己的 Cloud 是 Cloud Files 和 Move 的接收方：`cloud-sync-paths.ts:9-11` 默认把同步根放在数据目录父级的 `Synced`，`cloud-send` 路由只在本机或 owner 的 Cloud 上工作。关闭方式是不共享文件夹、不执行 Move；这两条都没有后台定时器。

公告、更新检查是只读 GET，不是上传：`server/announcement-feed.ts:27,116-125` 和 `server/update-check.ts:11-20,108-120`。关闭方式是清空 `EAC_ANNOUNCEMENTS_URL` 和 `EAC_UPDATE_CHECK_URL`。

Tunnel 和 Tailscale 是入站暴露，不是数据上传：`server/tunnel.ts:255-290` 启动 cloudflared，`server/tailscale.ts:101-113` 发布 tailnet 端口。关闭方式是不执行相应 CLI；`EAC_TUNNEL_SOCKET` 只建本地 IPC，不会自动建公网隧道（`server/index.ts:15526-15535`）。

## 七、权限矩阵

| 角色 | 能控制什么 | 不能控制什么 | 证据 |
|---|---|---|---|
| Cloud home owner | 自己的 bots、自己的 lent 电脑、自己的 Cloud 设置和 Move | 其他 Team 的 bots、Team 的 lent 电脑（Team 不 lending） | `server/index.ts:702,936-938,950-955`；`server/cloud-team.ts:27-37` |
| Cloud home guest | 自己开的会话、自己发起的请求 | owner 的 lent 电脑、owner 的会话改写、全局设置 | `server/index.ts:910-955`；`server/routes/shared-computers.ts:63-65` |
| Team owner/admin | 团队规则、团队电脑、成员管理、Team Admin 摘要 | 成员自己的私人连接和私人电脑（Team 不 lending） | `server/cloud-team.ts:27-37`；`server/team-computers.ts:56-58`；`server/cloud-team-admin.ts:1-3` |
| Team member | 自己的会话、自己的 bot 可见范围 | Team 电脑、团队设置、全局 provider | `server/cloud-team.ts:27-37`；`server/index.ts:2853` |
| 共享电脑的 lender | 决定 folders、terminal、screen、internet、chrome 是否借出 | 不能借出未列出的 folder，不能绕过桌面端再次授权 | `server/shared-computers.ts:95-129`；`server/routes/shared-computers.ts:52-66` |
| 共享电脑的 borrower | 在授权范围内读/写/执行/看屏幕 | 不能跨电脑、跨 session、超过 900 秒命令上限 | `server/shared-computers.ts:37-59,360` |
| Boat 账号持有者 | 该账号下所有 sandbox 的列表、创建、删除、exec | 不能通过服务端前缀规则操作别家账号；但仍可在 boat.dev 直接操作 | `server/boat.ts:477-484,886-901` |
| VPS SSH 账号持有者 | 该 alias 指向的 Docker daemon 和容器 | 不能控制未在 SSH config 中配置的主机 | `server/vps-computer.ts:182-186`；`server/vps-ssh.ts:48-62` |
| Local VM 本机用户 | 本机 Docker/Podman、shared 容器的 6080 | 不能越过本机账号和容器 cap 限制 | `server/container-computer.ts:826-905` |
| Fleet operator | 创建/删除租户、用户、服务、写租户 key | 不能越过企业 admin entitlement 的 Web 路由 | `server/fleet-agent.ts:205-219`；`server/routes/status.ts:82-86` |

## 八、验证记录

本次实际使用的静态核验命令包括：`git rev-parse HEAD`、`git status --porcelain=v1`、`rg --files server`、`rg -n` 关键符号、`Get-Content` 逐段读取。以下抽查用于确认行号没有漂移：

- `server/index.ts:697` 仍是 `const CLOUD_HOME = cloudHomeConfiguration(CLOUD_ENV);`。
- `server/index.ts:785` 仍是 `const hostedModels = hostedModelPolicy(DATA_DIR);`。
- `server/index.ts:15437` 仍是 `console.log(describeEdition(await loadEnterpriseLayer()));`。
- `server/index.ts:15501` 仍是 `if (CLOUD_HOME) registerCloudPower(...)`。
- `server/index.ts:15509` 仍包含 `startCloudTeamPolicy` 和 `startCloudHomeConnectedApps`。
- `server/cloud-home.ts:69-87` 仍是 `cloudHomeConfiguration` 的校验主体。
- `server/cloud-secrets.ts:24-42` 仍是 `takeCloudSecrets` 的读取、关闭和 JSON 校验。
- `server/control-client.ts:60-65` 仍是 URL/token/configured 的赋值。
- `server/fleet-client.ts:10-12` 仍是默认 socket 路径。
- `server/hosted-contract.ts:2-14` 仍是版本常量、header 和兼容函数。
- `server/cloud-sync.ts:113-122` 仍是 `register` 的 `pcPath`、`computerName` 校验。
- `server/cloud-send-verify.ts:5,17-27` 仍明确写出 owner session 可离线猜弱密码，并对 password/TOTP 做 HMAC。
- `server/container-computer.ts:975` 自动创建使用 `randomBytes(6).toString("base64url")`；`:1219` 的 `CHANGE_ME` 只在 `setupCommands()` 手动展示命令里。
- `server/vps-computer.ts:182-186` 仍把 alias 拼成 `ssh://` Docker 端点。
- `server/fleet-agent.ts:205-219` 仍把 socket chmod 0660 并 chown 给 operator 组。

这些抽查只证明本文引用的行在当前工作树仍指向同一段代码，不证明运行时行为；没有编译、没有启动、没有网络请求。

## 九、范围内生产文件与启动关系

这张表只回答“这个文件在不在 `server/index.ts` 的启动图里、角色是什么”，不重复上面的机制结论。标注“启动图”表示被 `server/index.ts` 直接或间接 import；“独立入口”表示只被 CLI 或独立 supervisor 使用；“按需”表示模块被 import，但网络或容器动作要等到功能被调用。

| 文件 | 角色 | 启动关系 |
|---|---|---|
| `server/cloud-secrets-boot.ts:1-5` | 第一条 import，导入时读取 Cloud 密钥 | 启动图，同步执行 |
| `server/cloud-secrets.ts:6-42` | FD 读取、白名单、关闭 | 启动图，同步执行 |
| `server/cloud-home.ts:16-87` | Cloud home 配置、签名、配对 | 启动图，配置同步执行 |
| `server/cloud-home-start.ts:358-468` | Cloud 镜像 supervisor，Caddy/cloudflared | 独立入口 |
| `server/cloud-health.ts:268-317` | 健康报告 | 启动图，仅 Cloud 构造 |
| `server/cloud-power.ts:106-227` | 休眠握手和 5 秒 tick | 启动图，仅 Cloud 构造 |
| `server/cloud-connected-apps.ts:81-205` | Connected Apps 注册和重试 | 启动图，仅 Cloud 启动 |
| `server/cloud-credit-provider.ts:66-170` | 试用额度模型和实例 | 启动图，仅 Cloud 启动 |
| `server/cloud-sync.ts:33-280` | Files 同步服务 | 启动图，路由首次用才构造 |
| `server/cloud-sync-store.ts:93-264` | Files 索引、回收站 | 启动图，随 Cloud Sync |
| `server/cloud-send.ts:1-23` | Move 的比较摘要 | 启动图，路由挂载 |
| `server/cloud-send-chats.ts:1-5` | Move 的聊天行 | 启动图，路由挂载 |
| `server/cloud-send-files.ts:1-5` | Move 的 bot 文件 | 启动图，路由挂载 |
| `server/cloud-send-memory.ts:1-4` | Move 的记忆 | 启动图，路由挂载 |
| `server/cloud-send-verify.ts:1-5` | Move 的凭据指纹 | 启动图，路由挂载 |
| `server/cloud-connections-host.ts:46-107` | 连接搬迁和 handoff | 启动图，按需 |
| `server/cloud-team-policy.ts:131-298` | Team 规则拉取 | 启动图，仅 Team 启动 |
| `server/cloud-team-admin.ts:1-26` | Team Admin 摘要 | 启动图，仅 Team 路由 |
| `server/hosted-contract.ts:1-15` | hosted wire 版本 | 启动图，纯函数 |
| `server/hosted-models.ts:24-35` | 公司模型策略 | 启动图，配置同步执行 |
| `server/managed-desktop.ts:82-232` | 企业桌面 provider | 启动图，parent port 驱动 |
| `server/managed-policy.ts:71-182` | 企业/Team 策略 | 启动图，parent/Team 驱动 |
| `server/boat.ts:886-901` | Boat 账号和配置 | 启动图，按需 |
| `server/vps-computer.ts:822-879` | VPS 容器生命周期 | 启动图，按需 |
| `server/vps-ssh.ts:47-62` | VPS SSH 配置和 shim | 启动图，按需 |
| `server/container-computer.ts:826-905` | Local VM 容器 | 启动图，按需 |
| `server/shared-computers.ts:146-180` | 共享电脑注册和队列 | 启动图，按需 |
| `server/shared-computer-control.ts:17-61` | 屏幕互斥租约 | 启动图，按需 |
| `server/computer-control.ts:39-130` | 人机控制状态 | 启动图，按需 |
| `server/places-elsewhere.ts:74-124` | 其他 place 的名字元数据 | 启动图，按需 |
| `server/tunnel.ts:128-290` | 伴侣 tunnel 账户和 cloudflared | 独立入口 |
| `server/tailscale.ts:84-113` | tailscale 状态和 serve | 独立入口 |
| `server/fleet-agent.ts:76-221` | root fleet agent | 独立入口 |
| `server/fleet.ts:235-385` | Fleet 计划和租户 env | 独立入口 |
| `server/local-vm-settings.ts:4-27` | Local VM 默认值 | 启动图，纯配置 |

从这张表可以确认：范围内的 35 个生产文件中，真正进入主服务启动图的是 30 个，独立入口是 5 个；独立入口不会因为主服务启动而运行，主服务也不会因为独立入口没有配置而失败。这个“文件存在但不在启动链”的区分，是判断“硬依赖”与“可选功能”的关键。

## 十、统计

总条数：95。  
按建议分类：保留 43 条，改可配置 22 条，删除 21 条，默认关闭 9 条。  
按技术限制/商业许可分类：技术限制 75 条，商业许可 20 条。

## 十一、风险 Top 10

1. **C37 / L03，Local VM 手动 setup 展示命令使用固定 CHANGE_ME。** 自动创建路径使用 `randomBytes(6).toString("base64url")`（`server/container-computer.ts:973-975`），不是可预测默认值；固定 `CHANGE_ME` 只在 `setupCommands()` 的手动安装展示命令里（`:1177-1219`），函数签名默认参数也是 `CHANGE_ME`（`:825-827`）。真实风险是用户复制展示命令创建容器，或旧容器由人工按旧命令创建；自动路径不承担这条风险。建议：展示命令不要输出固定密码，改为生成随机密码的占位命令或要求用户先设置密码；旧容器创建时检测并提示更换。
2. **A10 / C38，VPS alias 等于远端 Docker daemon 权限。** `-H ssh://alias` 使用用户自己的 SSH 配置，代码不限制 alias 指向的主机或账号；如果 alias 是 root 或 Docker 组，容器外的宿主也受控。证据：`server/vps-computer.ts:182-186`、`server/vps-ssh.ts:48-62`。建议：增加 host/用户 allowlist 与显式确认；默认关闭 VPS 目的地。
3. **C28 / C27，Boat 云电脑可执行完整 shell 和双向文件复制。** 云电脑工具提供 `exec`、`copy_from_computer`、`copy_to_computer`，文件上限 2 GiB；这会把用户文件、命令和屏幕内容送到 Boat sandbox。证据：`server/cloud-computer-tools.ts:17-43`、`server/cloud-computer-files.ts:75-100`。建议：默认不挂载 Cloud computer；首次使用明确提示数据去向和计费。
4. **C23，Move 凭据指纹可被离线猜测。** `cloud-send-verify.ts:5` 自己注明：持有 owner session 的人可以拿指纹离线猜弱密码；`loginFingerprints` 对密码和 TOTP 做 HMAC。证据：`server/cloud-send-verify.ts:1-5,17-27`。建议：Move 验证改为一次性、短期、目标端生成的 challenge，或至少禁止对弱密码做可重复指纹。
5. **C08 / C09，Cloud home 启动即向厂商 broker 注册。** 首次 `POST /v1/installations`，之后 `PUT /v1/installation/cloud`；失败会持续退避重试，默认地址是 `eacbot-composio.milindsoni201.workers.dev`（打包版）。证据：`server/cloud-connected-apps.ts:20,114-168`、`electron/managed-composio.mjs:4,76-91`。建议：改为首次打开 Connected Apps 时注册，并提供关闭开关。
6. **C11 / C12，托管模型和试用额度会把对话正文发到 Admin 或 relay。** 这不是隐藏后门，但用户可能只看到“模型名称”，不知道内容经过厂商网关；证据：`server/hosted-models.ts:80-93`、`server/cloud-credit-provider.ts:43-49`、`server/drivers/openai-chat.ts:297`。建议：在模型选择器旁显示“内容会发送到 <gateway>”，并把“仅本地模型”作为明确选项。
7. **L09 / C44，`EAC_CONTROL_*` 缺失会静默关闭“谁在操作电脑”的拦截。** 没有 URL 或 token 时 `configured=false` 且返回 DISENGAGED，电脑调用不被 gate 拦截；这不会让服务起不来，但会让人机互斥失效。证据：`server/control-client.ts:60-65,96-103`、`server/mcp-bridge.ts:333-335`。建议：在 Cloud/VPS 电脑上把 gate 设为必需；缺失时 fail-closed，而不是 DISENGAGED。
8. **C34 / C35，Fleet root agent 的权限远高于普通 Web 服务。** 它能创建 OS 用户、systemd 服务、写租户 key；socket 只靠 0660 和 operator 组保护。证据：`server/fleet-agent.ts:205-219`、`server/fleet.ts:235-242,385`。建议：保留，但把 Fleet 明确标为“仅受信运维主机”；默认不安装、不启用。
9. **C30，Team admin 摘要暴露人员邮箱和账号身份。** 摘要包含连接器账号 id/别名、MCP host、密钥是否配置、引擎账号 email/organization；虽然不含 key，但对 Admin 侧是身份元数据。证据：`server/cloud-team-admin.ts:1-3,14,20,41-67`。建议：按最小必要字段返回；默认隐藏 email，只在明确请求时显示。
10. **C06 / Q03，Cloud home 的休眠依赖 Admin 轮询，且本地计划缓存可被旧文件影响。** `cloud-plan-tier.json` 决定 Starter；没有文件就非 Starter，旧文件不会被签名重新验证，只能由下一次签名 POST 覆盖。证据：`server/host/cloud-plan-tier.ts:20-43`、`server/routes/cloud-signed.ts:126-140`。建议：启动时只接受带时间戳的短期缓存；过期后回到非 Starter，并让 Admin 重新下发。

## 六、未决问题与证据缺口

1. 依赖已由其它小组安装，但本报告仍未运行 typecheck、构建、测试或服务；所有“会/不会”都来自静态分支，不是运行验证。`server/update-check.ts` 等文件还有主线程未提交修改，行号可能随并行编辑漂移。
2. `enterprise/` 是独立许可代码，本文只核对了 `server/enterprise.ts` 和 `enterprise/server/workspace-access.ts` 的关键路径；没有逐行审计整个 enterprise 层，也没有核实 Admin 服务端的实际响应。
3. `models.dev` 目录抓取在当前 `server/` 中没有找到 import；我把它标为“代码存在、未接入”的候选，不能断言启动时会联网。若后续主线程找到调用点，应把 C18 改为实际外连条目并补触发链。
4. `cloud-sync` 的 `computerName` 是否等于桌面主机名，由 Electron 端决定；服务端只验证它是 1 到 200 字符的字符串（`server/cloud-sync.ts:113-120`）。01 的“主机名”应改为“桌面提供的 computerName，通常是主机名”。
5. Boat 的 `boat.dev` API 语义、included relay 的实际账号归属、VPS 的 SSH 配置和 Docker daemon 权限都在仓库外；本文只能确认代码如何调用，不能确认某台机器的实际权限。
6. `cloud-home-start` 的 Caddy 配置、cloudflared token 和 Fly 边缘行为没有在仓库内完整展开；C31 只能证明 supervisor 会在有 token 时启动 tunnel。
7. Fleet 的 root 操作、systemd 单元和租户隔离没有实际运行；C34/C35 的结论来自代码和 socket 权限，不是实机验证。
8. Cloud Admin、Boat、Connected Apps broker、Team Admin 的实际响应和保留策略不在本仓库；C04/C07/C08/C30 的“发什么”以本地构造的请求体和注释为准，未做网络抓包。
9. 没有审计 Electron 桌面端的完整 Cloud Files、Move、Cloud 登录和心跳实现；01 已覆盖主要路径，本文只在服务端边界引用它们。桌面端是否在 UI 中明确提示“上传路径和文件”，需要前端/Electron 组另行确认。

本次只读，未修改源码、配置、依赖，未执行 git add/commit/push，未触碰 `D:\workspace\EACbot` 原件。04 的 cloud 文件未被主线程改动，行号按当前工作树；merge 前按符号复核。
