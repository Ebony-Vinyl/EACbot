# 02 后端能力门审计

- 审计对象：`D:\workspace\EACbot-clean-core`，分支 `codex/clean-core`，基线 `781c57e`。
- 范围：`server/`、`shared/` 的非测试文件；只读，不改代码。`D:\workspace\EACbot` 未触碰。
- 前置阅读：`docs/plan/01-boot-chain.md` 至 `05-remaining-capabilities.md`。本文只补它们没有系统展开的“用户能力门”，重复的启动链细节不再抄。
- 判定口径：
  - **技术限制**：代码把某种能力写死、默认关闭或加上硬上限；可以通过配置、代码调整或产品决策改变，不涉及 licence 绕过。
  - **商业许可边界**：`enterprise/`、`EAC_LICENSE_KEY`、entitlement、Cloud 计划、企业策略等商业产品边界。此类只标注“保留（不可动）”，不给删除或绕过建议。
  - “默认值”指不写 `config.json`、不设相关环境变量时的实际行为；“影响”指用户不满足该条件时看到的结果。

## 总表

| 编号 | 文件:行 | 限制什么 | 技术/许可 | 默认值 | 影响（不满足时会怎样） | 建议 |
|---|---|---|---|---|---|---|
| G-01 | `server/index.ts:15506` | HTTP 服务只绑定 `127.0.0.1` | 【技术限制】 | 回环地址 | 局域网或公网不能直接访问；远程只能走隧道、反向代理再配对 | 改成可配置的绑定地址，默认仍保持回环 |
| G-02 | `server/request-auth.ts:643` | 非回环请求没有有效会话一律 403 | 【技术限制】 | 强制 | 远程设备必须完成配对；否则所有 API 都拒绝 | 保留鉴权，补清楚配对和反代文档 |
| G-03 | `server/request-auth.ts:619`、`server/request-auth.ts:155` | 回环来源的浏览器也必须先登录 | 【技术限制】 | 开启 | 本机直接打开 `http://127.0.0.1:8799` 会收到 401；桌面壳或已配对设备例外；`EAC_DEV_TRUST_LOCAL_BROWSER` 只在源码开发且 owner 信任时生效 | 增加正式的本机浏览器信任开关，或默认信任本机页面但保留跨源限制 |
| G-04 | `server/request-auth.ts:39-55`、`server/request-auth.ts:623-636` | service 信任的回环只能访问白名单路由 | 【技术限制】 | 仅 15 类路由 | 共享服务器上，bot 的 shell 不能改设置、人员、权限 | 保留（安全边界） |
| G-05 | `server/request-auth.ts:276-278`、`server/request-auth.ts:333-390` | client 会话默认拒绝，只有显式列出的路由可用 | 【技术限制】 | 默认拒绝 | 成员可以改任务/线程模型、例程和显示字段，但不能改全局设置、provider/MCP 注册、人员权限、Webhook 创建等 | 改可配置（扩展 allowlist），或保留最小权限 |
| G-06 | `server/account-signin.ts:33-35`、`server/routes/email-sign-in.ts:29-31` | 没有配置 admins/members 时邮箱登录不启用 | 【技术限制】 | 关闭 | `/api/auth/email/*` 返回 404，无法用邮箱验证码登录 | 默认保持关闭，文档说明如何配置 |
| G-07 | `server/account-signin.ts:56-66` | 未设置 `EAC_SIGNIN_SMTP_URL` 时，邮箱验证码走 EACbot 控制面 | 【技术限制】 | 控制面 | 离线或纯自建环境无法完成邮箱登录，依赖外网服务 | 默认本地 SMTP，控制面作为可选；或明确标注该功能需要外网 |
| G-08 | `server/sessions.ts:24-26` | 会话 30 天过期，最长 180 天 | 【技术限制】 | 30/180 天 | 到期要重新配对；长期设备会掉线 | 改可配置（已有环境变量） |
| G-09 | `server/sessions.ts:34` | 同一来源 60 秒内失败 10 次锁定 60 秒 | 【技术限制】 | 10 次/60 秒 | 连续输错后暂时不能登录 | 保留（安全） |
| G-10 | `server/index.ts:12670-12672`、`server/enterprise.ts:94` | hosted workspace 只允许门户登录，禁用配对和邮箱 | 【商业许可边界】 | 强制 | 托管工作区不能用邮箱或二维码登录 | 保留（不可动） |
| G-11 | `server/index.ts:12529-12530`、`server/index.ts:12674-12677`、`server/enterprise.ts:108-110` | hosted workspace 的会话校验依赖 enterprise 层；缺失时 503 | 【商业许可边界】 | 无层则 503 | 配了 `EAC_ADMIN_*` 但没装 `enterprise/` 时，登录和浏览器鉴权不可用 | 保留（不可动） |
| G-12 | `server/enterprise.ts:124-140`、`server/enterprise.ts:193-195` | 企业功能必须 `EAC_LICENSE_KEY` 加 enterprise 层；未知 entitlement 一律 false | 【商业许可边界】 | OSS，无 features | 没有 key 就是 OSS，企业功能全关 | 保留（不可动） |
| G-13 | `server/enterprise.ts:37-38`、`server/enterprise.ts:160-163` | 许可证到期后 7 天宽限，之后企业功能停止 | 【商业许可边界】 | 7 天 | 到期后企业功能降级为 OSS | 保留（不可动） |
| G-14 | `server/brand.ts:76` | 白标品牌需要 `whitelabel` entitlement | 【商业许可边界】 | 关闭 | 放 `brand.json` 也被忽略，继续默认品牌 | 保留（不可动） |
| G-15 | `server/index.ts:1368` | 运营方计费价目表只在 `billing` entitlement 下读取 | 【商业许可边界】 | 关闭 | 自建不能用运营方售价表计费 | 保留（不可动） |
| G-16 | `server/spend.ts:81` | 月度预算上限只在 `budgets` entitlement 下生效 | 【商业许可边界】 | 关闭 | 配了 `budgets.monthlyUsd` 也不会拦截，可能超支 | 保留（不可动） |
| G-17 | `server/routes/status.ts:84`、`server/index.ts:12662` | Fleet、工作区管理、hosted readiness 需要 `admin` entitlement | 【商业许可边界】 | 关闭 | `/api/fleet` 403；hosted readiness 503 | 保留（不可动） |
| G-18 | `server/host/starter-bot-limit.ts:6`、`server/host/starter-bot-limit.ts:31` | Starter Cloud 最多 5 个 bot | 【商业许可边界】 | 5 | 第 6 个创建返回 409，提示升级 | 保留（不可动） |
| G-19 | `server/bot-thread-limits.ts:22` | Starter Cloud 每个 bot 只能 1 个并发线程 | 【商业许可边界】 | 1 | 第二个线程排队或被拒绝 | 保留（不可动） |
| G-20 | `server/bot-api-host.ts:295`、`server/bot-api-host.ts:305`、`server/index.ts:9571` | Bot API 在 Starter 计划不可用 | 【商业许可边界】 | Starter 关闭 | 生成 key 或开启 Bot API 返回 403 加 upgrade 标记 | 保留（不可动） |
| G-21 | `server/host/cloud-plan-tier.ts:23-33` | 计划层级来自 Admin 的签名文件，决定是否 Starter | 【商业许可边界】 | 无文件即非 Starter | 不是 Cloud 或没收到 Admin 计划时不会误加限制 | 保留（不可动） |
| G-22 | `server/hosted-models.ts:28-40`、`server/hosted-models.ts:109-111` | 托管工作区只能选 Admin 分配的公司模型 | 【商业许可边界】 | 未配置即关闭 | 配了 hosted 策略后，目录外模型返回 400 或执行时拒绝 | 保留（不可动） |
| G-23 | `server/routes/config.ts:123` | 托管工作区禁止改 provider 和实例设置 | 【商业许可边界】 | 未配置即关闭 | 返回 403，模型和 key 由 Admin 管理 | 保留（不可动） |
| G-24 | `server/managed-policy.ts:100-108` | 组织策略可禁用引擎、MCP、电脑、远程访问 | 【商业许可边界】 | 无策略即全开 | 企业策略下，被禁的引擎或电脑直接拒绝 | 保留（不可动） |
| G-25 | `server/cloud-team-policy.ts:33-41`、`server/cloud-team-policy.ts:71-83` | Team Cloud 每 5 分钟拉取规则，可远程收紧能力 | 【商业许可边界】 | 无规则即不限制 | 管理员改规则后无需重启生效，可禁用引擎、应用、MCP、电脑、远程访问 | 保留（不可动） |
| G-26 | `server/cloud-credit-provider.ts:84`、`server/cloud-credit-provider.ts:111-112`、`shared/trial-credit.ts:9-13` | 试用 Claude 额度用尽或暂停后拒绝回合 | 【商业许可边界】 | Cloud 试用 | 试用结束需自带账号或 API key | 保留（不可动） |
| G-27 | `server/routes/cloud-sync.ts:37-38` | 文件同步只在 Cloud home 可用 | 【技术限制】 | 非 Cloud 直接跳过 | 自建没有 `/api/sync` 桌面同步 | 保留（云产品面） |
| G-28 | `server/index.ts:1829`、`server/routes/bots-create.ts:188` | 每个 workspace 最多 100 个 bot | 【技术限制】 | 100 | 第 101 个创建返回 409 | 改可配置 |
| G-29 | `server/index.ts:1631`、`server/index.ts:14211` | 一个回合最多创建 4 个 bot | 【技术限制】 | 4 | 超出返回 429 | 改可配置 |
| G-30 | `server/bot-thread-limits.ts:6`、`server/bot-thread-limits.ts:16-17` | 每个 bot 最多 16 个并发线程 | 【技术限制】 | 16；内存很小时最低 3 | 超出排队 | 改可配置，提高硬上限 |
| G-31 | `server/index.ts:1629` | 一个回合最多 10 个附件 | 【技术限制】 | 10 | 超出返回 429 | 改可配置 |
| G-32 | `server/turn-images.ts:11-13` | 一个回合最多 10 张图、合计 40MB | 【技术限制】 | 10 张/40MB | 超出部分丢弃或不发送 | 改可配置 |
| G-33 | `server/image-daily-cap.ts:9`、`server/image-daily-cap.ts:24-25` | 每个安装每天最多生成 50 张图 | 【技术限制】 | 50 | 第 51 张拒绝，次日重置；计数落盘，重启不清零 | 改可配置（环境变量或 config） |
| G-34 | `shared/upload-limits.ts:2`、`server/attachments.ts:448` | 单个附件最大 25MB | 【技术限制】 | 25MB | 返回 413 | 改可配置 |
| G-35 | `server/attachments.ts:24-33` | 附件库默认 512MB，Cloud home 为 8GB | 【技术限制】 | 512MB | 满后返回 507，不自动淘汰旧附件 | 改可配置（已有环境变量） |
| G-36 | `shared/tool-budget.ts:2` | 单次 Chat Completions 最多 128 个工具 | 【技术限制】 | 128 | 超出工具被裁剪，部分 MCP 工具只能通过工具搜索找到 | 保留（上游限制），需要时做成可配置 |
| G-37 | `server/mcp-registry.ts:79`、`server/mcp-registry.ts:382` | 最多 20 个 MCP server | 【技术限制】 | 20 | 第 21 个返回 400 | 改可配置 |
| G-38 | `server/mcp-trim.ts:1`、`server/mcp-trim.ts:167` | 单个工具结果默认截断到 8000 字符 | 【技术限制】 | 8000 | 长结果被截断，完整内容可能另存到文件 | 改可配置（已有每 server 预算） |
| G-39 | `server/email/store.ts:14` | 最多 10 个邮箱账号 | 【技术限制】 | 10 | 不能继续添加 | 改可配置 |
| G-40 | `server/phones/registry.ts:40` | 最多 20 台配对手机 | 【技术限制】 | 20 | 配对被拒绝 | 改可配置 |
| G-41 | `server/team-manifest.ts:14`、`server/team-manifest.ts:51` | 团队最多 200 名成员 | 【技术限制】 | 200 | 导入或创建团队失败 | 改可配置 |
| G-42 | `server/local-vm-settings.ts:7` | 本地 VM 最多 8 个 | 【技术限制】 | 8 | 配置校验失败 | 改可配置 |
| G-43 | `server/index.ts:1630`、`server/index.ts:9659`、`server/index.ts:14024-14027` | 每回合最多 3 条房间发言，每条最多 4000 字 | 【技术限制】 | 3 条/4000 字 | 发言返回 429 或 400 | 改可配置 |
| G-44 | `server/room-post-budget.ts:26-32`、`server/room-post-budget.ts:87-101` | 同一 bot 每分钟最多 10 条、无人类回应最多 2 条、循环熔断 5 分钟 | 【技术限制】 | 10/2/5 分钟 | 发言被拒，房间可能暂时关闭 | 改可配置，或保留（防循环） |
| G-45 | `server/host/room-new-thread.ts:6`、`server/host/room-new-thread.ts:16` | 每回合最多开 4 个房间线程 | 【技术限制】 | 4 | 返回 429 | 改可配置 |
| G-46 | `server/group-goal-run.ts:7`、`server/index.ts:9628` | 房间目标最多 13 回合，跨房间接力最多 1 跳 | 【技术限制】 | 13/1 | 目标提前结束，不能多跳协作 | 改可配置 |
| G-47 | `server/config.ts:44-46`、`server/config.ts:614-615` | 房间回合 5 分钟无进展即停，最多可配 1440 分钟 | 【技术限制】 | 5 分钟 | 长任务被中断 | 改可配置（已有，可提高上限） |
| G-48 | `server/config.ts:47-49`、`server/config.ts:618-619` | MCP 调用 10 分钟超时，最多 60 分钟 | 【技术限制】 | 10 分钟 | 长工具调用被中止 | 改可配置 |
| G-49 | `server/runtime/types.ts:346-355` | 协调树深度 4、24 请求、48 执行、48 唤醒、20 分钟无进展失败 | 【技术限制】 | 4/24/48/48/20 分钟 | 复杂多 bot 任务提前失败 | 改可配置 |
| G-50 | `server/browser/dispatch.ts:23` | 浏览器单动作 15 秒超时 | 【技术限制】 | 15 秒 | 慢页面操作失败 | 改可配置 |
| G-51 | `server/drivers/openai-compat.ts:88` | OpenAI-compat 回合最长等待 60 分钟 | 【技术限制】 | 60 分钟 | 超时中止 | 改可配置 |
| G-52 | `server/drivers/acp/quiet-status.ts:15`、`server/drivers/acp/quiet-status.ts:328` | ACP 15 分钟无输出、5 分钟无信号即判定卡住 | 【技术限制】 | 15/5 分钟 | 长思考被停止 | 改可配置 |
| G-53 | `server/webhooks.ts:98-104`、`server/webhooks.ts:661-669` | Webhook 每分钟 10 次、默认 3 个待办（最多 50） | 【技术限制】 | 10 次/分钟、3 个 | 返回 429 | 改可配置 |
| G-54 | `server/webhook-ingress.ts:8`、`server/webhooks.ts:97`、`server/webhooks.ts:275` | Webhook body 256KB、事件文本 48k 字符 | 【技术限制】 | 256KB/48k | 413 或截断 | 改可配置 |
| G-55 | `server/app-events.ts:9-10` | 每次 app 事件运行最多 20 条、48k 字符 | 【技术限制】 | 20 条/48k | 超出截断 | 改可配置 |
| G-56 | `server/context-rebuild.ts:193` | 上下文重建最多带 40 条消息 | 【技术限制】 | 40 | 更早消息只靠摘要 | 改可配置 |
| G-57 | `server/context-budget.ts:4` | 未知模型上下文默认 128k | 【技术限制】 | 128000 | 大窗口模型可能被过早压缩 | 改可配置，或让模型目录覆盖 |
| G-58 | `server/drivers/pi.ts:234` | Pi 引擎输出上限 16384 tokens | 【技术限制】 | 16384 | 长回答被截断 | 改可配置 |
| G-59 | `server/routes/tts.ts:65` | 单次 TTS 最多 500 字符 | 【技术限制】 | 500 | 返回 413，需要分段 | 改可配置 |
| G-60 | `server/config.ts:244-247` | `sharedComputers`、`claudeUserMcp`、`claudeUserSkills` 默认关 | 【技术限制】 | 关 | 电脑共享、Claude 用户 MCP 和用户技能默认不可用；电脑共享没有设置开关 | 默认放开关键项，或加设置入口 |
| G-61 | `server/config.ts:237-239`、`server/config.ts:254-264` | `skillReview`、`skillsLibrary`、`parallelRoomJobs`、`chiefEscalations`、`agentsToolBridge` 默认关 | 【技术限制】 | 关 | 技能评审、共享技能库、并行房间任务、升级上报、工具桥默认不可用 | 按产品定位默认放开，至少提供 UI |
| G-62 | `server/config.ts:240-241`、`server/config.ts:248-249`、`server/config.ts:263` | `showToolCalls`、`llmThreadTitles`、`acpPlanLines` 默认关 | 【技术限制】 | 关 | 工具过程、LLM 标题、ACP 计划行默认不显示或不生成 | 默认放开或提供 UI |
| G-63 | `server/config.ts:428`、`server/safety-floor-gate.ts:15-16` | 安全地板默认关，只能显式开 | 【技术限制】 | 关 | 高风险命令没有额外拦截 | 保留（安全策略由用户决定） |
| G-64 | `server/index.ts:12485` | 插件进程运行时默认关，需 `EAC_PLUGIN_PROCESS=1` | 【技术限制】 | 关 | 插件只能声明式，不能跑进程 | 改可配置并写文档 |
| G-65 | `server/routes/instances.ts:263` | 自建服务器不能从 Settings 安装引擎 | 【技术限制】 | 禁用 | 只能在机器上手动装 CLI | 改可配置（允许本机安装） |
| G-66 | `server/contracts.ts:246-291` | 功能按驱动能力位启用（浏览器、电脑、MCP、图片、中途 steer 等） | 【技术限制】 | 由驱动决定 | 某些模型没有浏览器、电脑、图片或中途 steer | 保留（能力差异），在 UI 和文档标注 |
| G-67 | `server/index.ts:12493`、`server/announcement-feed.ts:8-10` | 远程公告源可选，10 分钟刷新 | 【技术限制】 | 未设置即不拉取 | 不影响功能，只影响公告 | 保留 |
| G-68 | `server/update-check.ts:11-20`、`server/update-check.ts:109-110` | 更新检查需显式 `EAC_UPDATE_CHECK_URL` | 【技术限制】 | 未设置即不检查 | 不影响功能，只影响升级提示 | 保留 |

