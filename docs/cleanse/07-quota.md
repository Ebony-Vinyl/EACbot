# 07 配额与上限审计

采集日期：2026-11-14  
仓库：D:\workspace\EACbot-clean-core  
分支：codex/clean-core  
审计基线：781c57e9a6fbf0f504704d358f4c82a1860490c2（短哈希 781c57e；当前工作树已含主线程未提交的 limits 改动）

## 一、审计范围、方法与前提

**范围。** 核心文件是 server/engine-limits.ts、server/limit-notices.ts、server/limit-failover.ts、server/limit-resets.ts、server/bot-thread-limits.ts、server/tool-budgets.ts、server/harness-budget.ts、server/context-budget.ts、server/image-daily-cap.ts、server/room-post-budget.ts、server/thread-retention.ts、server/tool-count-limit.ts、server/mcp-result-budget.ts、server/container-limits.ts。为追到实际拦截点，还读了 server/config.ts、server/index.ts、server/limits.ts、server/routes/image-tools.ts、server/routes/engine-limits.ts、server/routes/limit-resets.ts、server/routes/bots-create.ts、server/routes/bot-patch.ts、server/host/start-upkeep.ts、server/thread-log-rotation.ts、server/mcp-gate-config.ts、server/mcp-trim.ts、server/mcp-shape.ts、server/harness-mcp-request.ts、server/host/starter-bot-limit.ts、server/host/cloud-plan-tier.ts、server/quota-switch.ts、server/spend.ts、server/attachments.ts、server/mcp-registry.ts、server/container-computer.ts、server/vps-computer.ts。

**方法。** 只做静态只读审计：用 rg -n 定位符号，用带行号的 Get-Content 逐段核对，按“定义常量、配置 schema、调用点、拒绝/截断/删除动作”追链路。没有修改源码、配置、依赖，没有 git add、commit、push，也没有访问 D:\workspace\EACbot 原件。本报告只新建 docs/cleanse/07-quota.md。

**审计期间源码发生了并行变化。** 第一次采集后，主线程在 2026-11-14 12:21 到 12:22 新增了 server/limits.ts，并修改了 server/config.ts、server/bot-thread-limits.ts、server/image-daily-cap.ts、server/room-post-budget.ts、server/tool-count-limit.ts、server/routes/bots-create.ts、server/routes/bot-patch.ts、server/attachments.ts、server/mcp-registry.ts 等文件。**本报告以下所有行号和结论都以这轮并行修改后的当前工作树为准。** 这轮修改新增了 config.json 的 limits 配置块，使图片日上限、线程上限、房间发言速率、工具数、MCP server 数、附件库字节上限等从硬编码变成可配置；同时也出现了“配置键已声明但调用点未接线”的半成品，详见第二节和第四节。

**重要前提：未编译、未跑测试。** 按任务要求，本报告不把任何编译、类型检查、测试结果当作证据。00-baseline.md 记录“node_modules 缺失、BLOCKED”，但 08-evidence-audit.md:13 已指出依赖后来被其它小组安装；本次只做 Test-Path 也只读检查，结果显示根 node_modules、tsc.cmd、vitest.cmd 均存在。这个事实与本报告结论无关，本报告仍然没有运行 pnpm install、pnpm typecheck、pnpm build 或测试。

**工作树。** 当前 git status --short 已有主线程的多项未提交修改（包括 server/config.ts、server/bot-thread-limits.ts、server/image-daily-cap.ts、server/room-post-budget.ts、server/tool-count-limit.ts、server/attachments.ts、server/mcp-registry.ts、server/routes/bots-create.ts、server/routes/bot-patch.ts、src 下的若干文件）以及新增的 server/limits.ts。本报告的配额相关引用都在这些文件里；因此这不是冻结快照，合并前应重新核对行号。

**证据口径。** 文中 文件:行 都是 EACbot-clean-core 当前文件。一个机制有多处证据时列 2 到 3 个关键位置。推断会明确标“推断”。没有证据的猜测不写进表格。

**许可证边界。** 本报告不建议绕过 enterprise 许可、修改 key、伪造 entitlement。允许的产品决策只有两种：保留商业边界，或删掉 enterprise/ 目录、让产品合法降级为 OSS；降级后 budgets、Starter 计划、白标、托管工作区等 entitlement 会一起失效，这是功能降级，不是绕过。商业项在表中标为“商业许可”，不建议“删除”。

## 二、与 02 的交叉校验，以及本轮新增的 limits 配置

docs/cleanse/02-backend-gates.md 已经用 G-28 到 G-57 覆盖了 bot 数、线程、附件、图片、工具数、MCP 结果、房间发言、房间超时、MCP 调用超时、上下文 40 条和 128k 默认值等门。本节只写它与当前代码的差异，以及 12:21 之后新增的 limits 配置；不重复 02 的总表。

| 02 编号 | 02 的写法 | 当前代码实际 | 判断 |
|---|---|---|---|
| G-30 | “每个 bot 最多 16 个并发线程……超出排队”（docs/cleanse/02-backend-gates.md:44） | 人员发消息的正常路径可能先排队并返回 202（server/index.ts:7197-7203、server/routes/bot-messages.ts:332-340）；startTurn 的直接入口在容量已满时抛 409 thread_limit（server/index.ts:7630-7631）。另外 16 已不是硬上限：threads.maxConcurrentPerBot 和 limits.botThreads 都可到 1024（server/config.ts:305-311、:325-336）。 | **与 02 的 G-30 不一致。** 应写成“人员路径可排队；直接启动 409；16 只是默认，配置上限 1024”。 |
| G-33 | “第 51 张拒绝，次日重置；计数落盘，重启不清零”（docs/cleanse/02-backend-gates.md:47） | 50 是默认值，不再是硬编码；limits.imagesPerDay 可改，范围 1 到 1,000,000，通过 saveConfig 保存后动态读取，无需重启（server/image-daily-cap.ts:30-31、server/config.ts:325-336、:1059）。按本地自然日，重启不清零；写盘失败只告警（server/image-daily-cap.ts:32-56）。 | **需更新。** 不是“写死 50”，而是“默认 50、可配置”。 |
| G-43/G-44 | “每回合 3 条、每条 4000 字；每分钟 10 条、无人回应 2 条、熔断 5 分钟”（docs/cleanse/02-backend-gates.md:57-58） | 每分钟、无人回应、熔断分钟已经可配置（server/room-post-budget.ts:57-65）；每回合 3 条虽然新增了 limits.roomPostsPerTurn（server/room-post-budget.ts:36-40），但 server/index.ts 仍使用硬编码 MAX_ROOM_POSTS_PER_TURN=3（server/index.ts:1630、:14024-14025）。4000 字也仍硬编码（server/index.ts:9659）。 | **部分不一致。** 三个速率已可配，每回合 3 条和 4000 字仍是硬编码；roomPostsPerTurn 是“已声明未接线”。 |
| G-47 | “房间回合 5 分钟无进展即停，最多可配 1440 分钟”（docs/cleanse/02-backend-gates.md:61） | 普通无进展确实是 5 分钟（server/config.ts:45-47、server/index.ts:10312-10329）；但只要有工具在运行，静默上限会取 max(配置分钟, 60 分钟)（server/room-turn-timeout.ts:51-55、:127-129）。 | **不完整。** 不是所有场景都 5 分钟；长工具调用可静默 60 分钟。 |
| G-57 | “未知模型上下文默认 128k……大窗口模型可能被过早压缩”（docs/cleanse/02-backend-gates.md:71） | 128000 是未知模型的兜底（server/context-budget.ts:4、:12）。大窗口会被过早压缩；小窗口则可能在实际窗口更小时仍按 128k 估算，反而有溢出风险。 | **需补充。** 两个方向的风险都要写。 |

01 的 egress 只把图片生成列为用户配置 provider 后的外连（docs/cleanse/01-backend-egress.md:59），没有额外的配额结论；03 的 F05/F06 明确 budgets 和 Starter 上限由后端决定、前端只显示（docs/cleanse/03-frontend-gates.md:15-16），与本报告的“商业边界只保留、不绕过”一致。

**新增的 limits 配置块。** server/limits.ts:10-31 定义了 10 个可调项，server/config.ts:325-336 给出范围和正数校验，server/config.ts:820 与 :1059 在 loadConfig/saveConfig 后把值镜像到进程内。除 attachmentsMaxBytes 还有 EAC_ATTACHMENTS_MAX_BYTES 优先外，其余键只来自 config.json；缺省值保持旧行为。注意注释写“raise”，但 schema 和 positiveLimit 允许降低，只要仍是正整数。

| limits 键 | 范围 | 缺省 | 当前接线情况 |
|---|---:|---:|---|
| botsPerWorkspace | 1 到 100,000 | 100 | 普通 /api/bots 创建和 bot-patch 的 peers 使用 maxBotsPerWorkspace（server/routes/bots-create.ts:188-190、server/routes/bot-patch.ts:557）；server/index.ts 的内部 create-bot 和 teamSetup 仍用 MAX_WORKSPACE_BOTS=100（server/index.ts:9318、:14214-14215、:14253）。**部分接线。** |
| botThreads | 1 到 1024 | 16 | 只在 threads.maxConcurrentPerBot 未设置时作为默认线程数的上限（server/bot-thread-limits.ts:17-33）。设置 threads.maxConcurrentPerBot 时后者优先。 |
| attachmentsMaxBytes | 1 到 1,073,741,824 | 512MB；Cloud home/team 8GB | server/attachments.ts:31-39 读取；环境变量 EAC_ATTACHMENTS_MAX_BYTES 优先于配置。 |
| imagesPerDay | 1 到 1,000,000 | 50 | 图片日上限每次 reserve 动态读取（server/image-daily-cap.ts:30-44）。**已接线。** |
| chatToolsPerRequest | 1 到 10,000 | 128 | chatToolLimitFor 动态读取（server/tool-count-limit.ts:127-134）。**已接线。** 设得太高时仍可能被 provider 拒绝，再由 learned limit 重试。 |
| mcpServers | 1 到 10,000 | 20 | maxMcpServers 动态读取（server/mcp-registry.ts:80-83）。**已接线。** |
| roomPostsPerTurn | 1 到 1,000 | 3 | 只在 room-post-budget.ts:36-40 导出；server/index.ts 仍用 MAX_ROOM_POSTS_PER_TURN=3（server/index.ts:1630、:14024）。**已声明未接线。** |
| roomPostsPerMinute | 1 到 1,000 | 10 | decideRoomPost 默认参数读取 roomPostLimits（server/room-post-budget.ts:57-65、:123-124）。**已接线。** |
| roomPostsWithoutReply | 0 到 1,000 | 2 | 0 表示拒绝所有无人回应的 bot 帖子；nonNegative 允许 0（server/room-post-budget.ts:54-65、:133）。**已接线。** |
| roomBreakerMinutes | 1 到 1,440 | 5 | 转成毫秒，同时把 posts 的 retentionMs 拉长到至少这个值（server/room-post-budget.ts:57-64）。**已接线。** |

## 三、直接回答

