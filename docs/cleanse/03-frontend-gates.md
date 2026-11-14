# 03 前端门审计（初版）

审计对象：D:\workspace\EACbot-clean-core，分支 codex/clean-core，基线 781c57e。只读审计，未改代码。

总体判断：任务背景给的入口是 148 个 entitlement 类文件和 230 个 sign-in/登录类文件；本次 rg 把 electron/ 也计入，得到 150 和 238 个文件。绝大多数只是把后端已经作出的决定显示出来，后端放行后前端会自动跟着放行；真正需要改前端的 B 类硬门不多，但其中“首次运行强制创建 Chief”“桌面端隐藏 People/Activity 设置”“过期 Cloud 不能从应用内重新订阅”会实际改变用户能否完成操作。登录墙、企业 Workspaces、预算/价格、Bot 数量上限、云电脑入口这些看起来像前端的门，实际都在后端有对应拒绝点，应该先改后端策略，不要先改前端。

## 一、已确认的门

| 编号 | 文件:行 | 拦住什么 | A类还是B类 | 判断依据（为什么是B类） | 建议改法 |
|---|---|---|---|---|---|
| F01 | src/main.tsx:45-49；server/request-auth.ts:619-643；server/index.ts:12825-12831 | 未登录/未被信任的浏览器进入主应用，只显示 PairPage | A | 前端读取 /api/auth/session 的 401/403 才显示登录页；服务端在 request-auth 中按 loopback、cookie/session 和 scope 拒绝。后端改成放行后，readSessionState 会返回 loopback/session，main.tsx 自动进入 App。 | 不改前端；若目标是无登录使用，改后端认证策略和本地信任模型。保留 PairPage 作为可选登录页。 |
| F02 | src/main.tsx:52-54；server/request-auth.ts:623-636 | loopback 为 service trust 时仍要求配对/登录 | A | 前端只检查服务端返回的 session.trust === "service"；这是服务端对共享服务器/Cloud home 的信任判定。 | 不改前端；若自托管单机要免登录，改服务端 loopback 信任，不要删 PairPage。 |
| F03 | src/components/app/AppFrame.tsx:67-69；src/components/app/AppMessage.tsx:179-193；server/chat-apps-mcp.ts:243-258 | 内嵌 App 在 signed-out/server-removed/apps-off 时不可用，只显示登录或说明 | A | 前端消费服务端返回的 blocked.reason；server/chat-apps-mcp.ts 明确生成 signed-out 等原因。 | 不改前端；需要放开时改服务端 App 访问判定。 |
| F04 | src/components/WorkspacesSection.tsx:27-29；server/routes/status.ts:82-86 | 企业版 Settings → Workspaces 入口和 /api/fleet | A | 前端要求 config.edition.features 包含 admin 且 fleet.available；后端 /api/fleet 直接要求 entitled("admin")，否则 403。 | 不改前端；若 OSS 要开放 fleet，改后端 entitlement 和 fleet 配置。 |
| F05 | src/components/UsageBudget.tsx:25-27,195-199；server/spend.ts:80-81；server/index.ts:1368 | 企业版预算卡、售价表 | A | 前端仅在 features 含 budgets/billing 时渲染；后端 spendState 仅在 budgets entitlement 下计算上限，价格列表也仅在 billing entitlement 下返回。 | 不改前端；要开放就改后端 entitled("budgets"/"billing") 和配置校验。 |
| F06 | src/lib/bot-limit.ts:23-32；src/lib/new-bot.ts:8；server/routes/bots-create.ts:192；server/host/starter-bot-limit.ts:30-39 | Starter 计划的 Bot 数量上限、创建前弹升级框 | A | 前端用的是 config.botLimit，并且创建请求最终由 bots-create.ts 的 botLimit.refusal() 拒绝；后端限制解除后 config 和请求都会通过。 | 不改前端；要放开就改 Cloud plan tier / botLimit 来源。 |
| F07 | shared/place-view.ts:331-334；src/components/ComputerPanel.tsx:1107-1119；server/routes/computers.ts:164,177 | 云电脑入口在选择 Cloud 时被标成 needs key / on-my-cloud / 不可用 | A | 前端的 plan 只决定文案和是否提示“用 Cloud 计划”；真正能否启动取决于服务端 Boat 配置和 acknowledgeCost，服务端不读取 EAC enterprise edition。 | 不改前端；清理 Boat/Cloud 商业依赖时改后端路由和配置。 |
| F08 | electron/included-x.mjs:14-16；electron/cloud-account.mjs:953 | X research 的 included relay 仅在 Cloud 账户 active paid plan 时同步 | A | 前端/Electron 只读后端 verified entitlement；服务端不发放 relay token 时前端就没有可用能力。 | 不改前端；若要 OSS 使用 X research，改服务端的 included service 授权。 |
| F09 | src/components/CompanyBackupSettings.tsx:26-48；electron/main.mjs:1039 | 企业云备份入口和上传 | A | 前端要求 organization bridge 且 connection.cloudBackups；Electron 主进程在 cloudBackups 为 false 时直接拒绝。 | 不改前端；要开放就改 managed desktop/Admin 能力。 |
| F10 | src/lib/cloud-guest.ts:11-14；src/components/ChatView.tsx:1278-1293 | Cloud guest 只能在 openedThreads 内发言 | A | 前端读取服务端 session 的 cloudGuest/openedThreads；不是本地写死。服务端会话变更后，useCanWriteIn 自动变化。 | 不改前端；要放宽就改服务端 cloud guest 会话模型。 |
| F11 | src/lib/cloud-plan.ts:37-45；src/components/CloudAccountSettings.tsx:259-305 | Cloud 账户的 paid/free/attention/reauth 状态与登录/管理入口 | A | 前端只把服务端 entitlement/status 映射成文案和按钮；登录动作走 Electron cloud-account 的 begin()，不是前端放行。 | 不改前端；要改商业策略就改 Cloud 账户服务端。 |
| F12 | src/components/PublishedPageCard.tsx:12-18,65-69；server/pages/client.ts:100 | 发布页数量上限，达到上限只显示 upgrade | A | 卡片数据来自服务端返回的 usage.limit/plan；server/pages/client.ts 从 Admin 的 minted limits 生成 limit 和 upgrade 标志。 | 不改前端；要取消页数限制就改 pages 服务端配额。 |
| F13 | src/lib/use-owner-or-admin.ts:25-35；server/request-auth.ts:62-65 | 非 owner/admin 被隐藏的团队、设置、密钥等管理操作 | A | 前端用后端 session scopes 推导 ownerOrAdmin；request-auth.ts 也按 scopes 判 ownerOrAdmin。 | 不改前端；改服务端 scope 模型。 |
| F14 | src/components/SettingsModal.tsx:200-204；src/components/CloudAddDialog.tsx:267 | 远端页面/没有 Electron bridge 时隐藏大部分设置、Cloud 购买 sheet | A（宿主能力） | 这些检查针对 window.ogb / remoteClient，即宿主是否提供 Electron IPC；不是企业 entitlement。后端没有对应 API 时前端也不应假装可用。 | 不改前端；若要在浏览器提供这些能力，先做服务端 API 和宿主能力，不要只删检查。 |