## 统计

- 总数：**68 条**。
- 技术限制：**51 条**（G-01 至 G-09，G-27 至 G-68）。
- 商业许可边界：**17 条**（G-10 至 G-26），均只标注“保留（不可动）”。

## 三个容易误判的点

1. **没有全局模型/provider 白名单。** `checkedModelSelection` 只在调用方显式传 `requireAvailableModel=true` 时检查实例目录，平时允许自由模型名（`server/index.ts:2633-2648`）；实例的 `driver` 也是任意字符串（`server/config.ts:272-285`），OpenAI 兼容实例可以带目录外模型（`server/drivers/openai-compat.ts:186-195`）。真正的白名单只有托管工作区的公司模型（G-22）和企业策略的 `allowedEngines`（G-24）。
2. **没有按消息条数收费或拒绝发送的本地配额。** `Store.appendMessage` 没有条数上限（`server/store.ts:1175` 起）；实际影响上下文的是“重建最多 40 条”（G-56）和默认 128k 窗口（G-57），不是聊天条数门。
3. **没有房间人数硬上限。** 在 `server/routes/groups.ts` 和 `server/store.ts` 的建房路径里没有成员数上限检查；能查到的是团队 200 人（G-41）和房间发言限制（G-43、G-44）。不要把团队人数误写成房间人数。

