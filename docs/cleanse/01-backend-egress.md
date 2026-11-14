# 01 后端外连与远程控制审计（初版）

采集时间：2026-11-14  
修订：2026-11-14（`@devs` 报告只认 `EAC_BUG_REPORT_URL`，不再回退 `EAC_CLOUD_ADMIN_URL`）  
仓库：`D:\workspace\EACbot-clean-core`  
分支：`codex/clean-core`  
基线：`781c57e`  
范围：`server/`、`shared/`、`electron/` 的非测试文件（排除 `*.test.ts`、`*.node-test.mjs`、`testing/`）。  

> **状态说明：这是可用的初版，不是全量终稿。** 已确认的后台外连、更新检查、遥测、远程控制和用户内容外发点已写入下表；未逐行展开的部分在文末「待补」中列出。采集期间工作树有并行改动（`server/update-check.ts`、`server/routes/update-check.ts`、`server/devs-report-send.ts` 等），本文按**当前工作树**记录；其中 update-check 与 bug-report 的默认公网地址已被并行改动改为默认关闭。

## 一、先给结论

1. **真正会自动发生的外连只有四类**：打包桌面端的自动更新检查与静默安装、打包桌面端启动时的账户/控制面健康检查、已注册的 Connected Apps 注册，以及服务端启动 2 分钟后开始的引擎自动更新。其余大多是用户点了某个功能、配置了某个 key，或在 Cloud/Team 模式下才会发生。
2. **会把用户内容发出去的地方是明确的**：模型回合把对话正文发给所选 provider；Cloud Files 同步把共享文件夹的**完整本地路径、主机名和文件内容**发给 My Cloud；Move/Send 把工作区、聊天和附件上传到 My Cloud；`@devs` 报告把用户原话、机器人摘要、近期日志和运行信息发给配置的端点；decider 把群聊近文和邮件正文发给分类模型。
3. **默认公网地址已经明显减少**：服务端自带更新检查已改为只有 `EAC_UPDATE_CHECK_URL` 才请求（`server/update-check.ts:9-24`）；`@devs` 报告已改为只在设置 `EAC_BUG_REPORT_URL` 时发送，未设置或地址无效就完全不发，不再回退 Cloud Admin 或内置公网地址（`server/devs-report-send.ts:27-37`）。
4. **仍有一个服务端隐藏默认值**：`server/account-signin.ts:60-66` 调用 `resolveCompanionControlPlaneURL({ isPackaged: true })`，因此在自建服务器上只要配置了邮箱登录白名单，未设 `EAC_CONTROL_PLANE_URL` 也会默认走 `https://accounts.eacbot.com`。这是本轮最值得先改的“默认依赖厂商”之一。
5. **自动更新会覆盖本地安装文件**：打包桌面端通过 `electron-updater` 从 GitHub Releases 下载并安装，Windows/macOS 还会在安静时自动安装（`electron/update-when-quiet.mjs:1-4`、`electron/updater.mjs:182-185`）。它会替换应用自身的 `Resources` 文件；不会改动源码 checkout，但会覆盖安装目录里的本地改动。

## 二、外连清单

“是否需要配置才触发”一列：**否** 表示默认安装/默认启动就可能发生；**是** 表示需要环境变量、账号、key、Cloud/Team 模式或用户操作。

