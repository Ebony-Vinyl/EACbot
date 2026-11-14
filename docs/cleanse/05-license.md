# 05 许可与计费审计

采集日期：2026-11-14  
仓库：D:/workspace/EACbot-clean-core  
分支：codex/clean-core  
审计基线：781c57e9a6fbf0f504704d358f4c82a1860490c2（短哈希 781c57e；当前 HEAD 已前进到 b5ca7fd，本文以基线为主）  
输出：docs/cleanse/05-license.md

## 一、审计范围、方法与前提

范围是 server/enterprise.ts、brand.ts、included-services.ts、trial-credit.ts、plan-usage.ts、quota-switch.ts、limit-resets.ts、limit-notices.ts、limit-failover.ts、spend.ts、usage-ledger.ts、usage-metering.ts、usage-attribution.ts、usage-trace 目录、prices.ts、model-prices.ts、config.ts 的 budgets 与 billing 两段、contracts.ts 的 EngineAccess，以及 enterprise 目录、LICENSING.md 和 package.json 的 license 字段。

方法只有静态只读检查：用 rg -n 找符号和调用点，用 Get-Content 核对完整上下文，先以 HEAD 781c57e 为基线，对并行修改过的 config.ts 再按当前行号复核，漂移说明见第十三节。没有修改源码、配置、依赖或 git 状态，没有 git add、commit、push，也没有读取或改动 D:/workspace/EACbot 原件。

任务开始时 node_modules 缺失，要求不编译、不跑测试、不安装。审计期间其它小组安装了依赖，08 证据抽查已经记录这一变化；本报告仍按任务要求只做静态审计，不把“能编译”当成已验证事实。

工作树在审计期间有并行修改：server/index.ts 在 2846 行发生了 1 行替换，行数没有变化；update-check、announcement、devs-report 等文件另有未提交修改。这些文件不是本报告的主要证据来源；涉及 server/index.ts 的引用按 HEAD 行号给出，并按当前文件复核过没有整体漂移。

证据口径：下文“文件:行”均指 clean-core 的 HEAD 内容。推断会明确写“推断”，没有证据的运行时行为不写成事实。

## 二、直接回答

### 1. OSS 版实际被限制什么

先定口径：这里说 OSS，指没有 enterprise 目录、没有 EAC_LICENSE_KEY、没有 EAC_ADMIN_*、没有 Cloud home/team 变量的普通自建服务器。这个口径下 EditionStatus 初值是 edition 为 oss、features 为空（server/enterprise.ts:52），entitled 只检查 current.features，未知 id 和空 features 都返回 false（server/enterprise.ts:192-195）。

被 OSS 关闭的功能有四项真正有代码调用点：

- whitelabel：brand.json 即使存在也不会应用，loadBrand 返回默认品牌并带 notice（server/brand.ts:76-78）。
- budgets：spendState 先检查 entitled(budgets)，不通过就返回 null（server/spend.ts:80-81）；assertWithinBudget 因此不抛错（server/spend.ts:100-111）。
- billing：operatorPrices 只有 entitled(billing) 且配置里有价格时才返回价目表，否则 null（server/index.ts:1367-1368）；Usage 的 billable 列和 CSV 列因此消失（server/usage-ledger.ts:300-301、338-339）。
- admin：/api/fleet 直接 403（server/routes/status.ts:82-86）；hosted readiness 503（server/index.ts:12659-12667）；托管工作区的会话校验没有适配器时 503（server/index.ts:12529-12530、12674-12678）。

代码里存在但 OSS 不启用的部分：

- enterprise 目录本身、license key 解析、Ed25519 签名校验、register 的 grace 处理（server/enterprise.ts:119-150、enterprise/server/license.ts:38-74）。
- 托管工作区的 WorkspaceAccess 适配器（server/enterprise.ts:55-69、107-111、enterprise/server/workspace-access.ts:34-166）。
- Settings → Installations 与 Fleet 管理面依赖的 admin entitlement（server/routes/status.ts:82-86）。
- sso 只在 enterprise/FEATURES:4 和 enterprise/README.md:55 标为 planned；全仓没有发现 entitled(sso) 的调用点，因此它不是“OSS 关闭了 SSO”，而是“还没有 SSO 门”。

OSS 也强制、但与 enterprise 许可无关的边界：

- 一旦设置任一 EAC_ADMIN_*，HOSTED_WORKSPACE 就为真（server/index.ts:755），配对和邮箱登录被禁用（server/index.ts:12670-12678）。就算没有 enterprise 层，这个核心判断仍然生效。
- hosted 工作区的浏览器会话在缺少 workspaceAccess 时返回 503（server/index.ts:12529-12530）。
- sharedWorkspaceFullAccess 需要 EAC_SHARED_WORKSPACE_FULL_ACCESS=1、非桌面父进程、portal membership 和 admin entitlement，四者缺一不可（server/index.ts:759-760、server/enterprise.ts:101-105）。
- quota switch 默认开启（server/quota-switch.ts:74-78），limit failover、limit reset clock、usage ledger 都不检查 entitlement（server/limit-failover.ts:13-31、server/limit-resets.ts:120-137、server/usage-ledger.ts:1-2）。
- admin scope 是路由级边界，不是 license 边界；/api/usage 和 /api/plan-usage 没有进入 CLIENT_ALLOW，requiredScope 默认返回 admin（server/request-auth.ts:431-437、server/routes/status.ts:130-137）。

### 2. 删除 enterprise 后的确切行为

加载顺序是先在启动时 await loadEnterpriseLayer（server/index.ts:15437），再创建 workspaceAccess（server/index.ts:15452），然后打印 brand（server/index.ts:15458），最后监听主端口。loadEnterpriseLayer 不静态 import enterprise，核心只通过动态 import 找入口（server/enterprise.ts:1-2、119-132）。

目录查找规则：EAC_ENTERPRISE_DIR 设置时只查该目录；否则查 serverRoot/../enterprise，再查 serverRoot/enterprise（server/enterprise.ts:43-46）。入口只认 server/index.ts 或 server/index.js（server/enterprise.ts:48-50）。删掉 enterprise 后，entry 为 undefined，函数走 oss()（server/enterprise.ts:125-129）。

如果 EAC_LICENSE_KEY 仍然设置但没有目录，返回 oss，并在 notice 里说明 key 已设置但找不到层（server/enterprise.ts:126-129）。如果目录还在但没有 key，返回 oss，notice 说明层存在但未设置 key（server/enterprise.ts:137）。如果 import、register 或 zod 校验失败，catch 后同样回落 oss，不会把启动打崩（server/enterprise.ts:148-150）。

EditionStatus 的形状是 edition（oss 或 enterprise）、可选 customer、features 字符串数组、可选 expiresAt、可选 expiresInDays、可选 graceEndsAt、可选 notice（server/enterprise.ts:13-27）。删除 enterprise 后它的值是 edition 为 oss、features 为空、没有 customer 和过期信息；如果设了 key 但没有层，会多一个 notice。

API 和 UI 的变化：

- GET /api/edition 返回 oss 和空 features；成员版还会去掉倒计时和 notice（server/routes/status.ts:104-107、server/enterprise.ts:186-190）。
- config.edition 走 editionForSettings，只显示 edition 和 features；只有企业版临近或超过到期时才带 license 块（server/index.ts:11807、server/enterprise.ts:216-224）。
- GET /api/brand 继续返回默认品牌 source:default；如果有 brand.json，会带“未授权白标”的 notice（server/routes/status.ts:109-110、server/brand.ts:58-79）。
- Usage 页的 budget 为 null，billing 为 null，billable 列和 CSV 列消失（server/routes/usage.ts:108-115、server/usage-ledger.ts:300-301）。
- Settings → Workspaces 和 /api/fleet 入口不可用，fleet 请求 403（server/routes/status.ts:82-86）。
- hosted readiness、hosted 浏览器会话校验、托管登录都会 503 或 403（server/index.ts:12529-12530、12659-12678）。
- 本地 loopback 的普通自建使用不受影响；没有 EAC_ADMIN_* 时 HOSTED_WORKSPACE 为 false，email 和 pairing 仍走本地路径（server/index.ts:755、12670-12678）。

会不会崩溃：不会。动态 import 只在入口存在时执行，所有失败都捕获并回落 oss（server/enterprise.ts:119-150）。构建脚本也只在 enterprise/server/index.ts 存在时才打包 enterprise 层并复制 LICENSE（scripts/bundle-server.mjs:125-141）。CI 有一个专门的 open-source edition builds without enterprise/ 作业：删除 enterprise 后跑 typecheck、server/enterprise.test.ts、server/brand.test.ts，并用 EAC_LICENSE_KEY=omb1.not.real 启动，断言报告 oss（.github/workflows/ci.yml:417-443）。这是 CI 设计证据，不是本次实测；本次没有跑该作业。