另外，`server/contracts.ts` 本身只有类型和能力位，没有 entitlement 判断；它限制的是“某个驱动能不能挂某个工具”，不是“用户有没有付费”。`server/enterprise.ts` 才是 licence 入口，`entitled()` 对未知 feature 一律 false（`server/enterprise.ts:193-195`）。

## 按风险排序的 Top 10

排序标准：对自建用户的阻断程度、出现频率、是否容易在正常使用中撞到。商业许可边界即使风险高，也不能通过改代码绕过，所以在“首要动作”里只写核实或文档化。

| 排名 | 编号 | 风险 | 为什么排在这里 | 证据 | 首要动作 |
|---|---|---|---|---|---|
| 1 | G-01、G-02 | 高 | 只绑回环且远程必须配对，直接决定能不能在局域网/公网自建；这是最外层的硬门 | `server/index.ts:15506`、`server/request-auth.ts:643` | 先做可配置绑定地址和配对文档，不要动鉴权 |
| 2 | G-03 | 高 | 本机浏览器打开 UI 也要登录，普通用户会以为服务没起来；`EAC_DEV_TRUST_LOCAL_BROWSER` 只对源码开发生效 | `server/request-auth.ts:619`、`server/request-auth.ts:155` | 加正式的本机浏览器信任开关，或默认放开本机页面 |
| 3 | G-10、G-11、G-12 | 高 | hosted workspace、企业功能和所有 entitlement 都锁在 enterprise 层；配了 `EAC_ADMIN_*` 但没装层会 503 | `server/index.ts:12670-12677`、`server/enterprise.ts:108-110`、`server/enterprise.ts:193-195` | 只核实，保留（不可动）；OSS 降级按删 `enterprise/` 的合法路径处理 |
| 4 | G-28 | 高 | 100 个 bot 的硬上限会阻断多 bot 工作区，且普通创建接口也检查 | `server/index.ts:1829`、`server/routes/bots-create.ts:188` | 改成可配置，默认保持 100 |
| 5 | G-30 | 中高 | 每 bot 16 个并发线程是硬上限，重并发用户会排队；内存小的时候默认还会降到 3 | `server/bot-thread-limits.ts:6`、`server/bot-thread-limits.ts:16-17` | 提高硬上限并做成配置 |
| 6 | G-35 | 中高 | 附件库默认只有 512MB，满了 507 且不自动淘汰；长对话和截图场景很快撞到 | `server/attachments.ts:24-33` | 默认提高，或加自动清理策略 |
| 7 | G-33 | 中高 | 每天 50 张图是写死的，重启不清零；设计和批量出图用户会直接卡住 | `server/image-daily-cap.ts:9`、`server/image-daily-cap.ts:24-25` | 改成配置项，默认保持或提高 |
| 8 | G-36、G-37 | 中 | 128 个工具和 20 个 MCP server 会限制复杂工具栈；超出的工具只能搜索，不报错但行为变化 | `shared/tool-budget.ts:2`、`server/mcp-registry.ts:79` | 工具数保留上游限制，MCP server 数改可配置 |
| 9 | G-43、G-44 | 中 | 房间每回合 3 条、每分钟 10 条、无人类回应 2 条就停；多 bot 协作很容易撞到 | `server/index.ts:1630`、`server/index.ts:14024`、`server/room-post-budget.ts:26-32` | 把阈值做成配置，保留循环熔断 |
| 10 | G-60、G-61 | 中 | 电脑共享、Claude 用户 MCP/技能、技能评审、并行房间、工具桥默认关，且部分没有 UI 开关；用户会以为功能不存在 | `server/config.ts:237-264` | 默认放开低风险项，至少补设置入口 |