| 编号 | 文件:行 | 触发条件 | 发往哪里 | 发什么数据 | 是否需要配置才触发 | 性质 | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | `electron/updater.mjs:189-190`；`electron-builder.yml:16-19` | 打包桌面端启动 15 秒后，之后每小时 | GitHub Releases（`provider: github`，`Ebony-Vinyl/EACbot`） | GET `latest.yml`/`latest-mac.yml`；无用户数据；有新版本时下载安装包 | 否（仅打包版；源码运行不启用） | 更新检查/自动更新 | 保留，但加“检查更新”开关；默认只检查不下载 |
| 2 | `electron/update-when-quiet.mjs:1-4,71`；`electron/updater.mjs:182-185`；`electron/updater-coordinator.mjs:256` | 已下载更新，且 Windows/macOS 判定用户离开、应用空闲 | 本机安装目录（安装包来自 GitHub） | 执行 `quitAndInstall`/静默 NSIS，替换应用文件并重启 | 否（仅打包版） | 自动更新 | 默认关闭静默安装；至少提供“仅提示、不自动装” |
| 3 | `electron/main.mjs:3129`；`electron/companion-account-service.mjs:18,74-82,325-348` | 打包桌面端启动，创建了 companion account service | `https://accounts.eacbot.com`（未设 `EAC_CONTROL_PLANE_URL` 时） | GET `/healthz`；无账号内容；后续登录才带邮箱/OTP | 否（仅打包版；开发版默认空） | 远程控制/产品功能 | 未启用伴侣/远程访问时不要探测；默认关闭 |
| 4 | `electron/main.mjs:3134-3143`；`electron/managed-composio.mjs:4,72-100` | 打包桌面端启动，且未启用桌面远程访问 | `https://eacbot-composio.milindsoni201.workers.dev` | POST `/v1/installations`，body 为 `{}`；拿回 installation token；已有 token 时 GET `/v1/me` | 否（仅打包版；源码默认空） | 产品功能 | 改为按需注册（首次打开 Connected Apps 时），并提供关闭开关 |
| 5 | `server/update-check.ts:9-24,107-120`；`server/routes/update-check.ts:22-28` | 客户端请求 `GET /api/updates/check` | `EAC_UPDATE_CHECK_URL` 指定的地址 | GET；只读 release JSON；无用户数据 | 是（未设该变量则完全不请求） | 更新检查 | 保留“默认关闭、显式配置才检查” |
| 6 | `server/announcement-feed.ts:49-52,117-124`；`server/index.ts:12493` | 服务启动约 1 秒后，之后每 10 分钟 | `EAC_ANNOUNCEMENTS_URL` 指定的地址 | GET；只读公告 JSON；无用户数据 | 是（未设该变量则完全不请求） | 产品功能（公告） | 保留默认关闭；若启用，固定 HTTPS 并校验内容 |
| 7 | `server/devs-report-send.ts:27-37,61-90`；`server/host/devs-reports.ts:56-57,422-425,474-475` | 用户在聊天里写 `@devs`，且配置了 `EAC_BUG_REPORT_URL` | `EAC_BUG_REPORT_URL` 指定的报告端点；未设置或地址无效则完全不发（不再回退 Cloud home 的 `EAC_CLOUD_ADMIN_URL`，也没有内置公网默认值） | POST 用户原话与机器人摘要（各有限长）、应用/系统/Node 版本、运行时长、线程/消息 ID、群 ID、机器人/模型/实例名、近期问题与服务日志（已脱敏） | 是（需要 `@devs` 且需要端点） | 产品功能/遥测 | 保持“默认关闭”；发送前显示将发送的字段摘要并征得同意 |
| 8 | `server/devs-report-send.ts:122-145`；`server/host/devs-reports.ts:56-57,422-425` | 已成功发送过 `@devs` 报告，之后每小时 | 由 `EAC_BUG_REPORT_URL` 所在 origin 派生的 `/api/bug-reports/status` | POST `installId` 与该安装的报告 ID 列表 | 是（先有报告且端点可用） | 产品功能/遥测 | 与第 7 条同开关；报告关闭时状态询问也必须关闭 |
| 9 | `server/cloud-team-policy.ts:21,26,176-190,227` | Team Cloud 启动、每 5 分钟、或 Admin 通知变更时 | `EAC_CLOUD_ADMIN_URL` + `/api/cloud/machines/team-policy` | POST 当前策略 fingerprint/version、无法应用的原因；带 machine id、时间戳、nonce、HMAC 签名 | 是（需要 `EAC_CLOUD_ROLE=team` 等 Cloud 变量） | 远程控制 | 保留（企业/团队功能）；文档明确“只能收紧，不能放宽” |
| 10 | `server/managed-policy.ts:5-30,83-95,100-150` | 桌面父进程推送策略，或 Team Cloud 从 Admin 取到策略 | 内存中的策略，不直接外连 | 可远程禁止引擎、MCP、电脑、远程访问；可要求“策略必须新鲜”，否则拒绝新回合 | 是（企业桌面或 Team Cloud） | 远程控制 | 保留，但在 UI 明示当前策略来源与有效期 |
| 11 | `server/cloud-connected-apps.ts:20,114-130,196-205` | Cloud home 启动，且配置了 broker 地址 | Connected Apps broker（`EAC_COMPOSIO_BROKER_URL` 或打包默认 workers.dev） | PUT `/v1/installation/cloud`，body 只有 `grant`（`EAC_CLOUD_CONNECTED_APPS_GRANT`） | 是（Cloud home） | 产品功能 | 保留；grant 不写日志 |
| 12 | `server/cloud-credit-provider.ts:22,101-126` | Cloud home 有试用额度，启动或重试时 | 试用额度 relay 的 `/models` | GET，带 `Authorization: Bearer`；无对话内容 | 是（Cloud home + `EAC_CLOUD_AI_URL/TOKEN`） | 产品功能 | 保留；只列模型，不发送用户内容 |
| 13 | `electron/cloud-account.mjs:10-18,155-180,360-375` | 用户登录 My Cloud、恢复已保存登录、刷新授权 | `https://cloud.eacbot.com`（`EAC_CLOUD_STAGING=1` 时 staging） | 设备码/邮箱、设备名、应用版本、授权 token；换取 Cloud 会话 | 是（用户登录或已有保存的授权） | 产品功能 | 保留；默认生产地址，staging 仅显式开关 |
| 14 | `electron/managed-desktop.mjs:250-251,330,379` | 企业桌面已注册到管理门户，续期或策略版本变化 | 管理门户 `portalOrigin` | POST `/api/desktop/session/renew`、`/api/desktop/heartbeat`；只发平台、应用版本、策略版本 | 是（企业注册） | 遥测/远程控制 | 保留；在设置中显示“已注册到哪个组织” |
| 15 | `electron/move-status.mjs:1-20,120-150` | 已登录 Cloud，搬迁状态变化或每 15 分钟 | Cloud Admin 的 `/api/cloud/desktop/move-status` | 应用版本、搬迁阶段/原因、失败代码与安全化后的错误句、Cloud 状态；不含文件名/路径/聊天 | 是（Cloud 登录） | 遥测 | 改为按需/可关闭；至少让用户知道在上报 |
| 16 | `electron/cloud-sync.mjs:1-4,207,227`；`electron/cloud-sync-client.mjs:53,72-105` | 用户把文件夹加入 My Cloud Files，且 Cloud 在线 | My Cloud 的 `/api/sync/*` | **完整本地路径 `pcPath`、主机名、文件相对路径、文件内容、sha256**；下载云端产物 | 是（用户主动共享文件夹） | 产品功能 | 保留；首次共享明确展示“路径和文件会上传”，并提供排除规则 |
| 17 | `electron/cloud-send.mjs:330-360,532-540` | 用户执行 Move to My Cloud / Send to Cloud | My Cloud | 工作区文件、聊天记录、附件、可刷新登录凭据（最终 pass）；文件清单与内容 | 是（用户主动执行） | 产品功能 | 保留；执行前列出范围并二次确认 |
| 18 | `server/pages/client.ts:75,111-120` | 机器人调用发布 Pages 工具，且账户有 Pages 权限 | Pages 服务（`access.url`，来自 Cloud 签发的 token） | POST 页面 HTML/文件、标题；换取 pageId/URL | 是（需要 Pages 访问权与工具调用） | 产品功能 | 保留；发布前在聊天中显示“将公开这些文件” |
| 19 | `server/decider/room-routing.ts:80-100`；`server/decider/index.ts:46-73`；`server/decider/jev.ts:8`；`server/decider/openrouter.ts:7`；`server/decider/workers-ai.ts:10` | 配置了 decider key，或 Cloud 带 included relay；房间路由/收件箱分类任务默认开启 | Jev `https://api.typesafe.ai`、OpenRouter `https://openrouter.ai/api/v1`、Cloudflare Workers AI `https://api.cloudflare.com/client/v4`，或 Cloud relay | 房间名、参与者名、最近消息（最多 6000 字符）、新消息（最多 8000 字符）；收件箱分类还会发邮件正文（上限 200k 字符） | 是（需要 key/relay；任务默认 on） | 产品功能 | 改可配置并默认关闭；至少单独开关“把聊天/邮件发给分类模型” |
| 20 | `server/plan-usage.ts:124-130,978-1038` | 使用 Claude/Codex/Grok/OpenCode 计划账号，且限额监控在等待 | `api.anthropic.com`、`chatgpt.com`、`cli-chat-proxy.grok.com`、`opencode.ai` | GET 用量；带账号 OAuth token/账号 ID；不发送对话正文 | 是（使用这些引擎） | 产品功能/遥测 | 改可配置；默认只在打开用量页时查询，不做后台轮询 |
| 21 | `server/drivers/openai-chat.ts:251,297-301` | 每一次模型回合 | 实例配置的 provider base URL | 对话正文/附件/工具结果 + `Authorization: Bearer <apiKey>`；回合中还会轮询 `/models` 做存活检查 | 是（配置模型） | 产品功能 | 保留（核心功能）；UI 明示“内容会发给该 provider” |
| 22 | `server/provider-key-check.ts:12-21,71` | 用户在设置里点“测试密钥” | 对应 provider 的固定地址 | 发送 API key 做校验；不发送对话 | 是（用户操作） | 产品功能 | 保留；按钮旁提示“密钥会发给该服务商” |
| 23 | `server/composio.ts:199`；`server/composio-session.ts:99,134`；`server/composio-project.ts:18-21` | 使用 Connected Apps；有项目 key 或 Cloud broker token | `https://backend.composio.dev` 或 broker URL | 创建/更新 Tool Router Session、工具调用参数与结果；可能含用户内容 | 是（配置 Connected Apps） | 产品功能 | 保留；按 app 显示数据去向，默认不开启 |
| 24 | `server/mcp-http.ts:428-460`；`server/mcp-registry.ts:125-131` | 用户添加远程 MCP server，机器人调用其工具 | 用户填写的任意 http(s) MCP 地址 | MCP 请求/工具参数与结果；可能含用户内容 | 是（用户添加 MCP） | 产品功能 | 保留；默认只允许 HTTPS，新增服务器需明确确认 |
| 25 | `server/x-research.ts:405-438` | 机器人使用 X research 工具 | `https://treg.to` 或 Cloud X relay | POST 搜索词、账号 handle、帖子 ID；带 treg key 或 relay token | 是（需要 X research key/plan） | 产品功能 | 保留；在工具说明中写明查询会发给 treg |
| 26 | `server/email/discover.ts:105-150` | 用户添加邮箱账号，自动发现服务器 | `autoconfig.<domain>`、`<domain>/.well-known`、`autoconfig.thunderbird.net` | 邮箱域名会发给 Thunderbird 公共自动配置服务；不带密码 | 是（用户添加邮箱） | 产品功能 | 改可配置；提供“只用手填服务器”的选项 |
| 27 | `server/headless/host-doctor.ts:291-299` | 用户运行 `eacbot doctor --host` | `https://cloud.eacbot.com` | HEAD 请求读取 `Date` 头，用于校时；无用户数据 | 是（用户命令） | 诊断 | 改为可配置的时间源，或仅在用户同意时联网 |
| 28 | `server/custom-domain.ts:110-130` | 用户设置自定义域名并点验证 | 用户填写的域名 | HTTPS GET `/.well-known/eacbot/environment`；只带固定 User-Agent | 是（用户操作） | 产品功能 | 保留；这是验证域名归属所必需 |
| 29 | `server/engine-updates.ts:21-23,152-160,350-360`；`server/index.ts:15511` | 服务启动 2 分钟后，之后每 24 小时；无 UI 开关 | npm registry / GitHub Releases（按引擎的安装来源） | 下载并替换**应用自己安装的**引擎副本；不碰用户自己装的引擎 | 否（服务启动即会检查） | 自动更新 | 默认关闭或提供“自动更新引擎”开关；至少允许固定版本 |
| 30 | `server/desktop-updates.ts:1-10`；`server/container-computer.ts:26-29,107-111` | 应用更新后，Local VM 镜像不匹配；或首次准备 Local VM | Docker Hub `trycua/xfce-cua`（固定 digest）、GitHub/PyPI 组件 | 拉取镜像/组件并重建容器；保留持久文件夹与网站登录 | 是（使用 Local VM） | 自动更新 | 保留，但重建前明确提示；提供“暂不更新” |
| 31 | `server/skill-fetch.ts:8,112,322`；`server/team-library.ts:6-7,238-255`；`server/plugins/default-channel.ts:7`；`server/host/plugins-host.ts:57-58` | 用户安装 skill/team 模板/插件，或打开插件市场 | `api.github.com`、`raw.githubusercontent.com`、插件 catalog | GET 下载内容；不上传用户数据；插件 catalog 有签名校验 | 是（用户操作） | 产品功能 | 保留；skill/team 下载加来源提示与固定 commit |
| 32 | `server/account-signin.ts:60-66` | 服务器配置了邮箱登录白名单，用户请求登录 | 未设 `EAC_CONTROL_PLANE_URL` 时默认 `https://accounts.eacbot.com` | POST 邮箱请求 OTP/校验 OTP；带邮箱、验证码；成功后本地建会话 | 是（需要白名单与登录操作） | 产品功能/远程控制 | **改可配置，默认空**；自建服务器不应默认连厂商账户服务 |
| 33 | `server/tunnel.ts:1-12`；`electron/managed-companion-tunnel.mjs` | 启动 `eacbot serve --tunnel`，或桌面开启伴侣远程访问 | 控制面 + Cloudflare tunnel | 建立公网入口；本地 API 可被配对设备访问；隧道 token 发往 Cloudflare | 是（显式 `--tunnel`/远程访问） | 远程控制 | 保留显式 opt-in；默认关闭并在 UI 显示公网地址 |
| 34 | `server/live-call.ts:7,56-58` | 用户开始实时语音通话 | `https://api.openai.com`（或仅 loopback 的覆盖地址） | 音频/文本与 API key | 是（用户开始通话 + OpenAI key） | 产品功能 | 保留；通话前提示第三方处理 |
| 35 | `server/tts/fish.ts:5`；`server/tts/gemini.ts:5`；`server/tts/grok.ts:4`；`server/image-generation.ts` | 用户使用朗读/生成图片 | Fish/Gemini/xAI/OpenAI/OpenRouter/自定义图片服务 | 待朗读文本、图片提示词、API key | 是（配置对应 key 并使用） | 产品功能 | 保留；按 provider 显示数据去向 |
| 36 | `server/bot-directory.ts:92-99` | 用户在建 bot 时使用“从目录找 bot” | `https://api.botdirectory.ai/api/bots` | GET 目录；不上传项目内容；请求只带固定 accept | 是（用户操作） | 产品功能 | 保留；可改为打包快照，减少外连 |
| 37 | `server/email/client.ts:333` | 用户让 bot 发邮件 | 用户配置的 SMTP 服务器 | 邮件正文、收件人、附件；使用用户自己的 SMTP 凭据 | 是（用户发邮件） | 产品功能 | 保留；这是邮件功能本身 |

