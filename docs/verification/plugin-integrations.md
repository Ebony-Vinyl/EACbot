# 业务插件与深度联动验收设计

状态：2026-11-07 设计，2026-11-08 官方插件包与宿主事件通路已实现（见下），仍不是已通过报告。基线环境、证据和清理遵循[插件平台验收](plugin-platform.md)及[验证入口](README.md)。业务实现详见[集成设计](../superpowers/specs/2026-11-07-eac-integrations-design.md)。

## 0. 当前已实现范围（2026-11-08 第二批更新）

**官方插件包已随本仓库实现**（`plugins/eac/`，能力矩阵与限制见其 README，测试见 `server/plugins/bundled.test.ts`）：health（全本地 production）、home-assistant（REST 读写 production）、bilibili（搜索/信息/热门 production；点赞/评论 experimental，需 Cookie+grant）、muse（酷狗公开搜索 + 队列/播放状态机 production；真实出声需要播放端回报回执）、tieba（草稿 production；HTML 读取/回帖 experimental）、xianyu（知识库/规则 production；商品搜索 experimental）、douyin / xiaohongshu（选题/素材/草稿/计划 production，本地工作台）。

**宿主事件通路已接通**：`POST /api/platforms/inbound` 现在把 `delivered` 事件投给绑定 Bot 的持久线程（`unattended` + webhook 不可信边界），回复进入 per-account outbox（`GET .../outbox`、`POST .../outbox/ack`）。隔离 fixture 已验证 QQ 账户 → 绑定 → 入站 202 → fake 引擎回复 → outbox → ack（见[插件平台验收](plugin-platform.md)第二批证据）。

扩展仓库 `Ebony-Vinyl/eacbot-extensions` 的 `plugins/eac/qq` 提供 OneBot 11 HTTP 工具适配器：`send-message` 与 `read-messages`，只声明公共 OneBot 11 能力。在该仓库内运行 `npm test`（`node --test` 执行其 fake 用例）。

3 个用例通过：握手、发送/读取、非法参数拒绝、未知工具 JSON-RPC 错误。发送超时或网络错误返回 `indeterminate`，不盲目重试；非法参数在联系 OneBot 前拒绝。

尚未实现，不能算作 QQ-01/02/03 通过：

- SnowLuma、MaiBot、AstrBot 的具体接口 revision、主处理互斥与真实账号联调。
- 独立 QQ Bot 侧边栏的完整会话、看板、TTS/桌宠与 Muse 点歌串联。
- 各插件标注 experimental/unavailable 的能力（真实发布、真实账号数据、真实播放出声）。

## 1. 测试分层

每项记录三列：合同/fake、真实服务、实机 UI/音频。假服务不需要真实凭据；真实测试另行授权，限定账户、收件人、额度、设备和清理。生产账号/群聊/交易不是默认 fixture。

平台写接口未开放、账号未授权、设备缺失标“阻断/未验证”，不能标通过或用 mock 补充成真实支持。不要在本文新增尚未实现的 API/测试路径；实现后通过正式 recipe 映射到可运行命令。

## 2. 模型、语音与音频

| ID | 输入/故障 | 必须观察 |
| --- | --- | --- |
| MODEL-01 | fake OFM 与自定义供应商的文本/视觉/tools、流式/非流式、取消 | 复用现有驱动；工具和结果正确；不会启动另一个 Agent；密钥不出现在 UI/日志 |
| MODEL-02 | 401/403/429/Retry-After、断流、畸形分片、fallback、未知费用 | 恢复建议和退避有限；不偷偷更换数据出口；免费与 unknown 区分 |
| MODEL-03 | 配置实际 New API/NVIDIA TTS/STT/video 模型；分别合同和真实调用 | 记录端点/编码/采样率/输入输出/计量；未支持则明确 unavailable；模型名不足以通过 |
| VOICE-01 | 分段延迟返回音频，长文本、多语言和旧 provider 回归 | 首片在末片到达前实际解码播放；队列有界；不能全缓冲后分块假称实时 |
| VOICE-02 | 打断、取消、乱序、旧 generation、网络掉线、provider 错误 | 旧音频不继续播、不串会话；状态收敛；重连不重复旧 utterance |
| VOICE-03 | 无 AEC、拒绝麦克风、浏览器无 autoplay 手势、设备离线 | 半双工/等待手势/离线提示正确；不假报全双工或正在播放 |
| MEDIA-01 | 音乐播放中 TTS 插入；期间用户暂停/切歌/调音量 | 焦点正确降音量/暂停；旧 lease 不覆盖新状态；桌宠只随 TTS 说话；缺插件仍可运行 |

音频延迟分模型生成、首片合成、传输、解码与实际播放记录，使用固定 fake 延迟建立基线；真实 provider 测量注明网络/硬件。不能将 mock 延迟目标写成对所有云模型的 SLA。