## 二、已确认需要改前端的 B 类

| 编号 | 文件:行 | 拦住什么 | A类还是B类 | 判断依据（为什么是B类） | 建议改法 |
|---|---|---|---|---|---|
| B01 | src/components/onboarding/WelcomeFlow.tsx:109-120,155-167；src/components/onboarding/ChiefIntro.tsx:184-193 | 首次运行强制完成 Chief 选择/创建，不能直接进入聊天 | B | MeetScreen 有 Setup later（src/components/onboarding/MeetScreen.tsx:113-117），但 toChief 为真时 WelcomeFlow 直接进入 Chief 步骤；ChiefIntro 只有 Choose/Create，没有 Skip/Escape 结束；WelcomeGate 在 welcomeDue 时以 fixed inset-0 全屏挂载（src/components/onboarding/WelcomeGate.tsx:73-84）。后端 onboarding 只是记录，不要求先有 Chief。 | 在 ChiefIntro 增加 Skip/Later（写入 onboarding 完成或仅记 dismissed），或让 WelcomeFlow 的 finish 可在 Chief 步骤直接完成；保留创建 Chief 的推荐路径。 |
| B02 | src/components/SettingsModal.tsx:205 | 桌面端隐藏 Settings → People（成员/会话管理） | B | 条件是 !window.ogb && cloudHome !== true；只要在桌面 App（window.ogb 存在）就隐藏。后端 /api/auth/sessions 在 server/index.ts:12941-12942 对 owner 仍可用，PeopleSection 也调用该接口（src/components/PeopleSection.tsx:202）。 | 把 People 从“仅浏览器”改为“owner/admin 可用”，或在桌面端提供等价的本地成员/会话入口。 |
| B03 | src/components/SettingsModal.tsx:206 | 桌面端隐藏 Settings → Activity（审计/变更记录） | B | 条件是 !window.ogb && ownerOrAdmin === true；桌面 owner 也满足 ownerOrAdmin，却因 window.ogb 被隐藏。后端 /api/admin-activity 在 server/routes/status.ts:182-212 正常提供数据，ActivitySection 在 src/components/ActivitySection.tsx:67 直接读取。 | 改成 owner/admin 即可，不再排除桌面；保留服务端权限校验。 |
| B04 | src/lib/cloud-plan.ts:48-50；src/components/CloudAccountSettings.tsx:268；src/lib/cloud-plan.ts:334-341,360 | 已过期/欠费（attention）或某些非 free 状态不能从应用内重新订阅/重新购买 | B | buyOfferAllowed 只允许 signed-out/free；CloudAccountSettings 的 addCloudButton 因此不渲染；cloudAddView 对 attention 走 default settings，不进入 offer。Electron 的 openCheckout 只要求 connected 和 signed-in（electron/cloud-account.mjs:423-431），并不要求 entitlement.active。 | 允许 attention/reauth 等状态进入 offer 或至少提供“重新订阅/恢复购买”按钮；保留服务端 checkout 的最终拒绝。 |