### 计数（初版）

- **总数：37 条。**
- 按“性质”主标签计数（一条只计一次）：**产品功能 25、远程控制 4、自动更新 3、更新检查 2、遥测 2、诊断 1。**
- 带双重性质的行：第 3、7、8、14、20、32 条同时含“产品功能/遥测/远程控制”中的两个标签。
- 其中“默认安装/默认启动就可能发生”的条目：第 1、2、3、4、29 条，共 5 条；其余都需要配置、账号或用户操作。

## 三、环境变量逐个说明（与本次外连相关）

| 变量 | 默认值 | 作用与是否会外连 | 证据 |
|---|---|---|---|
| `EAC_UPDATE_CHECK_URL` | 空（不检查） | 服务端更新检查的唯一地址；空则 `GET /api/updates/check` 返回 `checked:false`，不发请求 | `server/update-check.ts:9-24,107-120` |
| `EAC_ANNOUNCEMENTS_URL` | 空（不拉取） | 公告 feed 地址；空则定时器直接返回，不发请求 | `server/announcement-feed.ts:49-52,117-124`；`server/index.ts:12493` |
| `EAC_BUG_REPORT_URL` | 空（不发送） | `@devs` 报告及其状态询问的唯一地址；必须是 https，或本机 loopback http；空或无效时报告功能关闭，不发报告请求 | `server/devs-report-send.ts:27-37,78-79` |
| `EAC_CONTROL_PLANE_URL` | 打包桌面端 `https://accounts.eacbot.com`；开发版空；自建服务器因 `isPackaged:true` 也默认该地址 | 账户 OTP、安装注册、伴侣端点、健康检查 | `electron/companion-account-service.mjs:18,74-82`；`server/account-signin.ts:60-66` |
| `EAC_CONTROL_URL` | 空 | 本机/云电脑“谁在操作”门禁；只在配置了本地控制边车时使用；`local-computer-proxy` 只接受 loopback | `server/control-client.ts:60`；`server/local-computer-proxy.ts:15-30` |
| `EAC_CLOUD_ROLE` | 未设置（非 Cloud home） | `home`/`team` 才进入 Cloud home 模式；设置后必须同时有 machine id、admin URL、bootstrap secret | `server/cloud-home.ts:17,74-86` |
| `EAC_CLOUD_MACHINE_ID` | 无默认，Cloud 模式必填 | Admin 分配的机器 id；用于签名请求 | `server/cloud-home.ts:17,77-78` |
| `EAC_CLOUD_ADMIN_URL` | 无默认，Cloud 模式必填 | Cloud Admin 的 https origin；Team 策略同步和 Pages 访问令牌请求发往这里，团队连接页链接也由它拼出；`@devs` 报告和状态询问不经过它，只认 `EAC_BUG_REPORT_URL` | `server/cloud-home.ts:17,79`；`server/cloud-team-policy.ts:181`；`server/pages/access.ts:72-73`；`server/host/team-connections-host.ts:102` |
| `EAC_CLOUD_BOOTSTRAP_SECRET` | 无默认，Cloud 模式必填 | 与 Admin 共享的 HMAC 密钥；只用于签名，不写入日志 | `server/cloud-home.ts:17,81-82` |
| `EAC_CLOUD_BOAT_URL` / `_TOKEN` | 均无默认；两者都设置才生效 | Boat relay 地址与 token；只发给该 relay | `server/included-services.ts:38` |
| `EAC_CLOUD_VOICE_URL` / `_TOKEN` | 均无默认；两者都设置才生效 | ElevenLabs relay；只发给该 relay | `server/included-services.ts:39` |
| `EAC_CLOUD_DECIDER_URL` / `_TOKEN` | 均无默认；两者都设置才生效 | Jev relay；只发给该 relay | `server/included-services.ts:40` |
| `EAC_CLOUD_AI_URL` / `_TOKEN` | 均无默认；token 必须匹配 `omb_ai_...` | 试用额度 relay；只发给该 relay | `server/included-services.ts:41,51-63` |
| `EAC_CLOUD_X_URL` / `_TOKEN` | 均无默认；两者都设置才生效 | X research relay；只发给该 relay | `server/included-services.ts:42` |
| `EAC_CLOUD_CONNECTED_APPS_GRANT` | 空 | Cloud 计划凭证；PUT 给 Connected Apps broker，只作为 grant | `server/cloud-connected-apps.ts:38,114-130` |
| `EAC_CLOUD_STAGING` | 未设置 | `1` 时桌面端改用 `https://omb-cloud-staging.fly.dev`；不影响服务端 update-check（已改为显式 URL） | `electron/cloud-account.mjs:11-18` |
| `EAC_COMPOSIO_BROKER_URL` | 打包版 `https://eacbot-composio.milindsoni201.workers.dev`；源码空 | Connected Apps broker；空则不注册 | `electron/managed-composio.mjs:4,7-11` |
| `EAC_TREG_URL` | `https://treg.to` | 自带 treg key 时的 X research 地址；只接受 https 或 loopback | `server/included-services.ts:134-143` |
| `EAC_SIGNIN_SMTP_URL` | 空 | 设置了就走服务器自己的 SMTP，不再走控制面 OTP | `server/account-signin.ts:50-57` |
| `EAC_ADMIN_URL` / `EAC_ADMIN_WORKSPACE` / `EAC_ADMIN_MEMBERSHIP` | 均无默认；任一存在即进入 hosted workspace 校验 | 托管工作区的 Admin 地址；企业层可能据此做鉴权请求 | `server/enterprise.ts:71-87` |
| `EAC_HARNESS_URL` | `http://127.0.0.1:8799` | 内部 harness；不是公网 | `server/connector-proxy.ts:26`；`server/drivers/agents-client.ts:56` |
| `EAC_OPENAI_LIVE_URL` | `https://api.openai.com` | 只接受 `http://127.0.0.1:<port>` 覆盖；否则固定 OpenAI | `server/live-call.ts:7,56-58` |
| `EAC_POSTIZ_CLOUD_URL` | `https://api.postiz.com` | Postiz Cloud；用户配置 Postiz 后使用 | `shared/postiz.ts:8`；`server/postiz/connection.ts:40-48` |
| `EAC_ANTHROPIC_API_URL` | 空（用驱动内置默认） | 覆盖 Anthropic API 地址；只在配置 Anthropic key 时使用 | `server/config.ts:758-761` |