## 3. 任务与用量

| ID | 输入/故障 | 必须观察 |
| --- | --- | --- |
| TASK-01 | 创建/分配/依赖/评论/产物/审查，非法拖拽状态转换、revision 冲突 | running 由执行器推进，review/done 有真实产物；并发不覆盖；看板与运行状态一致 |
| TASK-02 | 两 worker 竞争、lease 到期、崩溃/重启、重复完成事件 | 单一认领；恢复不双重派工；结果不明外发先核验，不卡死也不无限重试 |
| TASK-03 | fake clock 覆盖时区/DST、漏跑、休眠、重启、取消、审批等待 | RoutineManager 唯一调度来源；规则明确且不会多发；取消/撤销后不执行 |
| USAGE-01 | 一个任务含父/子 Bot、插件、失败重试、多 provider、旧历史行 | 每调用只计一次，聚合不双计；trace/账户作用域正确，历史仍可读 |
| USAGE-02 | 文本 token、TTS 字符/时长、STT/视频时长、free/unknown/estimated/actual | 单位/币种/定价来源正确；unknown 不变零；预算阻断和导出无正文/秘密 |

## 4. QQ、B站与国内平台

| ID | 输入/故障 | 必须观察 |
| --- | --- | --- |
| QQ-01 | 两账户、群/私聊、重复事件/回声、掉线/重连、登录过期 | 不串号不双发；确认 send 回执；不明发送暂停核验；群成员不变主人 |
| QQ-02 | EAC 主处理与 MaiBot/AstrBot 委派切换，SnowLuma/官方适配能力差异 | 一消息一个主处理者；支持范围清楚；循环被阻断；未支持身份/取消明确标注 |
| QQ-03 | 获授权消息触发 Muse 点歌、TTS、桌宠、任务；未授权成员尝试同动作 | 共享能力与状态；目标设备检查；拒绝越权；本地播报不等于 QQ 音频已发送 |
| BILI-01 | 搜索→字幕/抽样内容→研究报告→Kanban 待验收→面板→授权兴趣空间 | 来源/时间点/覆盖范围真实；各入口同一产物；不将外部字幕指令当授权 |
| BILI-02 | 写默认关、授权后操作、配额、重复请求、登录过期/接口失效 | 每项权限分开；回读/不明结果正确；未验证写接口不可标 production |
| SOCIAL-01 | 闲鱼/抖音/小红书/贴吧安装、账户绑定、现有 Bot/独立 Bot、看板筛选 | 插件贡献自动出现；无平台核心分支；各账户数据与任务隔离；缺接口真实标注 |
| SOCIAL-02 | 消息→知识草稿→逐次批准/规则内回复→回执；测试改价/发布/删除 | 分级授权生效；普通回复授权不覆盖高影响动作；篡改参数重新审批 |
| SOCIAL-03 | 限频、验证挑战、断线、重复消息、发送后失联、撤销/取消 | 遇验证暂停不绕过；不盲重试；停用后不继续发送；异常队列可人工接管 |

## 5. EAC Muse 专项

Muse 必须直接基于 KugouMusic.NET 的实际可复用实现，不以换后端替代需求。SDK 和媒体合同就绪后，专门实现与独立验收角色分别提供记录。

| ID | 故事/操作 | 验收结果 |
| --- | --- | --- |
| MUSE-01 | 从市场安装→配置/登录→搜索→播放→暂停/切歌→歌单/歌词→重启→卸载 | 空环境依赖明确；实际能听到音频；账号可退出并清凭据；Bot 不受卸载影响；记录上游 revision/署名 |
| MUSE-02 | “这首不喜欢”“刚才那首收藏”“播完再切”，期间异步切歌 | 操作绑定正确 track/queue/session/revision；冲突重新取快照，不误收藏另一首 |
| MUSE-03 | “专注两小时不要人声”、改变临时偏好、允许/拒绝保存、跨 Bot 共享指定空间 | 有真实队列和可取消停止任务；推荐依据真实；临时/长期分开；无数据时不伪造音乐特征 |
| MUSE-04 | TTS 插播、桌宠说话、手动暂停/切歌/改音量、取消 TTS | 恢复只发生于匹配 lease/generation；用户操作优先；音乐不会驱动嘴形说话 |
| MUSE-05 | 聊天、Muse 面板、QQ 与定时任务交替点歌；设备掉线与重复事件 | 同一目标设备只有一份队列；授权/幂等一致；过期命令不突然补播；共享记忆不共享账户权限 |
| MUSE-06 | VIP/下架/无权限/无手势/网络失败/登录失效/外部收藏不明 | 不假报播放；提供允许范围候选或恢复入口；不自动付费/绕版权；不明写入不重复 |