## 三、尚未定级、需补后端证据的 B 类候选

以下三条的前端条件已经确认是硬编码，但还没有把对应后端路由完整核对，先不计入最终 A/B 数量。

| 编号 | 文件:行 | 拦住什么 | 现状 | 待补证据/建议 |
|---|---|---|---|---|
| P01 | src/components/BotSettingsDialog.tsx:64 | 桌面端和团队中隐藏 Bot → Visibility | 条件是 entry.id !== visibility || (!window.ogb && ownerOrAdmin === true && !teamName)，桌面 owner 看不到。 | 核对 /api/bots/:id 的 visibility 更新权限；若后端允许 owner，改为 owner 可编辑。 |
| P02 | src/components/CloudKeepHere.tsx:16 | Simple 模式隐藏“Keep this computer's bots here”开关 | 条件是 advanced && bridge && read && write；Simple 模式直接不渲染。 | 核对 Cloud send/keepHere 后端接口；若只是界面简化，给 Simple 一个只读状态或入口。 |
| P03 | src/components/CloudAddDialog.tsx:267；src/components/CloudAccountSettings.tsx:251-256 | 没有 Electron bridge 时不能打开 Cloud 购买/账户 sheet，只显示 desktopOnly | Cloud sheet 要求 bridge 和 request；Cloud account 在没有 bridge 时只显示 desktopOnly。 | 如果目标包含浏览器/自托管购买，需要服务端 Cloud API 和网页入口；若 Cloud 明确桌面专属，保持并写入边界。 |

## 四、非门、但和“限制/上报”有关的确认项

这些不应该算进 A/B 门，但审计时要明确写出来，避免误删正常展示。

1. 试用横幅与倒计时是显示层：src/lib/cloud-plan.ts:95-120 只是把 trial.endsAt/trial.state 变成文案；src/components/CloudTrialNotice.tsx:34-50 只渲染卡片；src/components/AppNotices.tsx:282-285 只负责打开/关闭。没有“不订阅就禁止聊天”的本地判断。

2. 升级卡/用量条是显示层：src/components/CloudUsageMeter.tsx:151-193 只展示 usage 和服务端给的 upgrades；src/components/CloudRoomCard.tsx:76-105 只在 snapshot.status === paid 时读 room/usage；都不直接改 API 权限。

3. 许可证到期提示是显示层：src/components/LicenseExpiryBanner.tsx:9-17 读取 config.edition.license；没有隐藏功能或阻断操作。

4. Cloud 欢迎/首次设置大多可跳过：src/components/cloud-welcome/CloudWelcome.tsx:194-197 有 Skip；src/components/CloudIntent.tsx:96-100 有 skip；src/components/CloudSetup.tsx:141-145 可隐藏。CloudWelcome 的 done 页（src/components/cloud-welcome/WelcomeSteps.tsx:90-104）只有 Say hi / Give job 两个结束动作，属于正常收尾，不是商业门。