## 四、自动更新会不会覆盖本地改动

**会，但要分三层看。**

1. **桌面应用自身**：打包版的 `electron-updater` 从 GitHub Releases 读取 `latest.yml`/`latest-mac.yml`，下载安装包；Windows/macOS 在“无人使用”时自动安装并重启（`electron/updater.mjs:189-190`、`electron/update-when-quiet.mjs:1-4,71`、`electron/updater-coordinator.mjs:256`）。它会替换安装目录里的 `app.asar`/`Resources`，因此**安装目录内的本地改动会被覆盖**。源码 checkout 不会被动，因为 `startUpdater` 在 `!app.isPackaged` 时直接返回（`electron/updater.mjs:153-158`）。
2. **应用自己安装的 AI 引擎副本**：服务启动 2 分钟后、之后每天检查，并替换 `DATA_DIR/providers/...` 下由应用安装的引擎副本；用户自己安装的引擎（不在应用管理目录）不会被碰（`server/engine-updates.ts:21-23,152-160`、`server/index.ts:15511`）。如果用户手动改过这些副本，会被覆盖。
3. **Local VM 镜像**：应用更新后若镜像 digest 不匹配，会自动重建容器；文档声称保留持久文件夹与网站登录（`server/desktop-updates.ts:1-10`、`server/container-computer.ts:26-29`）。容器内其他改动可能丢失，需要在 UI 明确提示。