“工具返回成功”不足以通过 MUSE-01/04/05；必须有客户端实际播放事件、UI 状态与人工听音/录制观察。自动采集音频证据须限定测试素材和授权，不记录私人对话。

## 6. 健康、家居与设备

| ID | 输入/故障 | 必须观察 |
| --- | --- | --- |
| HEALTH-01 | 手工/文件导入、单位/时区/缺失/异常值、趋势、提醒、删除/导出 | 记录可校验、非诊疗；错误不生成误导趋势；删除覆盖派生索引/缓存 |
| HEALTH-02 | 普通群成员/其他 Bot 检索健康记录，尝试未经许可发给 OFM | 按数据类型/受众/出口拒绝；不默认共享或上传；审计不含健康正文 |
| HOME-01 | HA 只读→已授权灯光→未授权实体/门锁，凭据过期 | 实体 allowlist 生效，敏感控制单独确认；回读状态，不只报告请求已发 |
| DEVICE-01 | 模拟设备配对、能力缺失、离线、TTL、重连、撤销、重复命令 | 设备身份与能力验证；过期不执行；撤销不能旧 token 复用；明确仅模拟器通过 |

## 7. 宿主

| ID | 操作 | 期望 |
| --- | --- | --- |
| HOST-01 | Web/Electron/Tauri 的能力协商与既有 bridge 合同 | 同一 React/Node 行为，未实现能力 unsupported；旧 Electron 不回归 |
| HOST-02 | Windows 安装、服务起停、端口冲突、单实例、托盘、桌宠透明置顶、权限、更新 | 实际运行/清理/恢复正常；更新签名验证，不只构建通过 |
| HOST-03 | 本地/远端切换、配对设备权限，Linux/macOS 对应安装包 | 远端无默认本地权限；各 OS 分别记录通过/未验证，不借 Windows 结果覆盖 |

## 8. 联合发布故事

至少一条完整记录串联：安装 QQ/OFM/Muse → 建独立平台 Bot → 选择共享偏好空间 → QQ 授权点歌 → Bot 选模型/工具 → 客户端播放 → TTS/桌宠让出焦点 → Kanban/用量关联同一 trace → 停用 Muse 后 Bot 继续聊天。

另一条记录：B站研究 → 带来源产物 → 共享已批准兴趣 → 自然语言面板 → 撤销空间后确认下次模型请求不含旧内容。

发生真实外发后记录外部不可逆影响；回滚应用不能声称撤回已发消息。报告列出失败/跳过/限制，不以“不知道有问题”作为“所有功能正常”。


## M6 代码与本机验收（2026-11-14）

本次改动影响范围是任务、调度接入、用量及对应界面模块。实现基线为 `1928a44`，按任务领域、计量、宿主组合、界面、插件面板与验收文档分层提交。环境为 macOS、Node 24.22.2、pnpm 10.33.0、Electron 43.7.9。

### 代码范围

- `shared/plugins/tasks.ts`、`server/plugins/kanban.ts`、`server/tasks/runtime.ts` 与 `/api/boards` 提供任务、依赖、版本、评论、产物、归档和账户过滤。账户由绑定 Bot 派生。
- 任务执行及一次性/Cron 计划接入既有 RoutineManager。状态变化映射回任务，执行结果保留在实际会话并记录到产物。恢复读取持久 run，旧事件按 run 身份与创建时间过滤，取消计划回到待办。
- `server/usage-metering.ts`、`server/host/usage-metering.ts` 和 `/api/usage/metering` 复用原账本及支出规则。文本、插件、服务端 TTS/STT、图片生成在实际入口计量，视频使用共享单位合同。费用来源、币种、未知费用、重复记录与父子归因分别处理。
- 侧栏任务中心、用量页、声明式和沙箱面板消费同一服务。任务页面使用现有主题，窄屏采用分组布局。

### 自动验证

最终一轮执行以下定向测试。

```sh
pnpm exec vitest run server/tasks server/plugins/kanban.test.ts server/routes/boards.test.ts server/usage-metering.test.ts server/routines.test.ts server/routines-startup.test.ts server/routine-recovery.test.ts server/routine-cron.e2e.test.ts server/usage-ledger.test.ts server/usage-ledger-api.test.ts shared/plugins/panel-frame.test.ts server/host/plugins-mcp.test.ts server/plugins/registry.test.ts server/routes/tts.test.ts server/routes/image-tools.test.ts scripts/testing/index-route-ratchet.test.ts scripts/testing/file-size-ratchet.test.ts
pnpm build
pnpm lint
pnpm check:contrast
pnpm i18n:check
git diff --check
```