workspace access 的变化：普通自建没有 EAC_ADMIN_* 时 createWorkspaceAccess 直接返回 null（server/enterprise.ts:107-109），本地回环、邮箱登录、配对都仍可用。设置了 EAC_ADMIN_* 时 HOSTED_WORKSPACE 为真，但 workspaceAccess 为 null，核心会禁用配对和邮箱，hosted 路由返回 503（server/index.ts:12670-12678）。这是 fail closed，不是回退成“任何人可远程访问”。换句话说，删除 enterprise 是合法的 OSS 降级，但不会把已经配置的托管工作区变成本地开放服务。

### 3. 哪些 entitlement 只是 UI 或功能开关，哪些是真正商业边界

按代码里的调用点判断：

- whitelabel：品牌展示开关。只影响 brand.json 是否应用（server/brand.ts:76-78）。技术上不控制登录、模型或数据访问；但 enterprise/LICENSE:17-22 把第三方白标和托管列为 partner agreement 范围，所以它是合同边界，不只是 UI。
- budgets：成本守卫。只在 spendState 和 assertWithinBudget 中生效（server/spend.ts:80-81、100-111）。它是运营功能，不是支付处理，也不控制登录。
- billing：报表和售价开关。只控制 operatorPrices、billable 列和 CSV 列（server/index.ts:1367-1368、server/usage-ledger.ts:300-301、338-339）。代码里没有创建订单、扣款或发票的路径；它是“运营方售价表”，不是支付系统。
- admin：真正的商业边界。它同时控制 Fleet/Workspaces（server/routes/status.ts:82-86）、hosted readiness（server/index.ts:12659-12667）和托管工作区适配器（server/enterprise.ts:107-111、enterprise/server/workspace-access.ts:34-166）。这决定远程多用户身份、成员角色和访问撤销。
- sso：目前只是声明。enterprise/FEATURES:4 和 enterprise/README.md:55 都写 planned；没有 entitled(sso) 调用点，也没有 SSO 身份实现。不能把它算成已交付的商业边界。

不属于 entitlement 的机制：

- included services：Boat、Voice、Decider、AI trial、X research 的 relay URL 和 token 由环境变量成对提供，没有 entitled 检查（server/included-services.ts:1-14、31-43）。
- quota switch：EAC_QUOTA_SWITCH 默认开启，只有等于 0 才关闭（server/quota-switch.ts:74-78）；它处理供应商限额，不读 edition。
- plan usage：只读供应商套餐用量，路由要求 admin scope，但不要求 enterprise entitlement（server/routes/status.ts:130-137）。
- trial credit：Cloud home 的试用额度，不是 EAC_LICENSE_KEY 的 entitlement；它由 EAC_CLOUD_AI_URL/TOKEN 是否有效决定（server/included-services.ts:45-56、server/cloud-credit-provider.ts:66-97）。
- limit failover 和 limit reset：核心可靠性功能，不读 edition（server/limit-failover.ts:13-31、server/limit-resets.ts:120-137）。
- EngineAccess：引擎在 picker 里的分类，不是付费门（server/contracts.ts:581-585、592）。

真正会让远端用户进不来的边界是 admin 和 hosted workspace，而不是 budgets、billing 或 brand。billing 也不等于“向客户收钱”；它只是把运营方售价算进报表。这个区别很重要：删掉 billing entitlement 不会停止任何真实扣款，只会让报表没有 billable 列。

### 4. budgets 和 billing 在没有 entitlement 时是忽略、默认额度还是报错

答案是忽略，不使用默认额度，也不报错。

- spendState 第一个条件就是 !isEntitled(budgets)，直接返回 null（server/spend.ts:81）。它不会把 monthlyUsd 当成默认值，也不会用 warnAtPercent 做任何判断。
- assertWithinBudget 只检查 state?.exceeded；state 为 null 就 return（server/spend.ts:100-111）。direct send、beginTurn、room turn、自动恢复、插件面板、标题生成等入口都会调用它，但在 OSS 下都是无操作（server/index.ts:7234、7620、9816、8637、12491、7535；server/person-replies.ts:87；server/side-jobs.ts:128；server/routes/channels.ts:341）。
- 配置仍然可以保存：/api/config 的 PUT/PATCH 没有检查 budgets 或 billing entitlement，saveConfig 会接受这些 section（server/routes/config.ts:121、545-550；server/config.ts:960）。configStatus 仍会返回 budgets 和 billing 的值（server/index.ts:11808-11812）。
- UI 会隐藏：UsageBudgetCards 只有在 features 包含 budgets 或 billing 时才渲染，否则返回 null（src/components/UsageBudget.tsx:195-203）。所以用户可能保存了值，但在 OSS 界面看不到卡片，也看不到它没有生效。
- monthlyUsd 为 0、负数、非有限数或缺省时，即使有 budgets entitlement 也不启用；条件是 typeof monthlyUsd 为 number、有限且大于 0（server/spend.ts:80-81）。配置 schema 允许 0 到 1,000,000（server/config.ts:367-372），所以 0 是合法值，但表示关闭。
- 有 budgets entitlement 且 monthlyUsd > 0 时，spentUsd 大于等于 monthlyUsd 才 exceeded（server/spend.ts:91-92）；assertWithinBudget 抛出 status 409、code spend_cap（server/spend.ts:108-111）。warnAtPercent 默认 80，只有百分比达到它才 warn（server/spend.ts:18、83、91）。
- 有 billing entitlement 且配置有价格时，operatorPrices 才返回价目表（server/index.ts:1367-1368）；没有 entitlement 时 billing 为 null，billableUsd 不计算，CSV 不加 billable_usd 列（server/routes/usage.ts:91、114；server/usage-ledger.ts:300-301、338-339）。但 costUsd 仍然会按模型静态价或 reported 值记录，因为 ledgerCost 不检查 billing entitlement（server/model-prices.ts:121-131）。

因此 OSS 的实际行为是：预算值可以写进 config.json，但没有上限；售价表可以写进 config.json，但不会出现在 billable 报表。它不是“默认给你一个 80% 的预算”，也不是“请求时报 403”。

### 5. trial credit、plan usage、quota switch 的实际效果

trial credit：

- 只有 Cloud home 且 EAC_CLOUD_AI_URL/TOKEN 成对有效时才创建 CloudCreditProvider（server/index.ts:1546-1557）。token 必须是 omb_ai_ 加 43 个字符，URL 必须是 https 或 loopback（server/included-services.ts:45-56）。
- 它注册一个 id 为 trial-credit 的 openai-compat 实例，base URL 是 relay，token 放在该实例自己的 OPENMAUSBOT_TRIAL_CREDIT_KEY 环境里（server/cloud-credit-provider.ts:14-24、43-51）。
- 扣减发生在 relay 端，本地没有 token 计数器；本地只保存 allowed models 和 refused 状态（server/cloud-credit-provider.ts:205-240）。
- 402 且 code 为 trial_credit_used_up 返回 used_up；402 且 trial_credit_ended 或 401 且 invalid_api_key 返回 ended；400 且 trial_credit_too_low 返回 too_low；429 返回 paused（server/trial-credit.ts:10-21）。
- used_up 和 ended 会写入 refused，之后 sendTurn 和 generateText 都抛 TRIAL_CREDIT_REFUSED，阻断该实例的后续回合和后台调用（server/cloud-credit-provider.ts:137-145、162-203）。paused 和 too_low 只把错误翻译成可读文案，不会永久阻断下一次尝试。
- 当已有自己的 AI 可用时，describeInstances 会把 trial-credit 标成 unavailable 并给 TRIAL_CREDIT_OWN_AI 原因（server/index.ts:11918-11932）；held-keys 还会在 credit 有效期间压住随迁保存的自己的 key（server/cloud-held-keys.ts:14-34）。这说明试用额度是 Cloud 商业额度，不是 enterprise entitlement。

plan usage：

- 只读。loadPlanUsage 调用 fetchPlanUsage，对 Claude、Codex、Grok、OpenCode 的用量端点发 GET，带各自账号的 token；不发送对话正文（server/plan-usage.ts:114-130、294-328、922-1046）。
- 默认 8 秒超时、45 秒缓存；refresh=1 绕过缓存（server/plan-usage.ts:114-115、306-328）。失败或 401/403 会变成 provider error row，函数本身不抛到回合（server/plan-usage.ts:922-1046）。
- 凭证来源包括 Claude 的 .credentials.json 和 macOS Keychain、Codex 的 auth.json、Grok 的 auth.json、OpenCode 的 API key 或 auth.json；单文件读取上限 1 MB，Keychain 5 秒、1 MB（server/plan-usage.ts:114-119、263-292、716-890）。
- 调用点只有 GET /api/plan-usage（admin）和 LimitResetClock 的刷新/等待（server/routes/status.ts:130-137、server/limit-resets.ts:220-259）。启动时构造 LimitResetClock 只加载 holds，不主动联网（server/limit-resets.ts:115-119、242-246）。没有 limit_reset 自动化在等待时，也不会定时轮询。