### 1）每个上限的数值、单位、位置、默认值、可配置性

完整逐条清单在第四节主表。这里先按模块给出速查结论；每一条的配置键、范围、默认值和证据行都在表里。

- **engine-limits**：它本身不是配额，是把引擎账户的已用百分比、重置时间和检查时间读给机器人看。只列 claudeAgent、codex、grokAgent 三类账户；按量计费（metered）账户一律显示 unsupported。没有数值上限，也没有拒绝动作（server/engine-limits.ts:38-41、:97-105）。
- **limit-resets、limit-notices、limit-failover**：配额轮询 5 分钟；没有重置时间的限额先按住 1 小时；同一 bot 同一引擎的“已通知”状态最长 3 小时；自动回切的未知重置等待 1 小时；回切记录最多 500 条。前三个状态都落盘（server/limit-resets.ts:11-15、server/limit-notices.ts:13-14、server/limit-failover.ts:70-71、:116）。
- **bot-thread-limits**：默认并发线程上限 16；未启用 Cloud 内存门时默认 min(16, max(3, round(总内存/2GiB)))；threads.maxConcurrentPerBot 和 limits.botThreads 都可配到 1024；Starter Cloud 强制 1，Starter 的“子线程”仍放行到 16（server/bot-thread-limits.ts:8-39、server/config.ts:305-311、:325-336）。
- **tool-budgets 与 tool-count-limit**：Chat Completions 单请求默认最多 128 个工具，limits.chatToolsPerRequest 可配 1 到 10,000；每个 MCP server 最多列 2000 个工具、最多翻 100 页；工具目录只占 3 个工具位；工具 schema 64KB、整个目录 1MB；MCP 帧 2MB（电脑模式 32MB）、最多 10000 帧、单结果输出 50KB。工具预算元数据最多记 1000 个 bot，学到的模型工具上限最多记 500 个 key（shared/tool-budget.ts:2、server/drivers/chat-mcp-tools.ts:66-77、server/tool-budgets.ts:3-11、server/tool-count-limit.ts:83）。
- **harness-budget**：浏览器、数据等普通调用 120 秒；stdio 代理等 130 秒；手机设备调用 705 秒；云电脑复制 540 秒、代理 550 秒。全部是毫秒常量，没有配置项（server/harness-budget.ts:2-18）。
- **context-budget**：未知模型按 128000 tokens 估算；自动压缩默认在窗口 80% 触发，硬顶窗口 90%、引擎原生压缩点的 90%；重建提示默认 24000 bytes、最多 40 条消息；房间会话默认 90% 重置。压缩是“摘要折叠”，不删除 SQLite 原始消息（server/context-budget.ts:4、:21-25、server/context-rebuild.ts:156、:193、server/room-context.ts:6）。
- **image-daily-cap**：默认每个安装每天 50 张，limits.imagesPerDay 可配 1 到 1,000,000；按进程本地自然日，计数写 image-generation-day.json，重启不清零；通过 saveConfig 保存后动态读取，下一次生成生效，手改文件则要等 loadConfig（server/image-daily-cap.ts:30-44、server/config.ts:325-336、:1059）。单回合另有默认 4 张、范围 1 到 10 的 imageGen.maxPerTurn（shared/image-generation.ts:5、server/image-generation-config.ts:12-15）。
- **room-post-budget**：同一 bot 60 秒默认最多 10 条，limits.roomPostsPerMinute 可配 1 到 1,000；同一 bot 完全相同文本 60 秒内拒绝；120 秒内三个 bot 形成“首尾相同”的四人环就熔断，默认 5 分钟，limits.roomBreakerMinutes 可配 1 到 1440；5 分钟内无人回复的 bot 帖子默认达到 2 条就停，limits.roomPostsWithoutReply 可配 0 到 1,000。每回合 3 条和单条 4000 字仍是硬编码（server/room-post-budget.ts:28-65、server/index.ts:1630、:9659）。
- **thread-retention**：只配置后才启用。threads.eventLogRetentionDays 范围 1 到 3650 天，未设置时永不扫描；threads.eventLogMaxBytes 范围 256KB 到 4GB，未设置时不限。前者每天扫一次并删除空闲 thread 的 events/ 和 native/ NDJSON；后者在追加后超过上限时把每个日志裁到“最新一半”。**这两项会删日志，但不删 SQLite 会话记录**（server/thread-retention.ts:1、:22-47、server/config.ts:305-311、:649-655、server/thread-log-rotation.ts:18-27）。
- **mcp-result-budget**：单个工具结果默认只放 8000 字符进上下文；最小 512；0 表示不截断；每个 MCP server 可配 0 到 2,000,000 字符；环境变量 EAC_MCP_RESULT_BUDGET 只要求有限且不小于 0，没有上限校验（server/mcp-trim.ts:1、:5、server/mcp-gate-config.ts:23-40、server/mcp-registry.ts:89-94）。
- **container-limits**：托管桌面容器 PIDS_LIMIT=4096，旧容器若正好是 512 会尝试原地升到 4096；内存 4GB、swap 4GB、CPU 2 核是另外写死的创建参数（server/container-limits.ts:3-18、server/container-computer.ts:852-878、server/vps-computer.ts:852-858）。
- **config.ts 与 index.ts 的相邻上限**：每回合 10 个附件、5 个新线程、4 个新 bot、bot 指令 4000 字、workspace 100 个 bot；月度花费上限只在 budgets entitlement 下生效（server/index.ts:1629-1632、:7387、:1829、server/spend.ts:80-111）。

### 2）触发后的行为：拒绝、截断、排队、降级、静默丢弃还是抛错

**拒绝请求并返回 HTTP 状态码的：**

- 图片日上限、单回合图片上限：工具调用返回 429；提示“今天已经 N 张”或“本回合已经有 N 张”（server/routes/image-tools.ts:59-61、:78）。
- 房间每回合 3 条、房间限速/重复/环/升级：返回 429；单条超过 4000 字返回 400（server/index.ts:14024-14030、:14055-14058、:14082-14084）。
- 附件 10 个、开线程 5 个、建 bot 4 个：返回 429；workspace 100 个 bot 返回 409（server/index.ts:13381、:13756-13757、:14211-14215、server/routes/bots-create.ts:188-190）。
- bot 并发线程：直接启动路径返回 409，错误码 thread_limit；人员发消息路径可以先排队并返回 202（server/index.ts:7630-7631、:7197-7203、server/routes/bot-messages.ts:332-340）。
- 月度花费上限：返回 409，错误码 spend_cap（server/index.ts:7232-7236、server/spend.ts:100-111）。
- 房间发言长度、bot 指令长度：返回 400（server/index.ts:14027-14030、:14228-14229）。

**排队而不是直接拒绝的：**

- 人员发给 bot 的消息在 thread 忙或 bot 达到并发线程上限时，startOrQueueDirectMessage 会排队，HTTP 仍可返回 202 receipt；排队位置由队列逻辑返回（server/index.ts:7197-7213、server/routes/bot-messages.ts:332-340）。Starter 的 1 线程限制同样可能在人员路径上表现为排队。

**截断或降级的：**

- 工具数量超过当前上限：MCP server 的工具被裁到各自份额，放不下的 server 改走工具搜索；已经列出的调用仍然可用。超过后发一条 runtime.notice，不是 HTTP 错误（server/drivers/chat-mcp-tools.ts:531-544、:258-281、server/drivers/openai-chat.ts:612-615）。
- 工具结果超过预算：文本被裁、结构化数组被裁，保留一个 query_result 句柄；模型看到“已裁剪”的横幅，不是 HTTP 错误（server/mcp-gate.ts:169-205、server/mcp-trim.ts:165-215）。
- 上下文达到阈值：生成摘要并写入 kind: compaction 消息，后续重放只带摘要和最近消息；原始消息仍在 Store 里（server/index.ts:7082-7105）。
- 房间上下文达到 roomCompactAt：开始新的房间会话/重置上下文，不删除房间消息（server/room-context.ts:10-15、:28-29）。

**静默丢弃或后台删除的：**

- thread 日志超过 eventLogMaxBytes：capThreadLog 直接把旧内容裁掉，保留最新一半；没有 HTTP、没有用户提示，只有文件变化（server/thread-log-rotation.ts:18-27、server/harness/bus.ts:245-249、server/drivers/native.ts:92-95）。
- thread 日志超过 eventLogRetentionDays：每日 sweep 删除 events/ 和 native/ 的 NDJSON，控制台只打一行 retention 日志；不删除 SQLite 消息（server/thread-retention.ts:34-45、server/host/start-upkeep.ts:21-49）。
- MCP spill 文件超过 24 小时：启动时按 mtime 删除（server/mcp-gate.ts:44、:99-110）。
- 保存的 MCP 大结果超过 20 个：只保留最新 20 个文件，旧的直接 unlink（server/drivers/chat-mcp-tools.ts:319-330、:335-349）。

**抛错或中止的：**

- MCP 单次调用超过 mcp.callTimeoutMinutes：抛“timed out; execution outcome may be uncertain”，可能结束本回合（server/drivers/chat-mcp-tools.ts:189-207）。
- harness 代理超时：返回工具错误文本，明确说“可能仍在运行或已经生效，不要直接重试”（server/harness-mcp-request.ts:31-40、:104-105）。
- 容器 PIDs 上限：进程/线程数到 4096 后 fork 失败；如果旧容器的 update --pids-limit 失败，仍保持 512，下一次开标签页或 docker exec 可能失败（server/container-limits.ts:1-18）。

### 3）哪些是保护性必须保留，哪些是成本/商业控制

**必须保留的保护性上限：**

- 防上下文溢出：compactAt、autoCompact、roomCompactAt、128k 兜底和 40 条重放（C1 到 C6）。
- 防 MCP 响应爆炸/OOM：128 默认工具限制、2000 工具/server、100 页、64KB schema、1MB 目录、2MB 帧、10000 帧、50KB 输出、1MB 入/16MB 出（C10 到 C14）。
- 防工具结果撑爆上下文：8000 字符默认预算、64MB ResultStore、20 个保存结果（C15、C20、L4）。
- 防磁盘无限增长：thread 日志上限、thread 日志保留、MCP spill 24 小时（L1 到 L3）。
- 防死循环和刷屏：房间 10/分钟、重复 60 秒、环检测、无人回应 2 条、每回合 3 条（A4 到 A9）。
- 防资源耗尽：每 bot 线程上限、workspace bot 上限、每回合 4 bot、每回合 5 线程、每回合 10 附件（A10 到 A12、C18）。
- 防容器 fork 炸弹和资源抢占：4096 PIDs、4GB 内存、2 CPU（C16、C17）。

**成本控制或商业分层的：**

- 图片日 50 张、单回合 4 张：主要是账单保护，不是许可证（A1、A2）。
- 月度美元上限、80% 预警：成本控制，且只在 budgets entitlement 下生效（Q9、Q10）。
- Starter 5 个 bot、每 bot 1 线程：Cloud 计划分层，属于商业许可边界（Q11、Q12）。
- 工具数量、MCP 结果预算、上下文压缩：同时有技术保护和 token 成本控制双重性质；不能简单当“商业限制”删掉（C1 到 C14、C20）。