## 五、最该马上处理的 5 条

1. **`server/account-signin.ts:60-66` 的隐藏默认控制面**：自建服务器在只配置邮箱白名单时，会把登录请求默认发到 `accounts.eacbot.com`。改为“`EAC_CONTROL_PLANE_URL` 未设置则邮箱登录不可用”，或至少要求显式 `EAC_CONTROL_PLANE_URL`。
2. **打包桌面端启动即探测 `accounts.eacbot.com/healthz`**（`electron/main.mjs:3129`、`electron/companion-account-service.mjs:325-348`）：未使用伴侣/远程访问的用户也会被外连。改为只在启用相关功能后探测。
3. **打包桌面端启动即注册 Connected Apps**（`electron/main.mjs:3134-3143`、`electron/managed-composio.mjs:4,72-100`）：改为首次使用 Connected Apps 时注册，并提供关闭开关。
4. **`@devs` 报告的默认关闭要守住**（`server/devs-report-send.ts:27-37,78-79`）：当前已是“无端点不发”，但还要确保 UI 不把“报告已发送”说成默认能力；发送前展示字段摘要。
5. **自动更新必须可关**（`electron/updater.mjs:189-190`、`electron/update-when-quiet.mjs:1-4`、`server/engine-updates.ts:21-23`）：桌面静默安装和应用自装引擎更新都会替换本地文件；至少提供“只检查/不自动安装”和“固定引擎版本”。