quota switch：

- 默认开启，只有 EAC_QUOTA_SWITCH=0 才关闭（server/quota-switch.ts:74-78）。
- 它挂在 turnFailed 上；只有 turn 已经失败、失败原因被识别为供应商 quota 或 signed-out 时才动作（server/index.ts:6749-6754、server/quota-switch.ts:198-217）。
- 它只处理用户自己的请求，不处理 routine、webhook、peerAsk、guest 或 internal（server/quota-switch.ts:221-228、server/peer-provenance.ts:36-45）。
- 它会标记当前 engine 为 limited，按 takeover.backups 的顺序找可用 AI，切换 thread model，然后把用户原消息重发到新 engine（server/quota-switch.ts:211-213、154-191；server/host/quota-switch.ts:37-46）。失败不抛给回合，只写 notice 或留卡（server/quota-switch.ts:243-247、272-337）。
- EAC_QUOTA_SWITCH=0 时自动切换关闭，但仍会告诉用户当前受限；routine 的 limitBackup 还会看 startupBackups，而不是 quota switch（server/quota-switch.ts:225-227、server/index.ts:8835）。

failover 与 quota switch 的区别：quota switch 是“失败后换 AI 并重发”；LimitFailovers 是记住 thread 已换到备份，等原 engine reset 或重新登录后切回（server/limit-failover.ts:100-134）。两者都不读 enterprise entitlement。

### 6. brand.ts 与 enterprise 的关系

OSS 默认品牌是 EACbot：DEFAULT_BRAND = name: EACbot，没有 logo、tagline、accent 或 supportUrl（server/brand.ts:41）。品牌文件默认是 DATA_DIR/brand.json，可用 EAC_BRAND_FILE 覆盖（server/brand.ts:53-55）。

loadBrand 每次 GET /api/brand 都重新读文件；文件不存在、JSON 不合法、schema 不合法或不具 whitelabel 权限时都返回默认品牌，并带 notice（server/brand.ts:57-79）。/api/brand 在无认证时也公开，因为登录页需要名称和图标（server/index.ts:12790-12792、server/routes/status.ts:109-110）。

brand.ts 本身不联网：它只 import fs、path、zod、config 和 enterprise，没有 fetch、http 或子进程（server/brand.ts:1-8）。它不会回连 EACbot 官方。只有运营方在 brand.json 里写了 https 的 logo 或 supportUrl 时，浏览器才会去那个地址取图或跳转；这是运营方配置的第三方地址，不是服务端自动回连。更新检查、公告、统计等网络行为在别的模块，不能根据 brand.ts 推断。

whitelabel 的边界在 server/brand.ts:76-78：没有 entitlement 时，即使文件完全合法也不应用，只返回默认品牌和 notice。enterprise/README.md:125-128 还说明桌面应用包名、安装器名称、macOS 权限提示等是打包时固定的，brand.json 改不了；完整白标是打包工程，不是配置。

### 7. 建议总览

- 保留 server/enterprise.ts。它是 EditionStatus、WorkspaceAccess、entitled、loadEnterpriseLayer 的契约，删掉会破 server/index.ts、server/routes/status.ts 和测试的类型与调用。删 enterprise 目录时保留这个约 200 行的核心模块，是合法 OSS 降级的最小改动。
- 保留 enterprise/ 的独立许可和密钥校验。不要改 license key 校验、公钥列表、签名算法，也不要伪造 entitlement；如果要做 OSS 降级，只删除整个 enterprise 目录并保留 LICENSING.md 的说明。
- budgets 和 billing 的配置 schema、AppConfig 字段、configStatus 字段建议保留；它们已经写进 config.json 和备份策略，直接删类型会让旧配置变成不可读的死数据。是否在 OSS 显示卡片可以再决定，但不要用“删字段”来表达关闭。
- budgets 默认关闭是正确的商业边界；但应在 UI 明确写“需要 enterprise budgets，当前未生效”，避免运营方以为填了 monthlyUsd 就有上限。
- billing 只是报表和售价，不处理支付。若产品需要真正收款，应另做订单、支付、发票和对账，不要把它当成 billing entitlement 的现有能力。
- whitelabel 保留 entitlement 检查；OSS 使用 DEFAULT_BRAND。若 OSS 社区需要自定义名称，应另设一个不冒充商业白标的本地品牌开关，并由产品明确许可边界。
- sso 目前应标为 planned，不应在售卖清单里当成已交付的边界；等真正有 entitled(sso) 和 OIDC 实现后再启用。
- included services、quota switch、plan usage、trial credit 都没有 enterprise entitlement 检查；清理时不要把“商业服务凭证”和“enterprise 许可”混成一类。特别是 trial credit 是 Cloud 商业额度，不是 EAC_LICENSE_KEY 的功能。
- quota switch 建议保留默认开启，但在 UI 或文档里说明它会切换到备份 AI 并重发用户消息，可能产生额外费用；对 pay-per-use 备份应有独立开关。
- limit failover 保留“不轮换同一订阅账号”的限制，这是供应商条款和账号安全边界，不应为了绕过限额而放宽。

## 三、与 02 的 G-xx 对照

02 的 G-10 到 G-17 与本报告结论一致：hosted workspace 只允许门户登录（G-10）、缺 enterprise 层时会话校验 503（G-11）、企业功能需要 key 和层（G-12）、7 天宽限（G-13）、whitelabel 需要 entitlement（G-14）、billing 价目表需要 entitlement（G-15）、budgets 上限需要 entitlement（G-16）、Fleet 和 hosted readiness 需要 admin（G-17）。这些行号与本报告引用的 server/index.ts:12670-12678、12529-12530、12659-12667、server/enterprise.ts:107-111 对得上。

需要标注一个分类差异，不是行为冲突：02 的 G-26 把 trial credit 归入“商业许可边界”。从“商业产品边界”这个大类看可以理解，但严格按代码，trial credit 没有 entitled 检查，也不读 EAC_LICENSE_KEY；它由 Cloud home、EAC_CLOUD_AI_URL/TOKEN 和 relay 返回的 402/401 决定（server/cloud-credit-provider.ts:66-97、137-145、server/trial-credit.ts:10-21、server/included-services.ts:45-56）。更准确的分类是“Cloud 商业服务额度”，不是“enterprise entitlement”。这不改变它的风险等级，但会改变清理建议：删 enterprise 不会关掉 trial credit；只有移除 Cloud 凭证或 Cloud home 才会。

03 的 F05 说 UsageBudget 只在 budgets/billing features 下渲染，这与 server/spend.ts:80-81、server/index.ts:1368、src/components/UsageBudget.tsx:195-203 一致。03 的 F04 说 Workspaces 入口要求 admin，也与 server/routes/status.ts:82-86 一致。

## 四、逐项表

编号说明：C 是 edition、license、workspace access；L 是预算和上限；A 是账务、用量、价格、品牌、included services、trial credit；Q 是 quota switch、plan usage、limit reset/failover。