### 4）硬编码与配置

**已经可配置的：** threads.maxConcurrentPerBot（1 到 1024）、threads.eventLogMaxBytes、threads.eventLogRetentionDays、limits.botThreads（1 到 1024）、limits.imagesPerDay（1 到 1,000,000）、limits.chatToolsPerRequest（1 到 10,000）、limits.roomPostsPerMinute（1 到 1,000）、limits.roomPostsWithoutReply（0 到 1,000）、limits.roomBreakerMinutes（1 到 1,440）、limits.attachmentsMaxBytes、limits.mcpServers、limits.botsPerWorkspace（1 到 100,000）、context.compactAt、context.autoCompact、context.rebuildBytes、context.roomCompactAt、mcp.callTimeoutMinutes、imageGen.maxPerTurn、budgets.monthlyUsd、budgets.warnAtPercent、rooms.turnTimeoutMinutes。范围分别见第二节 limits 表和主表 C2、C4、C6、C7、C18、C22、A2、L1、L2、Q9、Q10。

**写死但已经声明配置键、只是尚未接线的：**

- limits.roomPostsPerTurn：config schema 允许 1 到 1000，room-post-budget.ts 也导出了 roomPostsPerTurn，但 server/index.ts 仍用 MAX_ROOM_POSTS_PER_TURN=3（server/index.ts:1630、:14024-14025）。改这个键目前不会改变每回合 3 条的行为。
- limits.botsPerWorkspace：普通 /api/bots 创建和 bot-patch 的 peers 会读（server/routes/bots-create.ts:188-190、server/routes/bot-patch.ts:557），但内部 create-bot 和 teamSetup 仍用 MAX_WORKSPACE_BOTS=100（server/index.ts:9318、:14214-14215、:14253）。改这个键只影响部分入口。

**仍然完全硬编码的主要数字：** 每回合 10 个附件、每回合 5 个新线程、每回合 4 个新 bot、bot 指令 4000 字、房间单条 4000 字、线程硬上限 1024、工具/server 2000、100 页、64KB/1MB、2MB/32MB、10000 帧、50KB、MCP 结果 8000、ResultStore 64MB、保存结果 20、PIDs 4096、内存 4GB、CPU 2、浏览器 120/130 秒、设备 705 秒、电脑复制 540/550 秒、未知模型 128k、重放 40 条、failover 500 条、learned 500 条、tool-budget 1000 条。逐项是否应外置见第六节。

### 5）多租户、单机与 Cloud 差异

- **只在 Cloud/Starter 生效的：** cloudPlanTier.starter() 是 1 线程和 5 bot 的开关；它不是 Cloud 或没有 Admin 写入计划文件时一律非 Starter（server/host/cloud-plan-tier.ts:23-33、server/host/starter-bot-limit.ts:30-40、server/bot-thread-limits.ts:30-33）。
- **只在 Cloud home/team 的 Linux 上启用的：** engineMemory.enabled 只在 EAC_CLOUD_ROLE=home 或 team 且 Linux 时为 true；这时默认线程数直接取当前 ceiling，并由内存门另行控制。普通本地机器没有这个门，默认按 总内存/2GiB 算 3 到 ceiling（server/engine-memory.ts:474、server/bot-thread-limits.ts:22-33）。
- **单机也受同样限制的：** 图片日上限、房间发言、线程上限、workspace bot 上限、每回合附件/开线程/建 bot、上下文压缩、MCP 结果预算、容器 PIDs/内存/CPU、thread 日志保留和上限。它们与 Cloud 计划无关。
- **entitlement 不等于 hosted：** budgets 是许可证功能，可能在本机企业版生效，也可能在 Cloud 生效；没有 entitlement 时即使配置了 budgets.monthlyUsd 也不会拦截（server/spend.ts:80-81）。
- **团队账户可见性：** engine-limits 只把“本团队 engine home 或本人 person 目录”的账户列给这次 turn；别人 engine home 里的账户不会出现在结果里（server/engine-limits.ts:55-62、:97-105）。这是数据可见性边界，不是数量配额。

### 6）时间窗口、重置与持久化

- **图片日上限：** 进程本地时区的自然日，getFullYear/getMonth/getDate 计算；不是 UTC。计数写 DATA_DIR/image-generation-day.json，重启不清零；文件缺失/损坏按 0 重新计数；写盘失败只告警，下一次仍可能继续生成（server/image-daily-cap.ts:14-16、:32-56）。
- **房间限速：** 滑动窗口，按 Date.now() 毫秒差计算，不是自然日；roomPostBudgets 只在内存，重启清零（server/room-post-budget.ts:28-33、:89、server/index.ts:9658）。breaker 冷却和 retention 会随 roomBreakerMinutes 拉长。
- **月度花费：** UTC 自然月，toISOString().slice(0, 7)；从 UTC 每月 1 日开始读 usage ledger，缓存 15 秒；账本持久化，重启不丢；预警标记写 usage/alerts.json（server/spend.ts:19、:24-25、:30-44、:123-152）。
- **thread 日志保留：** 按 closedAt/archivedAt 到现在的毫秒差算天数，不看时区；sweep 在进程启动后立即跑一次，之后每 24 小时一次；线程时间戳来自 Store，重启不会重置“已关闭多久”（server/thread-retention.ts:15-32、server/host/start-upkeep.ts:8、:49）。
- **thread 日志大小：** 纯大小触发，无时间窗口；每次追加后检查，超过就裁到最新一半（server/thread-log-rotation.ts:18-27）。
- **provider 限额：** LIMIT_POLL_MS 5 分钟；等待中的 routine 每 60 秒检查一次；没有重置时间时按住 1 小时，拒绝后保留 10 分钟宽限；状态写 limit-holds.json（server/limit-resets.ts:11-15、:97-98、:220-245、:290-297、server/index.ts:8821）。
- **自动回切：** 没有重置时间时先等 1 小时；failover 记录写 limit-failovers.json，最多 500 条，重启保留（server/limit-failover.ts:70-71、:116、server/index.ts:8823）。
- **限额通知：** 同一 bot 同一引擎的一段限额只通知一次；没有重置时间时这段状态持续 3 小时；写 limit-notices.json，重启保留（server/limit-notices.ts:13-14、:64-72、server/index.ts:8822）。
- **工具预算元数据：** 只在内存，重启清零；每 bot 只保留最后一次；超过 1000 个 bot 淘汰最早插入的（server/tool-budgets.ts:3-11）。现在 workspace 可配到 100,000，1000 这个 map 上限会成为新瓶颈。
- **学到的工具数上限：** 只在内存，重启清零；超过 500 个 key 淘汰最旧（server/tool-count-limit.ts:83）。
- **MCP 结果池：** 每个 gate 进程一个 ResultStore，上限 64MB，超出淘汰最旧；进程重启清空（server/mcp-shape.ts:17、:94-114）。
- **保存的大工具结果：** 每个工作目录的 mcp-results 只留最新 20 个；按文件时间戳排序删除（server/drivers/chat-mcp-tools.ts:319-330）。

### 7）建议表的结论

**不建议删除任何配额代码。** 真正该做的是：把仍然硬编码的保护性阈值外置为配置，把会删日志的项保持默认关闭并明确告知，把商业项保留在 entitlement 后面。按这个原则，53 条中：保留 39 条，改可配置 12 条，默认关闭 2 条，删除 0 条。逐条建议和“删除后的最坏后果”在第八节。

## 四、主体表

编号规则：C 是容量/上下文/工具/运行时上限；L 是保留、轮转与删除；A 是防滥用、速率与每回合配额；Q 是供应商用量、商业计划与成本控制。每个前缀连续编号。