## 六、覆盖范围与未覆盖范围

**已覆盖（已逐项确认并有文件:行证据）**

- 桌面自动更新检查与静默安装；
- 桌面启动时的控制面健康检查、Connected Apps 注册；
- 服务端更新检查、公告 feed、`@devs` 报告与状态询问；
- Cloud/Team 模式下的 Team 策略、Connected Apps grant、试用额度模型列表；
- 桌面 Cloud 登录、企业心跳、搬迁状态、Cloud Files 同步、Move/Send；
- Pages 发布、decider/room routing/inbox triage、计划用量轮询；
- 模型回合、密钥测试、Composio、MCP、X research、邮箱自动发现、`doctor --host`、自定义域名验证；
- 引擎自动更新、Local VM 自动更新、skill/team/plugin 内容下载、`--tunnel` 远程访问、实时语音/TTS/图片生成、邮件发送。

**未覆盖 / 待补（下一版必须补）**

- `server/browser/**` 中浏览器自身的出站请求（bot 访问网站、表单提交、下载）；本文只覆盖了浏览器运行时下载，没有逐项审计“bot 在网页里输入/提交什么”。
- `server/drivers/**` 下每个 ACP/CLI 引擎的具体外连行为（Claude Code、Codex、Cursor、Kimi、Qwen、Copilot、Droid、Grok 等）：本文只覆盖了 openai-chat 的 HTTP 回合，CLI 引擎由其自身二进制发请求，需单独审计其配置与遥测开关。
- `server/cloud-*` 的完整状态机（Cloud 连接、Team 连接、共享电脑、云电脑文件传输）：已覆盖主要出站 API，但未逐条列出每个 `/api/cloud/*` 的 payload。
- `server/plugins/**` 的插件运行时（插件代码本身可以任意外连）：已覆盖 catalog/安装来源，未审计已安装插件的运行行为。
- `server/extractor/**` 除 inbox triage 外的 `botExtract` 调用：已确认会把输入文本发给后端，但未逐字段展开。
- `electron/**` 中所有 `session.defaultSession.fetch` 的间接调用（通知、团队资料、本地服务发现等）：已覆盖主要用户内容外发，未逐文件穷举。
- `shared/**` 只做了域名/默认值核对，未发现独立的后台外连；`shared/app-frame/csp.ts` 中的 CDN 白名单属于前端资源加载，不是后端主动上报。