| 编号 | 文件:行 | 限制或行为 | 触发条件 | 默认值 | 技术限制/商业许可 | 建议（删除/默认关闭/改可配置/保留） |
|---|---|---|---|---|---|---|
| C01 | package.json:3,12 | 根包 private，license 字段是 Apache-2.0；enterprise 目录不在这条字段的覆盖范围内 | 构建或分发 | Apache-2.0 | 商业许可 | 保留 |
| C02 | LICENSING.md:3-13 | 主体 Apache-2.0；enterprise 是 source-available 的单独许可；生产使用需组织 key；第三方托管或白标需 partner agreement | 阅读或分发 | 主体 Apache、enterprise 例外 | 商业许可 | 保留 |
| C03 | LICENSING.md:15-23 | 删除 enterprise 目录即 OSS；hosted 工作区不得因此绕过配置的登录权威 | 删除目录并启动 | OSS edition | 商业许可 | 保留 |
| C04 | enterprise/LICENSE:5-26 | enterprise 不适用 Apache；允许阅读、构建、评估；生产需 key；禁止再分发、托管、白标；第 4 条允许删除后按 Apache 使用其余部分 | 使用 enterprise | 无 key 不可生产 | 商业许可 | 保留 |
| C05 | server/enterprise.ts:1-2,11,119-132 | 核心不静态 import enterprise；启动时通过动态 import 找入口 | 启动 | 动态加载 | 技术限制 | 保留 |
| C06 | server/enterprise.ts:43-50 | EAC_ENTERPRISE_DIR 优先且只查该目录；否则查 serverRoot/../enterprise，再查 serverRoot/enterprise；入口只认 index.ts 或 index.js | 启动 | 按顺序查找 | 技术限制 | 保留 |
| C07 | server/enterprise.ts:52,113-129 | 没有入口时返回 oss；有 key 但没有层时也返回 oss 并给 notice | 启动无 enterprise | oss、features 空 | 技术限制 | 保留 |
| C08 | server/enterprise.ts:131-150 | 有层但无 key、import 失败、register 失败或 schema 失败都回落 oss；函数不抛 | 启动有层但无效 | oss | 技术限制 | 保留 |
| C09 | server/enterprise.ts:30-34,139-146 | register 返回 customer、features、expiresAt，经 zod 校验；features 去重并排序 | 有效 key | enterprise | 商业许可 | 保留 |
| C10 | server/enterprise.ts:37-38,153-184 | 到期前 30 天警告；到期后 7 天宽限；宽限结束后 entitled 返回 false | 有效期临近或过期 | 30 天、7 天 | 商业许可 | 保留 |
| C11 | enterprise/server/index.ts:13-22 | enterprise 层把 graceDays 限制在 0 到 14，核心传 7 | register | 最大 14 天 | 商业许可 | 保留 |
| C12 | enterprise/server/license.ts:13-15,38-74 | omb1 claims 用 Ed25519 公钥离线验证；签名错误或过期都拒绝 | 启动注册 | 单公钥 | 商业许可 | 保留 |
| C13 | enterprise/FEATURES:1-12 | 授权 id 为 whitelabel、sso、admin、budgets、billing；sso 标 planned；未知 id 不授权 | 发 key | 见文件 | 商业许可 | 保留 |
| C14 | server/enterprise.ts:192-195 | entitled 只认 current.features，且许可证未过期；未知 id 一律 false | 任意功能检查 | false | 商业许可 | 保留 |
| C15 | server/enterprise.ts:13-27,52 | EditionStatus 有 edition、customer、features、expiresAt、expiresInDays、graceEndsAt、notice | API 或日志 | oss | 技术限制 | 保留 |
| C16 | server/routes/status.ts:104-107 | GET /api/edition；admin 看完整状态，成员去掉倒计时、宽限日和 notice | 请求 | 完整或裁剪 | 商业许可 | 保留 |
| C17 | server/index.ts:11807,11879-11886 | config.edition 走 editionForSettings；非 admin 只保留 edition 和 features | GET /api/config 或 SSE | 隐藏 license 细节 | 技术限制 | 保留 |
| C18 | server/enterprise.ts:107-111 | 未配置 hosted 时返回 null；配置 hosted 但没有 factory 时也返回 null | EAC_ADMIN_* | null | 商业许可 | 保留 |
| C19 | server/index.ts:755-760 | HOSTED_WORKSPACE 由任一 EAC_ADMIN_* 触发；shared full access 需 portal、非桌面父进程和 admin | 启动 | hosted false、full false | 商业许可 | 保留 |
| C20 | server/index.ts:12670-12678 | hosted 时禁用 pairing 和 email；workspaceAccess 为空时 hosted 路由 503，远程根路径也 503；本地 loopback 仅根路径放行，pairing/email 仍 403 | 配 EAC_ADMIN_* 且无层 | fail closed | 技术限制 | 保留 |
| C21 | server/index.ts:12529-12530 | 浏览器会话 authorize 在 hosted 且无 workspaceAccess 时返回 503 | hosted 加 session | 503 | 技术限制 | 保留 |
| C22 | server/routes/status.ts:82-86 | /api/fleet 要求 entitled admin，否则 403；没有 socket 时 404 | 请求 fleet | 403 | 商业许可 | 保留 |
| C23 | server/index.ts:12659-12667 | /api/health/hosted 要求 portal membership、workspaceAccess 和 admin，否则 503 | 请求 | 503 | 商业许可 | 保留 |
| C24 | scripts/bundle-server.mjs:125-141 | 只有 enterprise/server/index.ts 存在才打包 index.js 并复制 LICENSE | 构建 | 条件打包 | 技术限制 | 保留 |
| C25 | .github/workflows/ci.yml:417-447 | CI 删除 enterprise 后跑 typecheck、两个测试、带假 key 启动并断言 oss | CI | 无层 oss | 技术限制 | 保留 |
| C26 | enterprise/FEATURES:4, enterprise/README.md:55 | sso 只标 planned；全仓没有 entitled(sso) 调用点，发 sso key 也不会产生 SSO 行为 | 发 sso key | 无实际效果 | 商业许可 | 默认关闭 |
| L01 | server/config.ts:367-372 | budgets.monthlyUsd 为 0 到 1,000,000 的可选数字；warnAtPercent 为 1 到 100 的可选整数 | 保存配置 | 都缺省 | 商业许可 | 保留 |
| L02 | server/config.ts:499 | AppConfig 的 budgets 是可选对象，没有默认每月额度 | 读取配置 | 无 budgets | 商业许可 | 保留 |
| L03 | server/spend.ts:80-81 | 只有 budgets entitlement 且 monthlyUsd 为有限正数才计算 spend 状态 | 任何预算检查 | 关闭 | 商业许可 | 保留 |
| L04 | server/spend.ts:18,83 | warnAtPercent 缺省为 80 | 预算状态 | 80 | 商业许可 | 保留 |
| L05 | server/spend.ts:19-43 | 月度 spend 缓存 15 秒，按 usage 账本和未落盘 pending 行计算 | 预算检查 | 15 秒缓存 | 技术限制 | 保留 |
| L06 | server/spend.ts:100-111 | spend 超限时抛 status 409、code spend_cap | 有 budgets 且超限 | 不抛 | 商业许可 | 保留 |
| L07 | server/index.ts:7232-7236 | direct send 进入前检查预算，失败返回 409 spend_cap | 直接发消息 | 仅企业生效 | 商业许可 | 保留 |
| L08 | server/index.ts:7620 | beginTurn 在取 bot 和检查线程后、派发前检查预算 | 回合开始 | 仅企业生效 | 商业许可 | 保留 |
| L09 | server/index.ts:9816 | 房间回合派发前检查预算 | 房间回合 | 仅企业生效 | 商业许可 | 保留 |
| L10 | server/index.ts:8637 | 自动恢复切换备份前再检查预算 | 失败恢复 | 仅企业生效 | 商业许可 | 保留 |
| L11 | server/index.ts:12488-12491 | 插件生成面板前检查预算 | 插件面板生成 | 仅企业生效 | 商业许可 | 保留 |
| L12 | server/index.ts:7534-7537 | 线程标题生成前检查预算，失败转为拒绝文案 | 生成标题 | 仅企业生效 | 商业许可 | 保留 |
| L13 | server/side-jobs.ts:125-128; server/person-replies.ts:85-87; server/routes/channels.ts:338-343 | 辅助任务、人员回复、频道发送都复用同一预算检查 | 各入口 | 仅企业生效 | 商业许可 | 保留 |
| L14 | server/spend.ts:136-151; server/host/usage-metering.ts:57-59 | warn 和 cap 每个自然月、每个阈值最多提醒一次；写入 usage/alerts.json，失败被吞掉 | 预算达到阈值 | 80%、每月一次 | 技术限制 | 保留 |
| L15 | server/fleet.ts:276-280 | fleet 初始化配置时可以把 seed.monthlyCapUsd 写成 budgets.monthlyUsd | 创建托管工作区 | 无 seed 不写 | 商业许可 | 保留 |
| L16 | server/routes/config.ts:121,545-550 | PUT/PATCH /api/config 接受 budgets 和 billing，不检查 entitlement | 保存配置 | 接受 | 技术限制 | 保留 |
| L17 | src/components/UsageBudget.tsx:195-203 | budgets 和 billing 都无 entitlement 时 UsageBudgetCards 返回 null | 渲染 Usage | 隐藏 | 商业许可 | 保留 |
| L18 | server/index.ts:11808-11812 | configStatus 仍返回 budgets 和 billing 的值；billing.currency 默认 USD | 读取配置状态 | USD | 技术限制 | 保留 |
| L19 | server/spend.ts:80-92 | 一个 workspace 只有一个 monthlyUsd，不按 bot 或 section 分开 | 任何预算检查 | 单 workspace | 商业许可 | 保留 |
| A01 | server/usage-ledger.ts:1-2,81-84,111-142 | 用量按 UTC 月份追加到 usage/YYYY-MM.jsonl，文件 0600，目录 0700 | 每次记账 | 追加写 | 技术限制 | 保留 |
| A02 | server/usage-ledger.ts:125-137 | 写入失败返回 false，不向回合抛错 | 磁盘或权限失败 | 静默失败 | 技术限制 | 保留 |
| A03 | server/usage-ledger.ts:23-58 | 行里记 bot、thread、model、驱动、token、成本、trigger、trace、工具次数，不存消息正文 | 每次记账 | 见结构 | 技术限制 | 保留 |
| A04 | server/usage-ledger.ts:197-211 | 用量查询范围最多 366 天；非法日期或反向范围返回 null | 查询 usage | 366 天 | 技术限制 | 改可配置 |
| A05 | server/usage-ledger.ts:289-328 | 汇总按 bot、model、user、day、engine、routine、department 分组 | 查询 usage | 全部行 | 技术限制 | 保留 |
| A06 | server/usage-ledger.ts:338-360 | CSV 只在 prices 非空时增加 billable_usd 列 | 导出 CSV | 无 prices 不加列 | 商业许可 | 保留 |
| A07 | server/prices.ts:19-32 | 价格查找顺序为 driver/model、model、default；billable 按 fresh input、cached input、output 计算 | 计价 | 无匹配返回 null | 技术限制 | 保留 |
| A08 | server/model-prices.ts:10-17,28-91 | 静态价目表 asOf 2026-09-23，来源是 OpenAI、Anthropic、xAI、Google、MiniMax、OpenRouter | 估算成本 | 固定快照 | 技术限制 | 改可配置 |
| A09 | server/model-prices.ts:94-111 | Gemini 3.8 Flash 的三个 thinking 别名映射到同一价格；2027-01-01 起有价格变更 | 估算成本 | 按日期选变更 | 技术限制 | 保留 |
| A10 | server/model-prices.ts:114-131 | 有 reported cost 就用 reported；否则用 operator prices、list prices、default 估算 | 记账 | 可能 estimated | 技术限制 | 保留 |
| A11 | server/index.ts:1367-1368 | operatorPrices 只有 billing entitlement 且价格表非空才返回 | 读取售价 | null | 商业许可 | 保留 |
| A12 | server/routes/usage.ts:86-115 | Usage 返回 budget 和 billing；billing 只在 prices 非空时带 currency | 查询 usage | budget 可能 null | 商业许可 | 保留 |
| A13 | server/index.ts:11812 | billing.currency 缺省为 USD；config schema 只接受三个大写字母 | 读取配置 | USD | 技术限制 | 保留 |
| A14 | server/index.ts:12393-12396 | Usage 路由注入 dataDir、operatorPrices、spendState 和 currency | 启动组装 | 见依赖 | 技术限制 | 保留 |
| A15 | server/request-auth.ts:431-437 | /api/usage 不在 CLIENT_ALLOW，requiredScope 默认 admin | 请求 usage | admin | 技术限制 | 保留 |
| A16 | server/usage-trace/spans.ts:39,76-100 | span 保留 90 天，按天写 usage/spans/YYYY-MM-DD.jsonl，启动或写入时清理旧文件 | 记录 trace | 90 天 | 技术限制 | 改可配置 |
| A17 | server/usage-trace/ledger.ts:14,65 | trace 账本最多缓存 24 个月 | 读取 trace | 24 个月 | 技术限制 | 保留 |
| A18 | server/brand.ts:41,53-55 | 默认品牌只有 name: EACbot；文件默认是 DATA_DIR/brand.json，可用 EAC_BRAND_FILE 覆盖 | 启动或请求 | EACbot | 商业许可 | 保留 |
| A19 | server/brand.ts:58-79 | 每次读取并校验 brand.json；文件缺失、JSON 错误、schema 错误或未授权都回落默认品牌 | GET /api/brand | 默认品牌 | 商业许可 | 保留 |
| A20 | server/brand.ts:76-78 | 没有 whitelabel entitlement 时 brand.json 一律不应用，只给 notice | 有品牌文件但 OSS | 默认品牌 | 商业许可 | 保留 |
| A21 | server/brand.ts:1-8 | brand 模块只依赖 fs、path、zod、config、enterprise，没有网络调用 | 加载模块 | 无外连 | 技术限制 | 保留 |
| A22 | server/index.ts:12790-12792; server/routes/status.ts:109-110 | GET /api/brand 无认证也公开，供登录页读取名称和图标 | 请求 | 公开 | 技术限制 | 保留 |
| A23 | server/included-services.ts:1-14,31-43 | Boat、Voice、Decider、AI trial、X research 各用一对 URL 和 token；两者都非空才生效 | 启动读取 env | 无 token 不生效 | 技术限制 | 保留 |
| A24 | server/included-services.ts:58-64 | 启动时把 included token 从环境里移到内存，然后删除这些 env，防止子进程继承 | 启动 | 删除 env | 技术限制 | 保留 |
| A25 | server/included-services.ts:66-73 | 用户自己的 key 优先；included token 只发往它自己的 relay | 解析凭证 | 自有 key 优先 | 技术限制 | 保留 |
| A26 | server/included-services.ts:45-56 | AI trial token 必须是 omb_ai_ 加 43 个字符；URL 必须是 https 或 loopback，不能带用户名、查询或 fragment | 解析 EAC_CLOUD_AI | 无效即 null | 商业许可 | 保留 |
| A27 | server/included-services.ts:99-133,143-166 | X research 可从 Cloud env 或桌面父进程消息取得；treg 自有 key 优先，URL 只允许 https 或 loopback | 使用 X 或 research | 无凭证不显示工具 | 技术限制 | 保留 |
| A28 | server/cloud-credit-provider.ts:14-24,43-51 | trial-credit 是 openai-compat 实例，模型列表最多 20 个，默认 Claude Haiku 4.5 占位 | Cloud trial | 见常量 | 商业许可 | 保留 |
| A29 | server/cloud-credit-provider.ts:66-97,137-153 | 启动时列 relay 模型；used_up 或 ended 写入 refused 并保存到 providers/trial-credit/state.json | Cloud trial | active | 商业许可 | 保留 |
| A30 | server/cloud-credit-provider.ts:162-203 | sendTurn 和 generateText 在 refused 时抛错；后台标题和摘要也受同一限制 | 已拒绝 | 阻断该实例 | 商业许可 | 保留 |
| A31 | server/trial-credit.ts:10-21 | 429 为 paused；402 used_up 为 used_up；402 ended 或 401 invalid_api_key 为 ended；400 too_low 为 too_low | relay 响应 | 无 | 商业许可 | 保留 |
| A32 | server/cloud-held-keys.ts:14-34 | credit 有效期间压住随迁保存的自有 key，credit 结束后才放行 | Cloud move | 无 credit 即放行 | 商业许可 | 保留 |
| A33 | server/index.ts:11918-11932 | 已有自己的 AI 可用时，trial-credit 在引擎列表里标为 unavailable，原因是 TRIAL_CREDIT_OWN_AI | 列引擎 | 自有 AI 优先 | 商业许可 | 保留 |
| A34 | server/config.ts:373-388,503 | billing.prices 按模型 key 存 input、output、cached input 价格，每项 0 到 1,000,000 | 保存配置 | 无价格 | 商业许可 | 保留 |
| A35 | server/config.ts:374-377 | billing.currency 只接受三个大写字母，缺省显示 USD | 保存或显示 | USD | 技术限制 | 保留 |
| Q01 | server/quota-switch.ts:74-78 | 供应商限额自动切换默认开启；EAC_QUOTA_SWITCH=0 才关闭 | 启动 | true | 技术限制 | 保留 |
| Q02 | server/quota-switch.ts:198-217 | 失败原因被识别为 quota 或 signed-out 时进入 takeover；工具错误不算 | 回合失败 | 不动作 | 技术限制 | 保留 |
| Q03 | server/quota-switch.ts:221-228; server/peer-provenance.ts:36-45 | 只处理用户自己的请求；routine、webhook、guest 被标成 outside，peerAsk 被单独排除，internal 也不动 | 回合失败 | 跳过 | 技术限制 | 保留 |
| Q04 | server/quota-switch.ts:211-213 | 当前 engine 加入 limited，backups 由 takeover 给出；关闭时 backups 为空 | 失败 | 空 | 技术限制 | 保留 |
| Q05 | server/quota-switch.ts:154-191 | 切换 thread model 并重发用户原消息；busy、card、runtime、question 会阻止重发 | 失败且找到备份 | 自动执行 | 技术限制 | 改可配置 |
| Q06 | server/quota-switch.ts:272-337 | 用户在卡片上选 AI 时再执行切换；过期、配置变化、模型不可用都会拒绝 | 卡片回答 | 不切换 | 技术限制 | 保留 |
| Q07 | server/quota-switch.ts:340-363 | 只有 answer 且文字精确匹配选项才选择 engine；decline 或乱写视为 Not now | 卡片回答 | 不选择 | 技术限制 | 保留 |
| Q08 | server/quota-switch.ts:225-227 | EAC_QUOTA_SWITCH=0 时仍告诉用户受限，但不自动切 | 关闭开关 | 不自动切 | 技术限制 | 保留 |
| Q09 | server/index.ts:9665 | quota switch 在启动时组装，接入 store、coordinator、registry、takeover 和 send | 启动 | 始终构造 | 技术限制 | 保留 |
| Q10 | server/host/quota-switch.ts:37-46 | host 把 registry.access、policy refusal、model switch、thread busy、resend 接进来 | 启动 | 见依赖 | 技术限制 | 保留 |
| Q11 | server/limit-failover.ts:13-31 | 同一订阅 engine 的不同账号不能互相接管；只有不同 engine 或 pay-per-use 才能接管 | 限额失败 | 按规则 | 商业许可 | 保留 |
| Q12 | server/limit-failover.ts:100-118 | failover 记录按 thread 去重，最多保留 500 条 | 记录 failover | 500 | 技术限制 | 保留 |
| Q13 | server/limit-failover.ts:122-134 | 原 engine reset 或重新登录后切回；线程已被手动改模型则不再切回 | 新回合开始 | 自动恢复 | 技术限制 | 保留 |
| Q14 | server/limit-resets.ts:12-14 | 限额轮询间隔 5 分钟；拒绝后的 reset 保留 10 分钟宽限 | 限额监控 | 5 分钟、10 分钟 | 技术限制 | 保留 |
| Q15 | server/limit-resets.ts:97-98,173-198 | 拒绝没有给出 reset 时，按 1 小时 hold；有 reset 则按 reset | 限额拒绝 | 1 小时 | 技术限制 | 保留 |
| Q16 | server/limit-resets.ts:274-298 | hold 写入 DATA_DIR/limit-holds.json，0600；重启后恢复未过期的 hold | 持有或释放 | 持久化 | 技术限制 | 保留 |
| Q17 | server/limit-resets.ts:242-259 | start 后每 60 秒检查一次；只有有 limit_reset routine 等待时才刷新，数据超过 5 分钟才真正请求 | 启动后 | 60 秒 tick | 技术限制 | 保留 |
| Q18 | server/limit-notices.ts:13-14,65-73 | 同一 bot 和同一 engine 的一段限额只提醒一次；没有 reset 的 stretch 为 3 小时 | 限额通知 | 一次 | 技术限制 | 保留 |
| Q19 | server/limit-notices.ts:29-44 | 有备份时提示“正在用某 AI”，没有备份时提示“等待 reset” | 限额 | 见文案 | 技术限制 | 保留 |
| Q20 | server/plan-usage.ts:114-130,294-328 | 计划用量只读，8 秒超时，45 秒缓存；refresh=1 绕过缓存 | 请求 plan usage | 45 秒 | 技术限制 | 改可配置 |
| Q21 | server/routes/status.ts:130-137 | GET /api/plan-usage 是 admin 路由，不在 CLIENT_ALLOW | 请求 | admin | 技术限制 | 保留 |
| Q22 | server/plan-usage.ts:153-170,716-890 | 只从已配置的 Claude、Codex、Grok、OpenCode 账号读凭证；文件 1 MB，Keychain 5 秒 | 读取用量 | 见来源 | 技术限制 | 保留 |
| Q23 | server/plan-usage.ts:922-1046 | 凭证缺失、过期、401/403、超时、5xx 都变成 provider error row，不抛到回合 | 读取失败 | 错误行 | 技术限制 | 保留 |
| Q24 | server/limit-resets.ts:27-40 | plan usage 的五小时和周窗口达到 100% 时把 engine 标成 blocked；Claude 有 extra usage 空间时不算 blocked | 读取 usage | 见逻辑 | 技术限制 | 保留 |
| Q25 | server/index.ts:8821-8829 | 三个持久文件分别是 limit-holds.json、limit-notices.json、limit-failovers.json | 启动 | 见路径 | 技术限制 | 保留 |
| Q26 | server/contracts.ts:581-585,592; server/harness/registry.ts:295-297 | EngineAccess 是 subscription、custom、api 三值，只用于 picker 分组和认证判断，不是 entitlement | 列引擎 | subscription | 技术限制 | 保留 |