| 编号 | 文件:行 | 限制或行为 | 触发条件 | 默认值 | 技术限制/商业许可 | 建议（删除/默认关闭/改可配置/保留） |
|---|---|---|---|---|---|---|
| C1 | server/context-budget.ts:4、server/context-budget.ts:7-13 | 未知模型的上下文窗口兜底为 128000 tokens；优先用 provider 上报值、模型目录、模型名推断 | 没有 provider 上报的 window、目录没有声明、模型名也推断不出 | 128000 tokens；无配置键、无环境变量 | 技术限制；防上下文溢出，但小窗口模型可能溢出、大窗口模型可能过早压缩 | 改可配置（默认仍 128000，允许按模型覆盖） |
| C2 | server/context-budget.ts:21-25、server/index.ts:7082-7083 | 自动压缩阈值：默认 80% 窗口；硬顶 90% 窗口；有引擎原生压缩点时再乘 0.9 | 自动压缩开启且估算 tokens 达到阈值 | 0.8×window；context.compactAt 可配，范围大于 0 到 10,000,000；小于 1 当比例，大于等于 1 当 tokens | 技术限制；防上下文溢出和 token 成本 | 保留（已可配置） |
| C3 | server/config.ts:427-430、server/index.ts:7058、server/index.ts:5260 | autoCompact 默认开启；显式 false 时跳过自动压缩，也跳过空闲热摘要；手动压缩仍可执行 | 配置 context.autoCompact=false | true；只有 false 会关闭 | 技术限制；防上下文溢出 | 保留 |
| C4 | server/replay-settings.ts:3-5、server/context-rebuild.ts:156、server/context-rebuild.ts:192、server/index.ts:7864 | 重建会话时最多带多少字节历史；超出预算时从最旧的消息开始裁短或舍弃 | 新建/重建会话、提示重放 | 24,000 bytes；context.rebuildBytes 可配 1024 到 1,000,000 | 技术限制；控制 token，原始消息仍保留 | 保留（已可配置） |
| C5 | server/context-rebuild.ts:193、server/context-rebuild.ts:218、server/index.ts:7864 | 重放默认最多 40 条消息；更早的消息只靠压缩摘要 | 一次重放超过 40 条 | 40 条；无配置键 | 技术限制；token 控制，但用户会看不到早期原文 | 改可配置（默认 40） |
| C6 | server/room-context.ts:6、server/room-context.ts:10-15、server/room-context-settings.ts:3-7 | 房间成员上下文达到阈值时重置房间会话；不是删除消息 | 房间回合、autoCompact 不为 false、达到阈值 | 0.9×window；context.roomCompactAt 可配大于 0 到 10,000,000 | 技术限制；防房间上下文溢出 | 保留（已可配置） |
| C7 | server/config.ts:48-50、server/config.ts:82-90、server/config.ts:641-642、server/drivers/chat-mcp-tools.ts:189-207 | 单次 MCP 工具调用超时；超时抛错，结果可能不确定 | 一次 MCP call 超过配置分钟数 | 10 分钟；mcp.callTimeoutMinutes 可配 1 到 60 | 技术限制；防挂死和无限等待 | 保留（已可配置） |
| C8 | server/harness-budget.ts:2-4、server/browser-runtime.ts:55、server/harness-mcp-request.ts:95、server/harness-mcp-request.ts:105 | 浏览器/数据等 harness 调用 120 秒；stdio 代理等 130 秒；超时返回工具错误 | 单个 browser、computer、data 等调用超过预算 | 120,000ms 和 130,000ms；无配置 | 技术限制；防挂死，但慢网页会失败 | 改可配置（默认 120/130 秒） |
| C9 | server/harness-budget.ts:6-18、server/cloud-computer-tools.ts:50、server/drivers/codex.ts:631 | 手机设备调用 705 秒；云电脑复制 540 秒；云电脑代理 550 秒 | 设备发送/重连、云电脑复制、Codex 电脑工具 | 705,000ms、540,000ms、550,000ms；无配置 | 技术限制；防挂死，超长复制会失败 | 保留（必要时再外置） |
| C10 | shared/tool-budget.ts:1-2、server/config.ts:330、server/tool-count-limit.ts:127-134、server/drivers/chat-mcp-tools.ts:531-538 | Chat Completions 单请求默认最多 128 个工具；limits.chatToolsPerRequest 可改；MCP server 超出份额时裁工具或改走工具搜索 | 请求工具数超过当前上限，或 provider 拒绝并报出上限 | 128；limits.chatToolsPerRequest 可配 1 到 10,000；Venice 主机返回 null（不限制）；学到的上限最多 500 个 key | 技术限制；上游协议上限和 token 成本；配得太高仍会被 provider 拒绝一次 | 保留（已可配置） |
| C11 | server/drivers/chat-mcp-tools.ts:71-74、server/drivers/chat-mcp-tools.ts:243-254 | 单个 MCP server 最多列 2000 个工具；tools/list 最多翻 100 页 | server 返回超过 2000 个工具或超过 100 页 | 2000 个工具、100 页；无配置 | 技术限制；防恶意/失控 MCP server 撑爆内存 | 保留 |
| C12 | server/drivers/chat-mcp-tools.ts:75-76、server/drivers/chat-mcp-tools.ts:380、server/drivers/chat-mcp-tools.ts:498 | 单个工具 schema 最大 64KB；整个工具目录最大 1MB | schema 或目录序列化后超过上限 | 64KB、1MB；无配置 | 技术限制；防上下文和内存膨胀 | 保留 |
| C13 | server/drivers/chat-mcp-tools.ts:66-67、server/drivers/chat-mcp-tools.ts:104、server/drivers/chat-mcp-tools.ts:153-186、server/drivers/chat-mcp-tools.ts:307-316 | MCP 帧 2MB，电脑模式 32MB；最多 10000 帧；单结果输出 50KB，超出截断 | 单帧过大、帧数过多、工具输出过大 | 2MB、32MB、10000 帧、50KB；无配置 | 技术限制；防 OOM 和上下文爆炸 | 保留 |
| C14 | server/harness-mcp-request.ts:10-11、server/harness-mcp-request.ts:59、server/harness-mcp-request.ts:91 | harness MCP 请求最大 1MB；响应最大 16MB | 请求体或响应体超过上限 | 1,048,576 bytes、16,777,216 bytes；无配置 | 技术限制；防内存和代理层 DoS | 保留 |
| C15 | server/drivers/chat-mcp-tools.ts:319-330、server/drivers/chat-mcp-tools.ts:335-349 | 大工具结果可存到工作目录的 mcp-results；只保留最新 20 个，旧的自动删除 | 结果超过 50KB 且工作目录可用；保存文件超过 20 个 | 20 个文件；无配置 | 技术限制；防磁盘增长，但会删旧工具结果 | 改可配置（默认 20） |
| C16 | server/container-limits.ts:3、server/container-limits.ts:5、server/container-limits.ts:11-18、server/container-computer.ts:878 | 托管容器进程/线程上限 4096；旧容器正好 512 时尝试原地升级；升级失败则保持 512 | 创建或检查托管容器 | 4096 PIDs；旧值 512；无配置 | 技术限制；防 fork 炸弹，但 512 时 Firefox 多标签会失败 | 保留（可考虑按机器规格外置） |
| C17 | server/container-computer.ts:852-878、server/vps-computer.ts:852-858 | 托管桌面固定 4GB 内存、4GB swap、2 CPU | 创建托管容器 | 4GB、4GB、2 核；无配置 | 技术限制；防 OOM 和 CPU 抢占，但重负载桌面会不够 | 改可配置（默认保持 4GB/2CPU） |
| C18 | server/bot-thread-limits.ts:8-39、server/config.ts:305-311、server/config.ts:325-336、server/index.ts:7630-7631 | 默认并发线程上限 16；threads.maxConcurrentPerBot 和 limits.botThreads 都可配到 1024；Starter 强制 1；Starter 子线程 16 | 同一 bot 已有达到上限的 busy thread，且不是主聊天线程 | 默认 16；普通本地默认 min(ceiling, max(3, round(totalMem/2GiB)))；Cloud 内存门默认取 ceiling；配置 1 到 1024 | 技术限制；防内存/CPU 耗尽；人员路径可排队，直接启动 409 | 保留（已可配置） |
| C19 | server/tool-budgets.ts:3-11 | 工具预算元数据最多记 1000 个 bot；超出淘汰最早插入的 | 服务运行中超过 1000 个不同 bot 产生工具预算 | 1000；无配置 | 技术限制；防内存泄漏，但 limits.botsPerWorkspace 可到 100,000，1000 会成为新瓶颈 | 改可配置（与 workspace 上限联动） |
| C20 | server/mcp-trim.ts:1、server/mcp-trim.ts:5、server/mcp-trim.ts:167、server/mcp-gate-config.ts:23-40、server/mcp-gate.ts:169-205 | 单个工具结果默认 8000 字符进入上下文；最小 512；0 不截断；多文本块按块平分预算 | 一个工具结果文本总量超过预算 | 8000 字符；每 server resultBudget 可配 0 到 2,000,000；EAC_MCP_RESULT_BUDGET 可覆盖且只校验有限且不小于 0 | 技术限制；防上下文溢出和成本爆炸 | 保留（已可配置） |
| C21 | server/tool-count-limit.ts:83 | 学到的模型工具上限最多记 500 个 key；超出淘汰最旧 | 运行中遇到超过 500 个不同模型/URL 组合 | 500；无配置 | 技术限制；防内存增长，但淘汰后可能重复试错 | 保留 |
| C22 | server/config.ts:45-47、server/config.ts:75-81、server/config.ts:631-633、server/room-turn-timeout.ts:51-55、server/index.ts:10312-10329 | 房间回合无进展默认 5 分钟停止；配置范围 1 到 1440 分钟；有工具运行时静默上限取 max(配置, 60 分钟) | 房间回合没有进度事件；等待人或电脑时暂停计时 | 5 分钟；rooms.turnTimeoutMinutes 可配 1 到 1440 | 技术限制；防房间卡死，但长任务会被中断 | 保留（已可配置） |
| L1 | server/thread-retention.ts:1、server/thread-retention.ts:22-47、server/config.ts:305-311、server/config.ts:649-655、server/host/start-upkeep.ts:21-49 | **会删数据：** 关闭或归档超过 N 天的 thread，删除 events/ 和 native/ 的 NDJSON；不删 SQLite 聊天记录；unread、busy、open handoff 跳过 | 配置了 threads.eventLogRetentionDays，且线程已关闭/归档、空闲超过 N 天、不忙、不未读、无 handoff | null（不扫描）；可配 1 到 3650 天；null 清除 | 技术限制；防磁盘无限增长；删除不可逆 | 默认关闭（保持） |
| L2 | server/config.ts:51-53、server/config.ts:305-311、server/thread-log-rotation.ts:18-27、server/thread-log-rotation.ts:45-63、server/harness/bus.ts:245-249 | **会删数据：** 每个 thread 的 events/、native/ 日志超过上限后，裁到最新一半，按行边界切；不删 SQLite 记录 | 日志追加后文件大小超过 eventLogMaxBytes | null（不限制）；可配 262,144 到 4,294,967,296 bytes；null 清除 | 技术限制；防磁盘增长；裁剪静默且不可逆 | 默认关闭（保持） |
| L3 | server/mcp-gate.ts:44、server/mcp-gate.ts:99-110、server/mcp-gate.ts:133-140、server/mcp-gate-config.ts:60-61 | MCP 完整结果 spill 文件超过 24 小时后删除 | gate 启动时扫描 spill 目录，mtime 早于 24 小时 | 24 小时；无配置 | 技术限制；防磁盘增长，也降低敏感工具结果留存 | 保留 |
| L4 | server/mcp-shape.ts:17、server/mcp-shape.ts:94-114、server/mcp-gate.ts:118 | query_result 持有的完整结果最多 64MB；超出淘汰最旧；旧句柄查询会失败 | 同一 gate 进程持有的结果总量超过 64MB | 64MB；无配置 | 技术限制；防内存 OOM | 保留 |
| L5 | server/limit-failover.ts:110-117、server/index.ts:8823 | 自动回切记录最多 500 条；超出丢最旧 | 超过 500 个 thread 发生过 limit failover | 500 条；无配置 | 技术限制；防文件无限增长，但丢记录后对话可能不回原模型 | 保留（可配置上限） |
| A1 | server/config.ts:329、server/image-daily-cap.ts:11、server/image-daily-cap.ts:30-44、server/image-daily-cap.ts:48-56、server/routes/image-tools.ts:78、server/routes/image-tools.ts:137 | 每天 N 张图的安装级上限；只统计 bot 生成，不统计设置里的头像；按本地日；limits.imagesPerDay 可改 | 当天已生成加正在生成的图片达到当前上限 | 50 张/安装/本地日；limits.imagesPerDay 可配 1 到 1,000,000 | 技术限制；成本控制，默认已可配置 | 保留（已可配置） |
| A2 | shared/image-generation.ts:5、server/image-generation-config.ts:12-15、server/routes/image-tools.ts:59-61 | 单回合最多生成 N 张图；达到后 429 | 本回合已挂起加正在生成的图片达到 maxPerTurn | 4 张；imageGen.maxPerTurn 可配 1 到 10 | 技术限制；成本控制 | 保留（已可配置） |
| A3 | server/drivers/agents-image-tools.ts:4、server/routes/image-tools.ts:22-24 | 图片提示词最多 4000 字符 | prompt 超过 4000 | 4000 字符；无配置 | 技术限制；防超长输入 | 保留 |
| A4 | server/config.ts:332、server/index.ts:1630、server/index.ts:14024-14025、server/index.ts:14119、server/room-post-budget.ts:36-40 | 每回合最多 3 条房间发言；limits.roomPostsPerTurn 已声明但未接线 | 同一 internal capability 已成功发 3 条 | 3 条；limits.roomPostsPerTurn 可配 1 到 1000，但当前不生效 | 技术限制；防刷屏和循环；配置半成品 | 改可配置（把 roomPostsPerTurn 接进 server/index.ts） |
| A5 | server/index.ts:9659、server/index.ts:14027-14030 | 单条房间发言最多 4000 字符 | message 长度超过 4000 | 4000 字符；无配置 | 技术限制；防上下文和刷屏 | 改可配置（默认 4000） |
| A6 | server/config.ts:333、server/room-post-budget.ts:28-29、server/room-post-budget.ts:57-65、server/room-post-budget.ts:123-124 | 同一 bot 60 秒内最多 N 条房间发言；limits.roomPostsPerMinute 可改 | 同一 bot 在 60 秒内超过当前 N | 10 条/60 秒；limits.roomPostsPerMinute 可配 1 到 1000 | 技术限制；防刷屏 | 保留（已可配置） |
| A7 | server/room-post-budget.ts:30、server/room-post-budget.ts:107-115 | 同一 bot 60 秒内重复完全相同文本就拒绝 | 同 bot、同 text、60 秒内 | 60 秒；无配置 | 技术限制；防重复刷屏 | 保留 |
| A8 | server/config.ts:335、server/room-post-budget.ts:31-32、server/room-post-budget.ts:57-65、server/room-post-budget.ts:116-122 | 120 秒内三个 bot 形成 A、B、C、A 的四人环就熔断房间；limits.roomBreakerMinutes 可改冷却 | 最近 4 条发言首尾相同且中间三个 sender 不同 | 120 秒检测、5 分钟冷却；limits.roomBreakerMinutes 可配 1 到 1440 | 技术限制；防 bot 互相回环 | 保留（已可配置） |
| A9 | server/config.ts:334、server/room-post-budget.ts:33-34、server/room-post-budget.ts:57-65、server/room-post-budget.ts:130-137 | 5 分钟内没有人类回复的 bot 帖子达到 N 条就拒绝继续发；limits.roomPostsWithoutReply 可改，0 表示全拒 | 最近 5 分钟 bot 帖子达到当前 N，且最后一条在最后一次人类消息之后 | 2 条/5 分钟；limits.roomPostsWithoutReply 可配 0 到 1000 | 技术限制；防 bot 在没有人的房间自说自话 | 保留（已可配置） |
| A10 | server/index.ts:1629、server/index.ts:13353、server/index.ts:13381 | 每回合最多附加 10 个文件 | 本回合附件数达到 10 | 10 个；无配置；limits.attachmentsMaxBytes 管的是附件库字节，不是个数 | 技术限制；防大提示词和磁盘压力 | 改可配置（默认 10） |
| A11 | server/index.ts:7387、server/index.ts:13756-13757、server/index.ts:14150-14151 | 每回合最多打开 5 个新线程 | 本回合已打开 5 个线程 | 5 个；无配置 | 技术限制；防 bot 扇出 | 改可配置（默认 5） |
| A12 | server/config.ts:326、server/index.ts:1631、server/index.ts:1829、server/index.ts:9318、server/index.ts:14214-14215、server/index.ts:14253、server/routes/bots-create.ts:188-190 | 每回合最多创建 4 个 bot；workspace bot 上限部分读 limits.botsPerWorkspace | 本回合创建第 5 个，或入口看到的 workspace 达到当前上限 | 4 个/回合；workspace 默认 100；limits.botsPerWorkspace 可配 1 到 100,000，但内部 create-bot/teamSetup 仍用 100 | 技术限制；防资源和权限爆炸；配置部分接线 | 改可配置（完成 internal/teamSetup 接线，保留默认 4/100） |
| A13 | server/index.ts:1632、server/index.ts:14228-14229 | 通过 internal 能力创建 bot 时，instructions 最多 4000 字符 | instructions 长度超过 4000 | 4000 字符；无配置 | 技术限制；防超长提示词 | 保留 |
| Q1 | server/engine-limits.ts:38-41、server/engine-limits.ts:97-105、server/routes/engine-limits.ts:39-43 | 只读展示引擎账户限额；只列 claudeAgent、codex、grokAgent；metered 账户显示 unsupported；guest 403 | 机器人调用 usage_limits 工具 | 无数量上限；三类 reporting driver；无配置 | 技术限制；信息展示，不执行拒绝 | 保留 |
| Q2 | server/plan-usage.ts:115、server/plan-usage.ts:317、server/engine-limits.ts:25-26、server/routes/engine-limits.ts:41 | 计划用量缓存 45 秒；除非显式刷新，机器人循环调用拿到同一份数据 | 45 秒内重复读同一组账户 | 45 秒；无配置 | 技术限制；防 provider API 被轮询打爆 | 保留 |
| Q3 | shared/limit-reset.ts:19-23、server/limit-resets.ts:63-70、server/routes/limit-resets.ts:80-83 | 已用 90% 提示接近限额；重置后 60 秒才允许 automation 运行 | 账户窗口达到 90%，或 reset 时间到达 | 90%、60 秒；无配置 | 技术限制；provider 配额和调度缓冲 | 改可配置（默认 90%/60 秒） |
| Q4 | server/limit-resets.ts:11-15、server/limit-resets.ts:220-245、server/index.ts:15522 | 等待中的 limit-reset automation 每 5 分钟刷新一次用量；定时器每 60 秒检查 | 有等待 reset 的 routine | 5 分钟刷新、60 秒检查；无配置 | 技术限制；provider API 和调度精度 | 保留 |
| Q5 | server/limit-resets.ts:97-98、server/limit-resets.ts:173-198、server/limit-resets.ts:261-297、server/index.ts:8821 | 没有重置时间的限额按住 1 小时；拒绝的 reset 时间保留 10 分钟宽限；hold 写盘 | provider 拒绝但没有给重置时间，或 reset 时间刚过 | 1 小时、10 分钟；无配置 | 技术限制；遵守 provider 限额，避免连续撞墙 | 保留 |
| Q6 | server/limit-failover.ts:19-26、server/limit-failover.ts:70-71、server/limit-failover.ts:110-117、server/index.ts:8613-8624 | 自动切到备份模型；没有重置时间时先等 1 小时；同一订阅引擎的不同账户不能互相接盘，按量计费 key 可以 | 当前模型限额拒绝、线程有可用备份 | 未知重置等待 1 小时；回切记录 500 条 | 技术限制加服务条款边界；防账户轮换绕过限额 | 保留（不要改成同订阅轮换） |
| Q7 | server/limit-notices.ts:13-14、server/limit-notices.ts:64-72、server/host/limit-takeover.ts:86 | 同一 bot 同一引擎的一段限额只通知一次；没有重置时间时持续 3 小时 | 第一次限额拒绝，或同一段内再次拒绝 | 3 小时；无配置 | 技术限制；减少重复通知 | 保留 |
| Q8 | server/quota-switch.ts:74-77、server/index.ts:8613-8618 | 默认开启自动切换；EAC_QUOTA_SWITCH=0 关闭，关闭后只用 Automatic recovery 指定的备份 | 引擎限额或登出，线程有备份 | true；环境变量可关 | 技术限制；连续性和成本行为 | 保留（默认开启，保留 env 关闭） |
| Q9 | server/config.ts:367-372、server/spend.ts:1、server/spend.ts:24-25、server/spend.ts:80-111、server/index.ts:7232-7236 | 月度美元上限；达到后新回合 409 spend_cap；只在 budgets entitlement 下生效 | 本 UTC 月花费达到 budgets.monthlyUsd | 未设置则不限制；可配 0 到 1,000,000 美元；0 视为不启用 | 商业许可；成本控制 | 保留（商业边界，不绕过） |
| Q10 | server/spend.ts:18、server/spend.ts:83、server/spend.ts:136-164 | 花费达到月上限的 80% 时发一次预警 | 本 UTC 月百分比达到 warnAtPercent | 80%；可配 1 到 100 | 商业许可；成本控制 | 保留（商业边界） |
| Q11 | server/host/starter-bot-limit.ts:6、server/host/starter-bot-limit.ts:30-40、server/index.ts:2863、server/routes/bots-create.ts:193-194 | Starter Cloud 最多 5 个 bot；第 6 个返回 409 并提示升级 | Cloud 计划为 starter 且创建新 bot | 5 个；无配置 | 商业许可；计划分层 | 保留（商业边界，不绕过） |
| Q12 | server/bot-thread-limits.ts:30-33、server/index.ts:2235、server/index.ts:7630-7631 | Starter Cloud 每 bot 只允许 1 个并发线程；子线程例外，放行到 16 | Cloud 计划为 starter，且已有 busy 线程 | 1 个；无配置 | 商业许可；计划分层 | 保留（商业边界，不绕过） |
| Q13 | server/host/cloud-plan-tier.ts:10、server/host/cloud-plan-tier.ts:23-33、server/index.ts:2863 | Cloud 计划来自 Admin 写入的 cloud-plan-tier.json；非 Cloud 或无文件一律非 Starter | Admin 签名 POST 设置计划；Cloud home 启动读取 | 非 Starter；无配置 | 商业许可；计划分层 | 保留（商业边界，不绕过） |