| 检查 | 实际结果 |
| --- | --- |
| 定向测试 | 18 个文件、379 项通过。另 1 个文件体积守护测试失败，报告下述三项基线问题 |
| TASK-01 | 执行器状态、依赖环、版本冲突、账户过滤、评论与产物、真实会话执行及权限拒绝已验证 |
| TASK-02 | 租约竞争/过期接管、旧执行器拒绝、重复完成、执行器重启后单次恢复已有覆盖 |
| TASK-03 | 既有 RoutineManager 的计划、重试、恢复与 Cron 回归通过。新增任务计划取消和完整后端恢复通过 |
| USAGE-01/02 | 旧账本兼容、任务归因、重复调用去重、汇总行、多币种、不同单位、未知费用、分页与脱正文 CSV 已验证 |
| `pnpm build` | 通过，包含前后端 TypeScript 和 Vite 构建。保留既有 CSS highlight、Zod 注释及大 chunk 警告 |
| `pnpm lint` | 通过 |
| `pnpm check:contrast` | 通过，仍报告 midnight 已登记基线缺口 |
| `git diff --check` | 通过 |
| `pnpm i18n:check` | 失败，已有 stale translations 阻断，本次 `tasks.*` 键未出现在报错中 |

体积守护报告 `server/config.ts` 1268 行、`src/components/PluginsPanel.tsx` 1019 行、`src/state/store.tsx` 3362 行。这三个文件相对基线无改动。`server/index.ts` 与 `Sidebar.tsx` 均满足各自棘轮。

后端恢复测试复制隔离数据，对 SQLite 使用一致性 backup，再在独立新进程读取任务、执行结果、计划状态和用量。过程中使用仓库 fake 引擎及临时目录。

### 本机 Electron 操作

运行仓库 Electron 主进程、Vite 前端及独立 fixture 后端，使用实际窗口完成以下操作。

1. 通过侧栏打开任务中心，在界面创建看板与中文标题任务，分配 Bot 并保存说明。
2. 点击立即执行，观察运行、待验收及实际输出，再在界面标记完成并添加评论。
3. 保存 `0 9 * * *`、`Asia/Shanghai` 的 Cron 计划，检查下一次执行时间。
4. 取消计划，修正并复核卡片回到待办。归档与恢复操作已执行。
5. 打开统一用量，查看真实 fixture 调用记录，切换任务分组并核对任务归因。
6. 最终版本在新 fixture 中再次执行任务、保存/取消 Cron，并复核待办状态及用量结果。

最终截图使用纯隔离数据。

- [任务中心与取消后的状态](evidence/m6/electron-final-board.png)
- [统一用量与调用明细](evidence/m6/electron-final-usage.png)

### M6 界面重排

本次改动影响范围是任务中心前端模块。复用现有主题色，使用紧凑工具栏、可收起筛选、按需新建表单、横向看板和独立详情侧栏。执行计划默认收起，用量筛选与表格同步调整间距。

验证预算为 5 轮，实际完成 4 轮。`pnpm typecheck`、`pnpm build`、`pnpm lint`、`pnpm check:contrast` 和 `git diff --check` 通过。定向执行 `pnpm exec vitest run server/tasks server/routes/boards.test.ts`，4 个文件、32 项测试通过。构建与对比度检查保留前文列出的既有警告。

本机 Electron 连接独立 fixture，完成中文任务创建及 Enter 提交、详情打开与 Escape 关闭、来源筛选、筛选收起以及统一用量表格检查。窗口检查覆盖 1040 和 1512 逻辑像素宽度。此次未执行手机硬件或全量测试。

- [重排后的看板](evidence/m6/electron-layout-board.png)
- [任务详情侧栏](evidence/m6/electron-layout-details.png)
- [重排后的用量页](evidence/m6/electron-layout-usage.png)

分层提交后再次执行 `pnpm typecheck`、`pnpm lint` 与 `pnpm exec vitest run server/tasks server/plugins/kanban.test.ts server/routes/boards.test.ts server/usage-metering.test.ts shared/plugins/panel-frame.test.ts`。类型与静态检查通过，7 个文件、45 项定向测试通过。测试进程报告 exit listener 数量警告。全量测试尚未执行。

### 验证边界与恢复

未指定 Bot 的通用语音请求计量归入首个可见 Bot，TTS 请求携带 Bot 时按该 Bot 归因。

本机 Electron 验证使用隔离 fake 引擎。真实模型/媒体供应商计费、真实视频调用、真实平台账户和手机硬件尚未验证。390×844 浏览器视口完成文档宽度检查，未据此声明手机实机验收。全量 `pnpm test` 未运行。

停止验收 fixture 后，开发后端恢复使用原数据目录，Electron 恢复原有桌面配置。功能数据新增在运行时数据目录的 `tasks/kanban.json`，旧任务与旧账本行继续可读，新计量信息使用可选字段。回退代码前先停用新增任务计划并停止执行，保留任务文件及账本备份。