5. 前端埋点默认开启，服务端不能关：src/lib/analytics.ts:21-29 在 localStorage 没有 opt-out 时返回 true；src/App.tsx:466-469 调用 initAnalytics；src/lib/usage-snapshot.ts:222-240 每日发送 app_snapshot；同文件 137-156 上报 edition、cloud_plan、cloud_trial、org_managed、phones_paired 等。src/lib/analytics.ts:9-10 的 opt-out 只在本地存储/desktop 偏好。它不是“拦人”的门，但如果清洗目标是隐私/后门，这一项必须单独决策：默认关闭，或由服务端配置明确禁用。当前未改。

6. 地区限制：在 src/ 和 electron/ 中没有找到按国家/地区/geo 拒绝功能的逻辑；命中的 region 主要是 URL/aria/drag-region 和 CSS。没有可报告的“地区门”。

7. 模型、MCP、网站登录不是产品门：src/components/LoginForm.tsx、src/components/DeviceSignIn.tsx、src/components/McpServersPanel.tsx 等处理的是上游服务自己的授权；后端无法代替这些服务放行，不应按产品登录墙清洗。

## 五、A/B 统计与优先级

已确认 A 类：14 条（F01-F14）。

已确认 B 类：4 条（B01-B04）。

待补的 B 类候选：3 条（P01-P03），未计入上面数字。

B 类按优先级：

1. B01 首次运行强制 Chief（直接阻止第一次进入聊天，影响所有新安装）。
2. B04 过期 Cloud 不能应用内重新订阅（商业恢复路径被前端切断；后端 checkout 本身允许 connected 账户）。
3. B02 桌面端 People 被隐藏（owner 无法管理成员/会话，后端接口存在）。
4. B03 桌面端 Activity 被隐藏（owner 无法查看审计记录，后端接口存在）。
5. P01 桌面端 Bot Visibility 被隐藏（待补后端证据）。
6. P02 Simple 模式 Keep here 被隐藏（待补后端证据）。
7. P03 无 Electron bridge 时 Cloud 购买/账户 sheet 不可用（平台边界，待确认是否产品要求）。

## 六、覆盖范围与未覆盖范围

已覆盖：

- src/main.tsx、src/App.tsx 的启动/登录/首次运行分流。
- SettingsModal、WelcomeGate、WelcomeFlow、ChiefIntro、CloudAccountSettings、CloudAddDialog、CloudUsageMeter、CloudRoomCard、BotLimitPopup、UsageBudget、WorkspacesSection、CompanyBackupSettings、PeopleSection、ActivitySection、BotSettingsDialog、CloudKeepHere 等门相关组件。
- server/request-auth.ts、server/index.ts 的 session/auth 入口，server/routes/status.ts 的 fleet/activity，server/spend.ts 的 budgets，server/routes/bots-create.ts 与 starter-bot-limit.ts 的 Bot 上限，server/routes/computers.ts 的云电脑，electron/cloud-account.mjs、included-x.mjs、main.mjs 的 Cloud 能力。
- 关键词入口数量：entitlement 类 150 个文件，sign-in 类 238 个文件（本次 rg 计数）；这些数字只作为入口，没有把全部文件逐行读完。

未覆盖/待补：

- 没有把 1835 个 src ts/tsx 和整个 electron/ 逐文件读完；P01-P03 的后端路由证据未补齐。
- 未逐一核对所有 provider 登录、MCP OAuth、浏览器站点登录；按设计这些不算产品门，但其中是否有被误包装成“产品登录”的入口，仍需后续抽查。
- 未运行 typecheck、测试或启动验证；本报告只基于静态代码证据。
- 未检查 Cloud 购买后端的 Admin 服务本身，只检查了本仓库 Electron/前端调用面。

## 七、结论

先不要动 A 类门。F01-F14 的共同点是：后端已经有拒绝点，前端只是显示；先删前端会制造“看起来能用、请求仍失败”的假修复，甚至破坏登录/Cloud/企业版的安全边界。

真正应先改的 B 类是 B01-B04；P01-P03 需要补后端证据后再决定。前端埋点默认开启是另一条独立问题，建议单独立项，不和“门”混在一张改动里。