## 五、逐模块补充：主表之外的边界

### 5.1 engine-limits

engine-limits 是“给机器人看的只读账本”，不是拦截器。它先看实例是否启用、provider 快照是否 available，再看账户目录是否属于本团队或本人；两个条件不满足就直接不列出（server/engine-limits.ts:95-105）。因此“机器人看不到某个账户”不一定代表账户不存在，可能只是它不在这个 turn 的可读范围内。

它把 provider 状态分成 ok、unknown、unsupported 三种。ok 表示有窗口数据；unknown 表示账户会报限额但这次没读到；unsupported 表示这个驱动不向 EACbot 报限额，或者账户是按量计费（server/engine-limits.ts:18-29、:104-110）。metered 被归到 unsupported，不是因为计量账户没有额度，而是因为它的余额不由 plan-usage 的订阅窗口表达。

路由层对 guest 返回 403，对正常 turn 返回 200 加 JSON；没有强刷，机器人循环调用只会拿到 45 秒缓存（server/routes/engine-limits.ts:39-43、server/plan-usage.ts:115）。这条缓存的目的是防止机器人用 usage_limits 自己把 provider API 打爆，不是给用户展示实时余额。

### 5.2 limit-resets、limit-notices、limit-failover

这三个模块解决的是“provider 限额到了以后怎么办”，不是“用户能发多少条”。LimitResetClock 把 provider 拒绝分成两类：给了 reset 时间的，按 reset 时间 hold；没给 reset 时间的，按住 1 小时并标记为 guessed。guessed 的 hold 不会在 UI 里伪装成 provider 给的 reset 时间，但会阻止下一回合继续撞同一个引擎（server/limit-resets.ts:97-98、:173-198、:261-270）。

Codex 有一个例外：如果新的 usage 报告显示窗口已经不在限额、且 reset 时间和 hold 的时间差超过 5 分钟，就认为 hold 已过期并释放；Claude 不享受这个自动释放，因为 Claude 可能因窗口之外的额度拒绝（server/limit-resets.ts:43-53、:200-218）。

LimitNotices 是通知去重，不是配额。同一 bot 同一引擎的一段限额只提醒一次；没有 reset 时间时，这段状态持续 3 小时，足够覆盖 1 小时 hold 后的下一次重试（server/limit-notices.ts:1-4、:64-72）。它把状态写 limit-notices.json，重启后仍然知道“已经说过了”。