## 清理建议的边界

- **可以做**：把 G-01、G-03、G-28、G-30 至 G-35、G-37 至 G-59 中写死的数字改成配置；把默认关闭但低风险的功能（G-60 至 G-62）默认放开或补 UI；把 G-07 的邮箱登录默认改为本地 SMTP。
- **只做文档或保留**：G-02、G-04、G-05 的鉴权边界；G-09 的登录锁定；G-63 的安全地板；G-66 的驱动能力差异；G-67、G-68 的可选远程检查。
- **不可动**：G-10 至 G-26。这里包括 enterprise 层、`EAC_LICENSE_KEY`、Starter 计划、Bot API 计划、公司模型、企业策略和 Cloud 试用额度。删 `enterprise/` 让产品合法降级为 OSS 是允许的产品决策；保留代码去绕过 key 不是。

## 覆盖范围与待补

**已覆盖：**

- 登录与账号门：回环绑定、远程会话、浏览器登录、service/client 两种信任、邮箱验证码、hosted 门户登录、会话有效期和锁定。
- 订阅与许可门：`entitlement()`、`EAC_LICENSE_KEY`、admin/billing/budgets/whitelabel、Starter 计划、Bot API 计划、公司模型、企业策略、Cloud 试用额度。
- 模型/provider：确认自建没有全局模型白名单；列出托管公司模型白名单、企业 `allowedEngines`、驱动能力位三类真实限制。
- 硬配额：bot 数、线程并发、附件、图片、工具数、MCP server、邮箱、手机、团队成员、本地 VM、房间发言、上下文消息数、token/字符上限。
- 超时：房间回合、MCP 调用、协调树、浏览器动作、模型回复、ACP 静默、Webhook。
- feature flag 与远程开关：`config.json.features` 的默认关闭项、插件进程开关、Team Cloud 规则、托管模型策略、公告源和更新检查。
- 云依赖：邮箱验证码控制面、Cloud 文件同步、Cloud 试用额度、Cloud 计划层级。

**待补（不影响本初版可用性）：**

- 未逐条打开 `server/` 下全部 1478 个文件；本报告按关键词命中和关键入口取证，可能仍有零散的数字上限未收录。
- 未完整展开 `server/request-auth.ts` 的 client scope 全表；G-05 只证明“默认拒绝 + 显式 allowlist”这一机制，没有逐路由列出成员能做什么。
- 未逐个驱动列出 `contracts.ts` 能力位矩阵；G-66 只说明机制，具体哪个模型缺浏览器、图片或 steer 需另做驱动表。
- 未核对 provider 自身的外部配额（Claude、Codex、Copilot 等账号限额）；这些不是 EACbot 代码里的门，但会表现为“用不了”。
- 未实测、未编译、未启动服务；本文所有“会怎样”来自代码分支和错误文案，不等于运行验证。
- 未覆盖前端、Electron 壳和 `shared/` 中纯展示层的限制；范围按任务要求限定在后端能力门。
- Admin 下发的实际计划值、企业策略值和 `config.json` 现有值不在仓库里，无法给出“这台机器当前是否已被限制”的结论。

本轮只读，未编译、未跑测试、未联网；行号按当前 `codex/clean-core` 工作树，落地时按符号名复核。