## 五、统计

- 总条数：106。
- C：26 条；L：19 条；A：35 条；Q：26 条。
- 按建议计数：保留 100 条；改可配置 5 条；默认关闭 1 条；删除 0 条。
- 按技术限制/商业许可计数：技术限制 60 条；商业许可 46 条。
- 高风险条目：L03、L05、C20、Q05、Q11、A19、A11、Q20、A30、C26，共 10 条。

## 六、风险 Top 10

1. L03：OSS 下预算完全关闭。证据是 spendState 先看 entitled(budgets)（server/spend.ts:80-81），assertWithinBudget 对 null 直接返回（server/spend.ts:100-111）。运营方在 config.json 填了 monthlyUsd 也会以为有上限，实际不会拦任何回合。建议保留 entitlement，同时在 UI 明示“未生效”，不要让配置看起来像已启用。

2. L05：预算检查发生在派发前，成本行在回合结束后才由 metering.book 写入（server/host/usage-metering.ts:56），而 monthToDateSpend 只在上一次记账后通过 pending 补差（server/spend.ts:30-43）。推断：并发回合可以在各自记账前都通过检查，从而越过 monthlyUsd。建议在派发前做成本预留，或把并发计数纳入上限。

3. C20：删除 enterprise 后，已经配置 EAC_ADMIN_* 的部署会 fail closed。HOSTED_WORKSPACE 仍为真（server/index.ts:755），但 workspaceAccess 为 null，配对和 email 被禁用，hosted 路由 503（server/index.ts:12670-12678）。不会崩溃，也不会回退成开放远程；运维会表现为“登录入口打不开”。建议在删除目录前明确移除 EAC_ADMIN_*，或保留 enterprise 层。