LimitFailovers 记录“这个 thread 从哪个模型切到了哪个备份”。它最多保留 500 条；超过后丢最旧。这个上限不会删聊天消息，但会让很老的 thread 失去“自动切回原模型”的记录。另一个重要边界是 limitBackupAllowed：同一个订阅引擎换另一个账户接盘是不允许的，只有按量计费 key 或另一个引擎可以；这是服务条款边界，不是技术偏好（server/limit-failover.ts:19-26、:110-117）。

### 5.3 bot-thread-limits

现在 16 只是默认值，不是硬上限。threads.maxConcurrentPerBot 和 limits.botThreads 都可配到 1024；如果 threads.maxConcurrentPerBot 存在，它优先于 limits.botThreads 的 ceiling（server/bot-thread-limits.ts:17-33、server/config.ts:305-311、:325-336）。Cloud 内存门会直接采用当前 ceiling，再由内存门单独控制（server/bot-thread-limits.ts:22-28、server/engine-memory.ts:474）。

主聊天线程永远不参与并发上限计算；这是为了避免“用户自己正在聊的那个线程被自己的其他任务挤掉”（server/index.ts:2233-2235）。Starter 的人线程是 1，但 bot 子线程仍按 MAX_CONCURRENT_BOT_THREADS=16 算，因为子线程可能是当前 turn 正在等待的结果，压到 1 会死锁（server/bot-thread-limits.ts:36-39）。这就是“Starter 1 线程”和“子线程并行”看似矛盾的原因。

### 5.4 tool-budgets 与 tool-count-limit

128 是 Chat Completions 的默认工具数组上限，不是 EACbot 的偏好；OpenAI 兼容端点会拒绝超过 128 的请求（shared/tool-budget.ts:1-2）。现在 limits.chatToolsPerRequest 可以改到 10,000，但 provider 仍可能拒绝；EACbot 会在拒绝后学习真实上限并重试一次（server/tool-count-limit.ts:101-116、:127-134）。

分份额有一个副作用：同一个 server 在不同 turn 可能拿到不同份额，取决于同 turn 其他 server 的数量和顺序。用户可能看到“昨天这个工具还在，今天只能搜索到”，这不是工具消失，而是预算分配变了。预算元数据 toolBudgetOf 会把最后一次的 limit、listed、servers 暴露给 /api/mcp-servers，方便排障（server/tool-budgets.ts:6-15、server/routes/mcp-servers.ts:68）。

学到的上限只存内存，最多 500 个 key；进程重启就忘。这样做的代价是：如果某个 provider 每次都要先拒绝一次才肯说出真实上限，重启后会再交一次“学费”。更值得注意的是 tool-budgets 的 1000 bot map 上限：limits.botsPerWorkspace 现在可到 100,000，超过 1000 个 bot 后预算元数据会丢最旧，排障信息不完整。这是 C19 的风险来源。

### 5.5 mcp-result-budget

8000 字符是“进入模型上下文的预算”，不是“工具结果的真实大小”。gate 会先保留完整结果到 query_result 的句柄，再把文本裁到预算内；结构化结果如果和文本同源，会一起裁，避免 provider 收到两份完整数据（server/mcp-gate.ts:169-205）。

0 是一个特殊值：它让 gate 不裁剪，并且让 bot 自己的 server 直接挂载、不经过 gate（server/mcp-gate-config.ts:23）。这适合“必须拿完整 JSON”的 server，但代价是上下文可能被一次工具结果撑爆；普通用户不应默认设 0。

64MB 的 ResultStore 是 gate 进程级，不是全局磁盘。超过 64MB 后最旧的句柄被淘汰，模型再查会得到“result is no longer held”；这不是错误，是设计上的内存保护（server/mcp-shape.ts:94-114、:126-133）。每个 server 的 resultBudget 上限 2,000,000 字符，但环境变量 EAC_MCP_RESULT_BUDGET 在 gate 配置里只校验有限且不小于 0，没有上限；这是一个需要统一的口径。

### 5.6 harness-budget

120 秒是普通 harness 调用的预算，130 秒是 stdio 代理的等待上限；两者相差 10 秒，是为了让代理在服务端回答之后还能把结果写回引擎（server/harness-budget.ts:1-4）。手机设备是 705 秒，因为它要覆盖“等人接电话 9 分钟 + 发送 120 秒 + 重连 15 秒 + 30 秒余量”；云电脑复制是 540 秒，因为它可能搬 2GiB 文件（server/harness-budget.ts:6-15）。

这些超时不是“请求被拒绝”的 HTTP 状态，而是工具结果里的错误文本；模型会看到“可能仍在运行或已经生效，不要直接重试”。这是为了避免重复执行有副作用的工具调用（server/harness-mcp-request.ts:31-40）。

### 5.7 context-budget

compactBudget 的口径是：配置值小于 1 当窗口比例，大于等于 1 当绝对 tokens；最终再取 min(配置, 0.9×窗口, 0.9×原生压缩点)。所以即使把 compactAt 设成 10,000,000，实际也不会超过窗口的 90%（server/context-budget.ts:21-25）。

shouldCompact 优先用 provider 上报的 contextTokens；没有就用 estimatedBytes/4 估算。估算值不是精确 token 数，中文、代码和 JSON 的 bytes/token 比不同，所以它只能做保守触发，不能当账单（server/context-budget.ts:27-33）。

压缩不是删除：它把旧消息折叠成一条 kind: compaction 的记录，原始消息仍在 SQLite，用户回看历史时还能看到；但下一次模型 prompt 只带摘要和最近消息（server/index.ts:7101-7105）。这就是“上下文里看不到”和“数据库里没有”的区别。

### 5.8 image-daily-cap

现在 cap 是一个函数，每次 reserve 都读 quotaLimits().imagesPerDay；options.cap 只用于测试。因此通过 saveConfig 改 limits.imagesPerDay 不需要重启，下一次生成就生效；手改 config.json 则要等下一次 loadConfig（server/image-daily-cap.ts:30-44、server/config.ts:1059）。默认仍是 50，范围 1 到 1,000,000。

reserve() 先读当天的磁盘计数，再加上内存里的 held；两者相加达到 cap 就拒绝。settle(made) 在图片生成结束后调用：成功就写盘加 1，失败就只释放 hold（server/image-daily-cap.ts:32-56）。因此“正在生成”的图片也占名额，不会出现 20 个并发请求同时通过、最后生成 70 张的情况。

它只统计 bot 生成的图片；设置页里人自己点的头像不经过这个 cap（server/image-daily-cap.ts:1-3、server/routes/image-tools.ts:137-144）。这不是漏洞，是产品定义：人自己点的按钮由人负责，bot 循环才需要安装级上限。

### 5.9 room-post-budget

房间预算的“拒绝不记录”很重要：如果每次拒绝也写进 posts，被 blocked 的 bot 会越拒越深，最后永远出不来（server/room-post-budget.ts:82-99）。所以拒绝只返回 message，不把这次尝试算进 sender 速率；只有真正 append 的帖子才进入 posts（server/index.ts:14119）。

limits 只覆盖 senderMax、escalateMax、breakerCooldownMs；duplicate 窗口 60 秒、ring 窗口 120 秒、sender 窗口 60 秒、escalate 窗口 5 分钟仍是硬编码（server/room-post-budget.ts:28-34）。roomBreakerMinutes 变大时，retentionMs 会跟着变大，posts 数组在内存里保留更久；这是为了防止“提高预算后看不到旧帖子”，但也增加了内存占用。

最关键的半成品是 limits.roomPostsPerTurn：它已经在 room-post-budget.ts:36-40 导出，但 server/index.ts 仍用 MAX_ROOM_POSTS_PER_TURN=3（server/index.ts:1630、:14024-14025）。因此改这个键目前不会改变每回合 3 条的行为；这不是配置解析失败，而是调用点没换。

### 5.10 thread-retention 与 thread-log-rotation

thread-retention 的删除对象只有 EVENTS_DIR 和 NATIVE_DIR 下的 threadId.ndjson；SQLite 的 messages.db 不在删除列表（server/thread-retention.ts:1、:34-38）。NATIVE_DIR 是引擎原始 I/O 日志，可能包含 prompt 和回复；删除它有隐私收益，但也会让排障材料消失。

thread-log-rotation 没有日志、没有提示、没有备份；它只保证“最新一半”还在。若文件在窗口内没有换行，它会放弃裁剪，避免把一条超长记录切成半个 JSON（server/thread-log-rotation.ts:45-47）。这是“宁可暂时超限，也不破坏可解析性”的取舍。

### 5.11 container-limits 与容器资源

4096 是 PIDs 上限，不是内存上限；它防的是 fork 炸弹和线程爆炸。旧容器 512 会被尝试升到 4096，但 update --pids-limit 失败会被吞掉，所以“代码里有 4096”不等于“这台机器已经生效”（server/container-limits.ts:9-18）。

4GB 内存、4GB swap、2 CPU 是另一个写死点，和 PIDs 不是同一个常量。它们没有被 container-limits.ts 导出，而是直接写在容器创建参数里；改 PIDs 不会改内存/CPU，改内存/CPU 也不会改 PIDs（server/container-computer.ts:852-878、server/vps-computer.ts:852-858）。

### 5.12 spend、Starter 与 entitlement

spendState 在没有 budgets entitlement 时直接返回 null；调用方 assertWithinBudget 看到 null 就放行。这就是“配置了 monthlyUsd 也不拦”的原因，不是配置解析失败（server/spend.ts:74-111）。

Starter 的 5 bot 和 1 线程都来自 cloudPlanTier.starter()；非 Cloud 或没有计划文件时 starter() 为 false，所以本地不会被这两条限制误伤（server/host/cloud-plan-tier.ts:23-33、server/host/starter-bot-limit.ts:30-40）。这两条是商业计划，不是技术配额，报告中只建议保留，不建议删除或绕过。

### 5.13 limits 配置块的接线状态

limits 的 10 个键都在 config.ts 的 strict schema 里，且 saveConfig 会把整块写入并刷新内存镜像（server/config.ts:325-336、:957-1059）。所以“改了 config.json 不生效”通常不是 schema 问题，而是调用点没有读 quotaLimits。当前明确没有接线的有两个：roomPostsPerTurn 和 botsPerWorkspace 的内部 create-bot/teamSetup 路径。

反过来，imagesPerDay、chatToolsPerRequest、mcpServers、attachmentsMaxBytes、roomPostsPerMinute、roomPostsWithoutReply、roomBreakerMinutes 都已经在各自模块里读 quotaLimits()。这轮修改把原先报告里的多个“硬编码”风险降级为“可配置”，但新增了两个半成品接线风险。

### 5.14 构造时机与惰性触发

启动期构造、但不在启动期执行动作的：createImageToolRoutes 在 server/index.ts:2843 创建图片工具和 ImageDailyCap 对象，但 cap 只是一个函数，真正 reserve 发生在图片工具被调用时（server/image-daily-cap.ts:30-44）。LimitResetClock 和 LimitFailovers 在 server/index.ts:8821、:8823 构造，构造时会读 limit-holds.json 和 limit-failovers.json；但 LimitResetClock.start() 在监听后的 server/index.ts:15522 才启动定时器。LimitNotices 在 createLimitTakeover 里构造（server/host/limit-takeover.ts:86），构造时读 limit-notices.json。cloudPlanTier 和 botLimit 在 server/index.ts:2863 构造。