**明确不计入本表的**

- `server/model-catalog/catalog.ts:43,266` 的 `https://models.dev/api.json`：当前没有运行时调用者（仅构建脚本 `scripts/build-model-catalog.mjs` 使用），不会在服务启动或定时任务中发请求。
- `server/model-catalog/models-dev.snapshot.json`：静态快照，不是外连。
- `server/plugins/test-fixtures.ts`、`*.test.ts`、`*.node-test.mjs`、`server/testing/**`：测试残留，按要求排除。
- `example.com`、`*.test`、`*.invalid`、`localhost`/`127.0.0.1`：测试或本机地址，不计为外部外连。

## 七、待补清单（按优先级）

| 待补项 | 为什么重要 | 建议下一步 |
|---|---|---|
| CLI/ACP 引擎的外连与遥测开关 | 这些引擎由外部二进制发请求，可能绕过本仓库的 egress 控制 | 逐个检查 `server/drivers/acp/*` 的启动环境、是否有 `DISABLE_TELEMETRY`/`DO_NOT_TRACK`，以及是否会读取用户目录凭据 |
| 浏览器内用户输入 | bot 可在网页表单里提交用户内容，范围可能比 API 外连更大 | 审计 `server/browser/**` 的表单填写、上传、下载与站点权限 |
| Cloud/Team 全部 `/api/cloud/*` payload | 已有主要项，但缺少逐路由字段清单 | 用路由表反查所有 `fetch`，补全 payload 字段 |
| 插件运行时代码 | 插件同进程运行，理论上可任意外连 | 审计插件权限模型、网络权限与官方插件包行为 |
| `electron/**` 的间接 fetch | 可能漏掉通知、团队资料、服务发现等 | 以 `session.defaultSession.fetch` 为入口做调用图 |

## 八、范围外但与本审计直接相关（必须让用户知道）

**产品分析默认开启，且不在本次 `server/shared/electron` 范围内。** 前端 `src/lib/analytics.ts` 使用 PostHog：默认在未 opt-out 时初始化，发送 `app_opened`、`app_active`、产品事件、应用版本与平台；关闭了 autocapture 和 URL 上报，但仍会向 `https://us.i.posthog.com` 发请求（`src/lib/analytics.ts:10-20,72-120,144-155`）。这属于前端遥测，建议由前端审计单独处理；如果团队目标是“默认不外连”，它应当默认关闭，或在首次启动时询问。

---

**本文件没有修改任何代码。** 行号按 2026-11-14 当前工作树记录；并行改动可能继续移动行号，落地前请按符号名复核。