4. Q05：quota switch 默认开启，失败后会把 thread 切到备份 AI 并重发用户消息（server/quota-switch.ts:74-78、154-191、211-213）。备份可能是另一个付费 API，重发也会再花一次钱。建议保留自动切换，但在 UI 说明费用影响，并允许按 bot 关闭。

5. Q11：limit failover 允许切到不同 engine 或同一 engine 的 pay-per-use 实例（server/limit-failover.ts:22-31）。这会真实产生 API 账单；同一订阅的多账号轮换被禁止（第 19-25 行），这是正确的供应商条款边界。建议把 pay-per-use 备份设为显式 opt-in，不要默认自动接管。

6. A19：whitelabel 文件存在但未授权时只回落默认品牌并给 notice（server/brand.ts:58-79）。运营方可能以为品牌已生效，实际登录页仍是 EACbot。建议在启动日志和 Settings 把“未授权白标”显示为明确状态，而不是只放在 /api/brand 的 notice 里。

7. A11：billing entitlement 关闭时 operatorPrices 返回 null（server/index.ts:1367-1368），billable 列和 CSV 列消失（server/usage-ledger.ts:300-301、338-339）。报表仍显示 costUsd，但那是 provider 成本或静态估算，不是运营方售价。建议在 Usage 页明确区分“provider cost”“estimated”“billable”三种口径。

8. Q20：plan usage 会把本地账号 token 发到 Anthropic、ChatGPT、Grok、OpenCode 的用量端点（server/plan-usage.ts:124-130、922-1046）。虽然只读且不发送对话正文，但它是高价值凭证访问。建议默认只在用户打开用量页时查询，把后台轮询限制在确有 limit_reset automation 等待的场景，并在设置中说明数据去向。

9. A30：trial credit 的 used_up 或 ended 会一直污染 refused 状态，之后 sendTurn 和 generateText 都抛错（server/cloud-credit-provider.ts:137-145、162-203）。没有新的 token 时，Cloud home 上的 trial-credit 实例会持续不可用。建议在 UI 明确“需要换 token 或登录自己的 AI”，并保证本地 OSS 没有 Cloud token 时完全不创建该实例。

10. C26：sso 只在 FEATURES 和 README 里标 planned，代码没有 entitled(sso) 检查（enterprise/FEATURES:4、enterprise/README.md:55）。如果销售材料把 sso 当成已交付边界，会产生合同预期差。建议在实现 OIDC 和 entitled 检查之前，把 sso 从可售清单移除或明确标注 planned。