监听后才跑的后台动作：startUpkeep 在 server/index.ts:15515 调用，内部用 setImmediate 先跑一次、再用 24 小时间隔跑 thread 日志 sweep（server/host/start-upkeep.ts:36-49）。因此“服务已经能接请求”不等于“日志已经扫过”；反过来说，启动阶段不会先删日志再监听。

只在路由或工具调用时触发的：图片 cap 在 POST /api/internal/images/generate 的 generateImageForTurn 里 reserve（server/routes/image-tools.ts:140-145）；房间预算在 post-to-room 路由里 decideRoomPost（server/index.ts:14052）；线程上限在 startTurn 和排队判断里（server/index.ts:7197-7203、:7630-7631）；花费上限在 directSendRefusal 和 startTurn 里（server/index.ts:7232-7236、:7620）；MCP 结果预算只在工具挂载/调用时生效（server/drivers/chat-mcp-tools.ts:612-615、server/mcp-gate.ts:169-205）。

独立进程的：MCP gate 是每个 MCP server 自己的子进程；它启动时才 new ResultStore，并在 SPILL_DIR 存在时 sweep 24 小时前的文件（server/mcp-gate.ts:118、:218）。因此 64MB 和 24 小时不是主进程启动就占用的内存或立即执行的删除；只有该 gate 被拉起时才存在。

配置镜像的时机：loadConfig 在 server/config.ts:820 调 setQuotaLimits，saveConfig 在 server/config.ts:1059 再调一次；所以通过 API 保存 limits 后，后续读取 quotaLimits 的模块立刻看到新值。手改 config.json 不会自动触发 loadConfig；要么等下一次配置读取，要么重启。这是“动态”的准确边界。

## 六、硬编码数字清单与外置判断

这张表只列“是否值得变成配置项”的判断，不重复主表的行为说明。判断标准是：用户可感知、会阻断正常工作、且不破坏安全边界的，优先外置；协议上限、内存保护和容器隔离参数，默认保留。

| 常量或位置 | 值 | 现状 | 是否应外置 |
|---|---:|---|---|
| IMAGE_DAILY_CAP（server/image-daily-cap.ts:11） | 50 张/安装/本地日 | 默认值；limits.imagesPerDay 可配 1 到 1,000,000 | 已可配置，保留默认 |
| IMAGE_MAX_PER_TURN_DEFAULT（shared/image-generation.ts:5） | 4 张/回合 | 默认值；imageGen.maxPerTurn 可配 1 到 10 | 已可配置 |
| IMAGE_PROMPT_MAX_CHARS（server/drivers/agents-image-tools.ts:4） | 4000 字符 | 无配置 | 可保留，属输入保护 |
| SENDER_MAX（server/room-post-budget.ts:29） | 10 条/60 秒 | 默认值；limits.roomPostsPerMinute 可配 1 到 1000 | 已可配置 |
| SENDER_WINDOW_MS（server/room-post-budget.ts:28） | 60,000ms | 固定窗口 | 可保留；如果改速率，窗口也可能要外置 |
| DUPLICATE_WINDOW_MS（server/room-post-budget.ts:30） | 60,000ms | 无配置 | 可保留，防重复刷屏 |
| RING_WINDOW_MS（server/room-post-budget.ts:31） | 120,000ms | 无配置 | 可保留，防环 |
| DEFAULT_BREAKER_MINUTES（server/room-post-budget.ts:32） | 5 分钟 | 默认值；limits.roomBreakerMinutes 可配 1 到 1440 | 已可配置 |
| ESCALATE_MAX（server/room-post-budget.ts:34） | 2 条/5 分钟 | 默认值；limits.roomPostsWithoutReply 可配 0 到 1000 | 已可配置 |
| MAX_ROOM_POSTS_PER_TURN（server/index.ts:1630） | 3 条/回合 | 仍硬编码；limits.roomPostsPerTurn 已声明未接线 | 应接线，默认保持 3 |
| ROOM_POST_MAX_CHARS（server/index.ts:9659） | 4000 字符 | 无配置 | 应外置，或按房间配置 |
| MAX_ATTACHED_FILES_PER_TURN（server/index.ts:1629） | 10 个/回合 | 无配置；limits.attachmentsMaxBytes 管字节不管个数 | 应外置 |
| MAX_THREADS_OPENED_PER_TURN（server/index.ts:7387） | 5 个/回合 | 无配置 | 应外置 |
| MAX_CREATED_BOTS_PER_TURN（server/index.ts:1631） | 4 个/回合 | 无配置 | 应外置 |
| MAX_WORKSPACE_BOTS（server/index.ts:1829） | 100 个/workspace | 默认值；limits.botsPerWorkspace 可配 1 到 100,000，但内部路径未接线 | 完成接线，保留默认 |
| MAX_CREATED_BOT_INSTRUCTIONS（server/index.ts:1632） | 4000 字符 | 无配置 | 可保留，属输入保护 |
| MAX_CONCURRENT_BOT_THREADS（server/bot-thread-limits.ts:8） | 16 个/bot 默认 | 默认值；limits.botThreads 和 threads.maxConcurrentPerBot 可配 1 到 1024 | 已可配置 |
| MAX_BOT_THREADS_SETTING（server/bot-thread-limits.ts:10） | 1024 个/bot | 配置 schema 硬上限 | 保留，防止误设过大 |
| CHAT_TOOL_LIMIT（shared/tool-budget.ts:2） | 128 个工具默认 | 默认值；limits.chatToolsPerRequest 可配 1 到 10,000 | 已可配置 |
| SERVER_TOOLS_MAX（server/drivers/chat-mcp-tools.ts:71） | 2000 个工具/server | 无配置 | 保留，属 MCP 保护 |
| PIDS_LIMIT（server/container-limits.ts:3） | 4096 PIDs | 无配置；旧值 512 自动升 | 保留，按机器规格外置可另议 |
| 容器内存/CPU（server/container-computer.ts:855-878） | 4GB/4GB/2 核 | 无配置 | 应外置，重负载桌面明显不够 |
| DEFAULT_CONTEXT_WINDOW（server/context-budget.ts:4） | 128000 tokens | 无配置 | 应外置或强制模型目录声明 |
| DEFAULT_REBUILD_BYTES（server/context-rebuild.ts:156） | 24000 bytes | 已有 context.rebuildBytes 1024 到 1,000,000 | 已可配置 |
| maxMessages 默认（server/context-rebuild.ts:193） | 40 条 | 无配置 | 应外置，和上下文窗口联动 |
| HARNESS_CALL_BUDGET_MS（server/harness-budget.ts:4） | 120,000ms | 无配置 | 应外置，慢网页和长任务需要 |
| HARNESS_PROXY_TIMEOUT_MS（server/harness-budget.ts:2） | 130,000ms | 无配置 | 可与上项一起外置 |
| DEVICE_PROXY_TIMEOUT_MS（server/harness-budget.ts:10） | 705,000ms | 无配置 | 保留，已有明确业务和余量 |
| COMPUTER_COPY_BUDGET_MS（server/harness-budget.ts:13） | 540,000ms | 无配置 | 保留，2GiB 复制需要 |
| DEFAULT_RESULT_BUDGET（server/mcp-trim.ts:1） | 8000 字符 | 已有每 server 配置和环境变量 | 已可配置，默认保留 |
| ResultStore 64MB（server/mcp-shape.ts:17） | 67,108,864 bytes | 无配置 | 保留，属内存保护 |
| SAVED_RESULTS_KEPT（server/drivers/chat-mcp-tools.ts:321） | 20 个文件 | 无配置 | 应外置，或至少告知用户会删旧结果 |
| LEARNED_MAX（server/tool-count-limit.ts:83） | 500 个 key | 无配置 | 保留，属内存保护 |
| MAX_BOTS（server/tool-budgets.ts:3） | 1000 个 bot | 无配置；workspace 可配到 100,000 | 应外置或跟随 workspace 上限 |
| UNKNOWN_RESET_WAIT_MS（server/limit-failover.ts:71） | 3,600,000ms | 无配置 | 保留，避免频繁撞限额 |
| UNNAMED_LIMIT_MS（server/limit-resets.ts:98） | 3,600,000ms | 无配置 | 保留，遵守 provider 限额 |
| UNNAMED_STRETCH_MS（server/limit-notices.ts:14） | 10,800,000ms | 无配置 | 保留，减少重复通知 |

## 七、统计

**总条数 53 条。** 按前缀：C 22 条、L 5 条、A 13 条、Q 13 条。

| 统计维度 | 计数 | 编号 |
|---|---:|---|
| 建议保留 | 39 | C2、C3、C4、C6、C7、C9、C10、C11、C12、C13、C14、C16、C18、C20、C21、C22、A1、A2、A3、A6、A7、A8、A9、A13、Q1、Q2、Q4、Q5、Q6、Q7、Q8、Q9、Q10、Q11、Q12、Q13、L3、L4、L5 |
| 建议改可配置 | 12 | C1、C5、C8、C15、C17、C19、A4、A5、A10、A11、A12、Q3 |
| 建议默认关闭（保持） | 2 | L1、L2 |
| 建议删除 | 0 | 无 |
| 技术限制 | 48 | C 全部 22 条、L 全部 5 条、A 全部 13 条、Q1 到 Q8 共 8 条 |
| 商业许可 | 5 | Q9、Q10、Q11、Q12、Q13 |

## 八、建议表与删除后的最坏后果

| 建议 | 编号 | 执行后的最坏后果 |
|---|---|---|
| 保留 | C2、C3、C4、C6、C7、C9、C10、C11、C12、C13、C14、C16、C18、C20、C21、C22、A1、A2、A3、A6、A7、A8、A9、A13、Q1、Q2、Q4、Q5、Q6、Q7、Q8、Q9、Q10、Q11、Q12、Q13、L3、L4、L5 | 删除这些保护后，最坏会出现上下文溢出、provider 400、MCP 进程 OOM、房间 bot 循环、容器 fork 炸弹、月度超支、Starter 计划被突破、旧工具结果无限增长或对话无法回切。它们不是“看起来有风险”，而是有明确触发条件的技术边界。 |
| 改可配置 | C1、C5、C8、C15、C17、C19、A4、A5、A10、A11、A12、Q3 | 如果把硬编码直接删除而不给替代值，最坏后果分别是：未知模型按错误窗口压缩或溢出；重放历史过少导致回答断片；慢网页全部超时；保存结果无限占磁盘；4GB/2CPU 容器被重负载拖死；线程和 bot 扇出耗尽内存；房间发言或附件/线程/bot 数量失控；90% 预警和 60 秒调度缓冲消失。建议保留默认值，只增加配置入口或完成已有配置的接线。 |
| 默认关闭（保持） | L1、L2 | 这两项已经默认关闭。若默认打开，最坏后果是用户在没有预期的情况下丢失 thread 的 events/ 和 native/ 日志；SQLite 聊天记录还在，但事件回放、审计和排障材料会消失。L1 是整文件删除，L2 是静默裁掉旧半段，二者都不可逆。 |
| 删除 | 无 | 本次没有建议直接删除的配额。唯一可以考虑的“删除”是合法的产品降级：移除 enterprise/ 目录，让 budgets、Starter 计划、白标、托管工作区等 entitlement 一起失效。这不是绕过许可，而是承认 OSS 版没有这些商业功能；降级后月度预算拦截和 Starter 限制都会消失，hosted workspace 相关能力还会 503。 |

**会删除用户可见数据的三项，必须高亮：**

1. **L1 thread-retention（默认关闭，配置后启用）。** 删除的是 events/ 和 native/ 的 NDJSON 日志，不是 SQLite 的聊天消息。触发条件是线程已关闭或归档、超过保留天数、且不忙、不未读、没有 handoff。删了不能从 Store 还原事件日志（server/thread-retention.ts:1、:22-47）。
2. **L2 eventLogMaxBytes（默认关闭，配置后启用）。** 超过上限后把日志裁到最新一半，按行切；没有提示，也没有备份。裁剪后旧事件不可恢复，但 SQLite 消息仍在（server/thread-log-rotation.ts:18-27、:45-63）。
3. **C15 保存的 MCP 大结果（默认启用，但有 50KB 门槛）。** 每个工作目录只保留最新 20 个 mcp-results 文件，旧的直接删除；这是工具结果文件，不是聊天记录（server/drivers/chat-mcp-tools.ts:319-330）。

**不会删除用户数据的：** A1 image-daily-cap 只拒绝生成；A4 到 A9 room-post-budget 只拒绝发言并把拒绝状态保存在内存；C18 bot-thread-limits 只拒绝或排队；Q9 spend cap 只拒绝新回合；C16/C17 只限制容器资源。它们的影响是“功能暂时不可用”，不是“数据消失”。

## 九、风险 Top 10

| 排名 | 编号 | 风险 | 理由 | 建议动作 |
|---:|---|---|---|---|
| 1 | L1 | **自动删除 thread 日志** | 配置 eventLogRetentionDays 后，关闭或归档超过 N 天的线程会被删除 events/ 和 native/ NDJSON；这是不可逆的用户可见数据丢失。默认关闭，但一旦管理员打开就可能批量发生。 | 保持默认关闭；UI 明确显示“会删除事件日志”；提供导出或 dry-run；不删除 SQLite 消息。 |
| 2 | L2 | **静默裁剪 thread 日志** | eventLogMaxBytes 只保留最新一半，没有日志、没有提示、没有备份；排障时旧事件已经没了。 | 默认关闭；开启时记录一次审计事件并在 UI 显示；提供保留副本选项。 |
| 3 | C15 | **自动删除旧 MCP 大结果** | 每个工作目录只留 20 个 mcp-results 文件；旧文件被 unlink。用户可能把文件当长期结果。 | 改成可配置；删除前写审计；或在 UI 说明“只保留最近 20 个”。 |
| 4 | A4 | **roomPostsPerTurn 配置已声明但没接线** | 管理员把 limits.roomPostsPerTurn 改成 10，server/index.ts 仍按 3 拒绝；这是配置假生效，容易误导排障。 | 把 roomPostsPerTurn 接进 server/index.ts，保留默认 3；写测试覆盖 3 和 10。 |
| 5 | A12 | **botsPerWorkspace 只接线一半** | 普通 /api/bots 创建会读新上限，但内部 create-bot、teamSetup 仍用 100；同一工作区会出现“人能创建更多、bot 不能”的不一致。 | 让内部 create-bot 和 teamSetup 也调用 maxBotsPerWorkspace；保留默认 100。 |
| 6 | C1 | **未知模型一律按 128k 估算** | 小窗口模型可能在真实窗口更小时仍按 128k 估算，导致 provider 溢出；大窗口模型又会被过早压缩。 | 改可配置或强制模型目录声明；压缩前用 provider 上报值优先。 |
| 7 | C20 | **MCP 结果默认 8000 字符，可能丢关键内容** | 复杂 JSON 被结构化裁剪，模型只看到句柄和横幅；如果模型不会用 query_result，就会基于不完整数据回答。 | 保留默认，但按 server 配置；在 UI 显示被裁剪的 server 和原始大小；对关键 server 设更大预算。 |
| 8 | A8 | **房间环熔断状态只在内存** | 重启后 roomPostBudgets 清空，冷却状态消失；如果 bot 仍在循环，重启后可能马上再次形成环。 | 保留检测；把 breaker 状态持久化，或至少在重启后冷却一段时间；阈值可配置。 |
| 9 | C19 | **tool-budgets 的 1000 bot 上限会成为新瓶颈** | limits.botsPerWorkspace 可到 100,000，但工具预算元数据只记 1000 个 bot；超过后 /api/mcp-servers 的 budget 信息会丢最旧。 | 让 tool-budgets 上限跟随 botsPerWorkspace，或改成可配置。 |
| 10 | Q9 | **月度预算上限只在 entitlement 下生效** | 没有 budgets entitlement 时，配置了 monthlyUsd 也不会拦截，可能超支；这是商业边界，不是代码 bug。 | 保留商业边界；在 UI 明确显示“未启用预算保护”；不要建议绕过 entitlement。 |

## 十、未决问题与证据缺口

1. **没有运行编译和测试。** 因此不能确认类型检查、构建和测试是否通过；本报告只对静态代码和行号负责。00-baseline.md 的 BLOCKED 与当前 node_modules 存在性不一致，08-evidence-audit.md:13 已指出这一点；正式验收前应重新采集基线。
2. **没有实际触发 429/409。** 图片、房间、附件、线程、bot、花费的 HTTP 状态是从代码分支读出的，没有启动服务做端到端验证；前端是否把每个错误都展示给用户也没有验证。
3. **本轮并行修改仍在进行。** 12:21 到 12:22 新增的 limits 配置只完成了部分接线：roomPostsPerTurn 和 botsPerWorkspace 的内部路径还没接。主线程可能在本报告写完后继续改这些文件；合并前必须重新跑一次引用抽查。
4. **thread-retention 的 UI 入口没有追。** 当前能确认 threads.eventLogRetentionDays 和 eventLogMaxBytes 在 config schema 和运行时代码里存在，但没有逐页检查设置界面是否暴露这两个键；如果只能手改 config.json，普通用户不会误开，风险更低。
5. **图片日上限的时区依赖进程 TZ。** server/time-zone.ts:30-41 会在 Cloud 启动时采纳保存的时区，但本报告没有动态验证 createImageDailyCap 创建时 TZ 已经生效；静态上它用的是 Date 的本地 getter，因此结论是“进程本地日”，不是固定 UTC。
6. **图片计数写盘失败会绕过上限。** settle 写盘失败只 console.warn，下一次 madeToday 读不到新计数；没有测试“磁盘满时仍可继续生成多少张”，只能标注为推断的绕过路径。
7. **容器 PIDs 升级没有实机验证。** Docker/Podman 对运行中容器执行 update --pids-limit 的成功率、旧容器 512 的实际影响、4GB/2CPU 对 Firefox 多标签的余量，都没有在本机动态测试；代码只能证明发出了命令并吞掉错误。
8. **EAC_MCP_RESULT_BUDGET 的环境变量路径没有上限。** 每 server 的配置 schema 上限是 2,000,000，但 mcp-gate-config.ts:24-29 对 env 只校验有限且不小于 0；如果环境变量设得很大，gate 会接受。这个变量是运维内部配置，不是普通用户入口，但仍应在上限上统一。
9. **limit-takeover 与 quota-switch 只做了调用点审计。** 本报告确认了默认开启、备份限制和持久化文件，但没有逐行审计 server/host/limit-takeover.ts 的全部选模逻辑；那部分属于供应商配额与自动恢复，不是本次文件清单的核心。
10. **02 的 G-28 到 G-57 还有本报告未重复的相邻上限。** 例如附件 25MB、MCP server 20 个、邮箱 10 个、手机 20 台、团队 200 人、Local VM 8 个、webhook 10 次/分钟、app event 20 条/48k。它们不在本次文件清单内，建议以 02 为准，不要在本报告里重复计数。

## 十一、引用抽查记录

写完后用 rg -n 和带行号 Get-Content 抽查了 16 个高风险引用。下表是抽查目标、实际命中的行号和判断；这 16 条均与主表一致。

| 抽查项 | 引用 | 实际命中 | 判断 |
|---|---|---|---|
| 图片日默认值 | server/image-daily-cap.ts:11 | export const IMAGE_DAILY_CAP = 50; | 命中 |
| 图片日动态读取 | server/image-daily-cap.ts:31 | const cap = (): number => options.cap ?? quotaLimits().imagesPerDay ?? IMAGE_DAILY_CAP; | 命中 |
| limits schema | server/config.ts:325-336 | botsPerWorkspace、botThreads、imagesPerDay、roomPostsPerTurn 等 10 个键 | 命中 |
| 线程默认值 | server/bot-thread-limits.ts:8 | export const MAX_CONCURRENT_BOT_THREADS = 16; | 命中 |
| 线程配置上限 | server/bot-thread-limits.ts:10 | export const MAX_BOT_THREADS_SETTING = 1_024; | 命中 |
| 线程拒绝 | server/index.ts:7631 | throw Object.assign(new Error(botThreadLimitText(...)), { status: 409, code: "thread_limit" }); | 命中 |
| 房间默认速率 | server/room-post-budget.ts:29 | const SENDER_MAX = 10; | 命中 |
| 房间可配速率 | server/room-post-budget.ts:60 | senderMax: positiveLimit(configured.roomPostsPerMinute, SENDER_MAX), | 命中 |
| 房间每回合硬编码 | server/index.ts:1630 | const MAX_ROOM_POSTS_PER_TURN = 3; | 命中 |
| 房间每回合配置 | server/room-post-budget.ts:38-40 | roomPostsPerTurn() 导出，但 index 未引用 | 命中 |
| 工具默认上限 | shared/tool-budget.ts:2 | export const CHAT_TOOL_LIMIT = 128; | 命中 |
| 工具动态读取 | server/tool-count-limit.ts:134 | quotaLimits().chatToolsPerRequest ?? CHAT_TOOL_LIMIT | 命中 |
| MCP 结果默认值 | server/mcp-trim.ts:1 | export const DEFAULT_RESULT_BUDGET = 8_000; | 命中 |
| 容器 PIDs | server/container-limits.ts:3 | export const PIDS_LIMIT = 4096; | 命中 |
| thread 日志删除 | server/thread-retention.ts:34 | for (const dir of [EVENTS_DIR, NATIVE_DIR]) { | 命中 |
| 月度预算 entitlement | server/spend.ts:81 | if (!isEntitled("budgets") || ... ) return null; | 命中 |

**结论：** 主表的高风险数值和删除路径没有发现行号漂移。唯一需要保留的限定是：所有引用都是 2026-11-14 12:22 左右当前工作树口径，不是冻结的 781c57e 快照；合并前应再跑一次同样的抽查。