## 七、未决问题与证据缺口

- 本次没有编译、跑测试、启动服务。原因是任务要求只做静态审计；审计期间依赖虽已由其它小组安装，但本报告没有使用这一变化。
- 00-baseline.md 仍写 node_modules 缺失，08 证据抽查已经指出该结论过时。两份文档状态不一致，后续基线应以重新采集为准；本报告不修改 00。
- 删除 enterprise 的实际启动结果是 CI 设计证据，不是本机实测。CI 作业在 .github/workflows/ci.yml:417-443；本报告没有执行 pnpm typecheck 或启动。
- 没有真实 EAC_LICENSE_KEY、企业部署或 Cloud Admin 环境，无法判断这台机器当前实际 edition。默认值和代码分支可以确认，部署状态不能确认。
- enterprise/README.md 的 key 发放流程和实际商业合同不在仓库；本报告只能确认代码不提供绕过，不能验证客户是否已获授权。
- billing 没有支付处理代码。这个结论是“在本报告范围内未发现订单、扣款、发票路径”，不是对仓库全部模块的绝对证明；如果产品另有外部支付服务，需要单独审计。
- included services 的 relay 服务条款和实际额度不在仓库；本报告只能确认 token 只发往配置的 relay，不能确认 relay 的计费规则。
- plan usage 的外部 API 形状可能漂移；解析器按当前代码记录，未联网验证 Anthropic、ChatGPT、Grok、OpenCode 的真实响应。
- 品牌是否“回连官方”只针对 brand.ts。更新检查、公告、统计、账号登录等网络行为在本报告范围外；01 已有专门审计，不能把 brand.ts 的结论外推到整个产品。
- 行号以 HEAD 781c57e 为准；server/index.ts 在审计期间有 1 行未提交修改，但行数未变。若主线程继续编辑，落地时应按符号名重新定位。

## 八、关键默认值矩阵

| 项目 | 默认值 | 证据 | 说明 |
|---|---|---|---|
| EAC_LICENSE_KEY | 未设置 | server/enterprise.ts:124-129 | 未设置时不会因为缺少 key 报错；有 key 但无层会多一条 notice |
| EAC_ENTERPRISE_DIR | 未设置 | server/enterprise.ts:43-46 | 未设置时先查 serverRoot/../enterprise，再查 serverRoot/enterprise |
| LICENSE_WARN_DAYS | 30 天 | server/enterprise.ts:37 | 到期前 30 天开始警告 |
| LICENSE_GRACE_DAYS | 7 天 | server/enterprise.ts:38 | 到期后 7 天内仍按企业版工作 |
| enterprise 层最大 grace | 14 天 | enterprise/server/index.ts:13-20 | 核心传 7，层会限制在 0 到 14 |
| EAC_ADMIN_URL、EAC_ADMIN_WORKSPACE、EAC_ADMIN_MEMBERSHIP | 未设置 | server/enterprise.ts:71-73 | 任一出现就视为 hosted 配置；部分配置会返回 null |
| EAC_SHARED_WORKSPACE_FULL_ACCESS | 未设置 | server/enterprise.ts:101-105 | 必须是 1，且非桌面父进程，且 portal membership，且 admin |
| EAC_QUOTA_SWITCH | 未设置视为开启 | server/quota-switch.ts:76-77 | 只有 trim 后等于 0 才关闭 |
| EAC_BRAND_FILE | 未设置 | server/brand.ts:53-55 | 未设置时用 DATA_DIR/brand.json |
| DEFAULT_BRAND | name 为 EACbot | server/brand.ts:41 | 没有 logo、tagline、accent、supportUrl |
| budgets.monthlyUsd | 未设置 | server/config.ts:367-372 | 缺省表示没有预算；0 也表示关闭 |
| budgets.warnAtPercent | 80 | server/spend.ts:18、83 | 允许 1 到 100 |
| billing.currency | USD | server/index.ts:11812 | 只影响显示，不做汇率换算 |
| billing.prices | 空 | server/config.ts:373-388 | 没有价格时 billable 列为 null |
| spend 缓存 | 15 秒 | server/spend.ts:19 | 同一 dataDir 和同一月份共用缓存 |
| usage 查询范围 | 最多 366 天 | server/usage-ledger.ts:197-211 | 超过范围返回 400 |
| trace span 保留 | 90 天 | server/usage-trace/spans.ts:39、76-100 | 按天清理旧 span 文件 |
| plan usage 超时 | 8 秒 | server/plan-usage.ts:114 | 单个 provider 请求超时 |
| plan usage 缓存 | 45 秒 | server/plan-usage.ts:115 | refresh=1 可绕过 |
| limit 轮询 | 5 分钟 | server/limit-resets.ts:12 | start 后每 60 秒检查是否该刷新 |
| 未命名限额 hold | 1 小时 | server/limit-resets.ts:97-98 | 供应商没有给 reset 时使用 |
| trial credit 重试 | 15、30、60、120、300、600 秒 | server/cloud-credit-provider.ts:22 | 最多退到 10 分钟一次 |
| trial credit 模型数 | 20 | server/cloud-credit-provider.ts:20 | 超过部分忽略 |
| EngineAccess 默认 | subscription | server/harness/registry.ts:295-297 | 驱动没有 metadata.access 时按订阅处理 |

## 九、启动期与运行时惰性

这一节专门区分“启动即构造”和“只在路由或运行时才触发”，因为两者对资源、网络和权限的影响不同。

- enterprise 层是启动期加载：server/index.ts:15437 在监听前 await loadEnterpriseLayer，动态 import enterprise 入口。删除目录后这一步只做文件系统查找，不会联网。
- brand 是启动期加载一次并在每次 GET /api/brand 重新读文件：启动日志在 server/index.ts:15458，读取逻辑在 server/brand.ts:58-79。它没有网络调用。
- included services 是启动期读取环境变量并把 token 移入内存：server/index.ts:729、server/included-services.ts:61-64。只有配置了 URL 和 token 才持有凭证；模块导入本身不发请求。
- trial credit 只在 CLOUD_HOME 下构造：server/index.ts:1546-1557。构造后 start 才会去 relay 列模型；没有 Cloud 环境时完全不存在。
- quota switch 在启动时构造，但不联网：server/index.ts:9665、server/host/quota-switch.ts:37-46。它只在回合失败事件后动作。
- limit reset clock 在启动时构造，只加载 holds 文件：server/index.ts:8821、server/limit-resets.ts:115-119。start 在监听后执行（server/index.ts:15522），而且只有 limit_reset routine 在等待时才主动刷新。
- limit notices 和 limit failovers 在启动时构造并读取自己的文件：server/index.ts:8822-8823、server/limit-notices.ts:51-62、server/limit-failover.ts:89-107。
- plan usage 没有启动期网络请求。它只在 GET /api/plan-usage 或 LimitResetClock 刷新时读取；启动时不会因为配置了套餐就自动查询（server/routes/status.ts:130-137、server/limit-resets.ts:220-259）。
- spend 没有启动期账本扫描。第一次 assertWithinBudget 或 spendState 才会读 usage 目录；缓存 15 秒（server/spend.ts:30-43）。
- usage ledger 在回合记账时追加文件，不在启动时扫描全部历史；读历史只在 Usage API 或 trace 服务中发生（server/usage-ledger.ts:111-142、171-195）。

## 十、存储兼容与删除影响

- server/enterprise.ts 的 EditionStatus、WorkspaceAccess、entitled、loadEnterpriseLayer 被 server/index.ts、server/routes/status.ts 和测试引用。删这个文件会直接破类型和调用，不能当作“删掉 enterprise 功能”的快捷方式。删 enterprise 目录是另一回事，核心模块应保留。
- config.ts 的 budgets 和 billing 已经进入 AppConfig、configStatus、config.json 和备份策略。删字段不会自动清理磁盘，但会让新代码读不到这些值；再次保存时 saveConfig 仍会保留未知磁盘键，形成“文件里有、程序里没有”的死数据。建议保留可选 schema 和类型。
- usage 账本按月写在 DATA_DIR/usage/YYYY-MM.jsonl，0600。删代码不会删历史文件；重新接入时应继续读同一目录，否则旧账消失。
- limit-holds.json、limit-notices.json、limit-failovers.json 都存在 DATA_DIR 根目录。删 limit 模块后这些文件会变成孤儿文件，不影响启动，但会丢失“为什么之前切过模型”的解释。
- trial credit 的 state.json 和 held-keys.json 在 DATA_DIR/providers/trial-credit/。它们只对同一 token 有效；换 token 后 saved 会返回 null。删 trial 模块不需要迁移，但应保留目录避免误以为额度还在。
- brand.json 在 DATA_DIR 根目录，也可由 EAC_BRAND_FILE 指向别处。删 brand 模块会丢默认品牌和 notice；保留文件不会自动生效，仍受 whitelabel 检查。
- EnterpriseAccess 的缓存和会话不写 config；workspace access 的 portal 会话由 SessionRegistry 管理。删 enterprise 层不会删本地 sessions.json，但 hosted 会话会因缺少 authorize 而失败关闭。
- EngineAccess 是 contracts.ts 的联合类型，被 InstanceConfig、默认模型选择、quota switch、limit failover 使用。它不影响存储格式，但删类型会破多处编译；建议保留。
- LICENSING.md 和 package.json 的 license 字段是分发边界，不是运行时开关。删 enterprise 目录时保留这两个文件和 enterprise/LICENSE 的说明，才能证明降级合法。

## 十一、建议的落地顺序

1. 先固定一个只读快照。当前工作树有并行修改，config.ts 已经新增 limits 段并把 budgets 从 HEAD 352 后移到 367；逐行复核会漂移。以 HEAD 781c57e 或一个明确 commit 作为报告基线，再按符号名落地。
2. 保留 server/enterprise.ts。它是类型和 fail-closed 行为的核心；只删 enterprise/ 目录，不删这个文件。
3. 删除 enterprise 目录前确认部署没有 EAC_ADMIN_*。如果有 hosted 配置，删除后会 503，这是设计上的 fail closed，不是 bug。
4. 保留 budgets 和 billing 的 schema、AppConfig 字段和 configStatus 字段；先改 UI 文案，明确“未授权时不会生效”，再决定是否隐藏卡片。
5. 保留 whitelabel 检查，OSS 使用 DEFAULT_BRAND。若需要社区自定义名称，另设一个不冒充商业白标的本地品牌开关，并写清许可边界。
6. 把 sso 从可售清单移到 planned，直到有 entitled(sso) 和 OIDC 实现；不要用 license key 里的 sso 字符串冒充功能。
7. 对 quota switch 和 pay-per-use failover 增加费用提示和独立开关；保留“不轮换同一订阅账号”的限制。
8. 把 plan usage 的后台轮询限制在确有 limit_reset automation 等待时；在设置里说明 token 会发往哪些供应商端点。
9. billing 若要做真实收款，另建订单、支付、发票和对账；不要改 license 校验来“打开收费”。
10. 最后跑 OSS CI：删除 enterprise 后 typecheck、server/enterprise.test.ts、server/brand.test.ts、带假 key 启动并断言 oss。不要用改 key 或伪造 entitlement 的方式验证。

## 十二、证据抽查记录

写完后按文件逐条抽查了 15 个引用，结果如下。抽查只读，没有编译或启动。

- server/enterprise.ts:52 实际是 let current: EditionStatus = { edition: "oss", features: [] };，与“默认 OSS”一致。
- server/enterprise.ts:126-129 实际是无入口时返回 oss，并在有 key 时带 notice，与 C07 一致。
- server/index.ts:15437 实际是 await loadEnterpriseLayer()，与启动期加载一致。
- server/index.ts:15452 实际是 workspaceAccess = createWorkspaceAccess(...)，与删除层后 workspace access 为 null 的路径一致。
- server/index.ts:12670-12678 实际是 hosted 时禁用 pairing/email，缺 workspaceAccess 时 503，与 C20 一致。
- server/spend.ts:81 实际是 budgets entitlement 和 monthlyUsd 正数检查，与 L03 一致。
- server/spend.ts:100-111 实际是 state 为 null 直接返回，超限才抛 409 spend_cap，与 L06 一致。
- server/index.ts:1368 实际是 entitled(billing) 且价格非空才返回 operatorPrices，与 A11 一致。
- server/config.ts:367-372 当前工作树实际是 budgets schema；HEAD 是 352-358。两者内容相同，只是并行修改新增 limits 段导致后移。
- server/usage-ledger.ts:338-360 实际是 usageCsv，只有 prices 非空才加 billable_usd，与 A06 一致。
- server/brand.ts:76-78 实际是未授权 whitelabel 时回落默认品牌，与 A20 一致。
- server/quota-switch.ts:76-77 实际是 EAC_QUOTA_SWITCH 不等于 0 即开启，与 Q01 一致。
- server/limit-failover.ts:22-31 实际是不同 engine 或 pay-per-use 才能接管，与 Q11 一致。
- server/plan-usage.ts:114-115 实际是 8 秒超时和 45 秒缓存，与 Q20 一致。
- enterprise/server/license.ts:38-42 实际是 verifyLicenseKey 入口，与 C12 一致。

## 十三、行号漂移说明

截至本报告写完，server/config.ts 有并行未提交修改：新增 limits 段后，budgets 从 HEAD 的 352-358 后移到当前 367-372，billing 从 359-374 后移到 373-388，AppConfig 的 budgets 从 483 到 499，billing 从 487 到 503。报告表格和直接回答已按当前行号写，并在本节保留 HEAD 对照。

server/index.ts 在审计期间也有 1 行未提交替换（2846 行），但增删相抵，行数不变，本报告引用的 1368、7234、7535、7620、8637、9816、9665、11807-11812、12393-12396、12488-12491、12529-12530、12659-12678、12790-12792、15437、15452 仍与当前文件一致。server/request-auth.ts 有其它并行修改，但 requiredScope 仍在 431-437；引用与当前文件一致。

如果主线程继续把 limits 抽成新模块并重排 config.ts，下一次复核应按符号名 budgets、billing、monthlyUsd、warnAtPercent 重新定位，不要按本报告的行号直接改。

## 十四、可选方案对比

下面是给决策用的方案对比，不是已经执行的改动。三个方案都遵守“不改 license key 校验、不伪造 entitlement”的底线。

方案 A：只删 enterprise 目录，保留 server/enterprise.ts 和所有核心类型。  
优点是改动最小，普通自建仍按 OSS 启动，类型和存储兼容最好；CI 已有对应作业。代价是 hosted workspace 在 EAC_ADMIN_* 仍存在时会 fail closed，且 budgets、billing、whitelabel、admin 四个功能全部关闭。适合目标是“合法 OSS 降级”的部署。

方案 B：保留 enterprise 目录和 license 机制，但默认不配置 key。  
优点是可以继续合法评估 enterprise 功能，后续拿到 key 不需要重新加目录；代价是发布包仍带商业许可代码，构建和审计面更大，而且没有 key 时和方案 A 的运行行为基本一样。适合仍要维护 enterprise 产品的仓库。

方案 C：删除 enterprise 目录，同时删除 budgets、billing 的 config 字段、UI 和报表。  
优点是 OSS 面最干净，不再出现“填了预算但不生效”的误解；代价是破坏 AppConfig 类型、旧 config.json 的可读性、Usage CSV 的列兼容和前端状态类型，还需要迁移旧配置。除非明确要抛弃这些字段，否则不建议。

预算和计费的三个子方案：

1. 保留 schema 和 configStatus，UI 仍显示但加“需要 enterprise，当前不生效”的提示。优点是旧配置和报表兼容；缺点是需要改文案。
2. 保留数据但 OSS 隐藏卡片，和当前 UsageBudgetCards 的行为一致。优点是前端改动最小；缺点是运营方可能不知道值还在文件里。
3. 删除字段和 UI。优点是概念最干净；缺点是破坏类型、旧配置和备份兼容，不推荐。

quota switch 和 failover 的三个子方案：

1. 保持默认开启，补费用提示和每个 bot 的开关。优点是可靠性最好；缺点是需要用户理解“换 AI 可能再花钱”。
2. 默认只在订阅引擎之间切换，禁止自动切到 pay-per-use，只有用户显式允许才切。优点是避免意外账单；缺点是限额时可能没有备份可用。
3. 关闭自动切换，只保留手动卡片。优点是费用最可控；缺点是长任务更容易停在限额上。

我的建议是：enterprise 采用方案 A；预算和计费采用子方案 1；quota switch 采用子方案 1，另外对 pay-per-use 备份加显式 opt-in。这样既不绕过许可，也不把“关闭功能”误做成“删类型和旧配置”。

## 十五、对 03 F05 的轻微行号修正

03 的 F05 写 UsageBudget.tsx:25-27,195-199。实际 entitledTo 在 25-26，UsageBudgetCards 在 195-203，195-199 只覆盖到 if 判断，后面的两个条件渲染在 200-203。结论“前端只在 features 含 budgets 或 billing 时渲染”成立，只是行号范围少写了 4 行。引用时建议用 25-26 和 195-203。
