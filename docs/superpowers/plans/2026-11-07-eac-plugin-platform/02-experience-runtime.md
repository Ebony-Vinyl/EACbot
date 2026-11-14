# M4–M6：平台 Bot、共享记忆、UI 与模型媒体 Implementation Plan

## Context

依赖 M1/M2 的真实合同。新增功能复用当前 Bot、记忆、调度与用量路径，不因插件化建立重复系统。下列任务保留原始验收清单。M4 当前实现与验证状态见本节进展，M5/M6 按各自代码状态推进。

**Goal:** 使平台身份、记忆、界面、任务和媒体在同一 Bot 运行时协作。

**Architecture:** 先身份/受众和共享数据，再 UI 和模型媒体；Kanban 作为既有任务执行的产品视图。

**Tech Stack:** 现有 TypeScript/React、Markdown 记忆和 SQLite 运行记录；可选 Pipecat 外部语音进程。

## M4 当前进展（2026-11-13）

Task 1 的 OneBot/NapCat 入站与回复通路已有提交，本次补充 conversation kind 隔离、重绑新线程和迟到回复再校验。Task 2 已接入模型 system prompt、session_search/session_read、memory_update 和 epoch 撤销，隔离 fake 模型检查实际上下文。Task 3 已加入 `shared/plugins/panels.ts`、`themes.ts`、`panel-frame.ts` 与扩展中心及 Bot library 插槽，支持声明式和沙箱只读面板、生成预览、保存、回滚及持久主题/布局选择。

原始清单保持最终验收要求，浏览器截图、完整桌面回归和真实账户证据仍待补齐。详细命令和结果见[验证记录](../../../verification/plugin-platform.md)。

## Task 1：账户绑定与独立平台 Bot

**Files**
- Create: `shared/plugins/accounts.ts`、`server/plugins/account-bindings.ts`、`server/plugins/inbound-routing.ts` 及测试。
- Modify: `server/store.ts`、`shared/wire.ts`、`src/components/Sidebar.tsx`、`src/components/SidebarSections.tsx`、Bot 设置组件与 locales。

- [ ] 用 fake QQ/B站创建账户 A/B，测试授权已有 Bot 与新建独立 Bot 的持久化。
- [ ] 配置确定路由与主处理 Bot，重放同一事件、回声、路由冲突和停用事件均不重复派工。
- [ ] principal/audience 从认证映射生成，不使用消息里的 owner 字段；不同平台会话不能共用 owner 的 provider session。
- [ ] 左侧显示独立头像/平台标识/状态，点击使用正常 Bot 会话和相应平台 tab。
- [ ] 分别验证隐藏、暂停、解绑、停用与删除：后台行为和数据影响不同，提示正确。

完成 BOT-01…04，不修改原有普通 Bot 默认行为。

## Task 2：共享记忆空间与撤销

**Files**
- Create: `shared/plugins/memory-spaces.ts`、`server/memory-spaces/` 的 membership、store、retrieval、revocation 模块与测试。
- Modify: `server/memory-store.ts`、`server/memory-forget.ts`、`server/workspace.ts`；实施前定位并审查自动召回、About me 注入与 session_search 全路径。
- Update: `docs/memory.md` 仅在行为实现后更新，不提前描述可用。

- [ ] 创建两个空间、read/read-write 成员和未加入 Bot，测试跨工作区/跨受众不能检索。
- [ ] 保留旧私有 Markdown，空间写入用 CAS/revision 和 provenance；群成员不能写主人偏好。
- [ ] 将旧 About me/自动召回/搜索/文件入口纳入同一受众过滤，受限共享目录不挂给任意文件工具。
- [ ] 用户撤销时提高 epoch，失效缓存/token、阻断待派发读取、重建或替换 provider session。
- [ ] 用假模型记录实际请求上下文，证明下一次模型调用不再含撤销内容，而非只检查 UI 标签。
- [ ] 删除条目清索引/派生引用；记录已外发数据不可回收的边界。驱动不能清理上下文时拒绝复用。

完成 MEM-01…04；记忆 ACL 测试必须包含当前全局 About me 旁路。

## Task 3：插槽、主题、布局与生成面板

**Files**
- Create: `shared/plugins/panels.ts`、`shared/plugins/themes.ts`、`src/lib/plugin-slots.ts`、`src/features/panels/` 及测试。
- Modify: `src/lib/skins.ts`、`src/components/SettingsModal.tsx`、`src/components/bot-panel/page-registry.ts`、`shared/app.ts`、`shared/app-frame/`、`src/components/app/app-frame-host.ts`。
- Modify: `scripts/check-skin-contrast.mjs` 以支持主题 manifest。

- [ ] 先注册现有内置页面，再加入具名插件贡献；保留 builtin typed subset，不简单把所有 union 改成无校验 string。
- [ ] token 校验、对比度、非法全局 CSS、隐藏审批和卸载当前主题回退均写测试。
- [ ] PanelSpec 输入拒绝未知组件、任意 SQL/eval、未授权数据源/动作和超预算组件。
- [ ] 模型提出面板 → 预览 → 保存 → 重启 → 版本回滚，实际绑定任务/用量假数据，不使用硬编码示例冒充实时。
- [ ] opaque-origin 高级 frame 复用 bridge，验证来源 nonce、RPC 范围、取消与 teardown。
- [ ] 添加安全模式、贡献级错误边界、窄屏/键盘/减少动态效果验收。

完成 UI-01…03；宿主文案进 en/zh 并走 i18n 检查。

## Task 4：OFM 与多模态能力

**Files**
- Create: `shared/plugins/models.ts`、一方 OFM 适配与 `server/testing/fake-ofm.ts`，对应合同测试。
- Modify: `server/contracts.ts`、供应商注册/配置 UI；复用既有 OpenAI-compatible 驱动，不重写推理循环。

- [ ] fake 服务覆盖 models、文本/视觉、tools、流式/非流式、取消、401/403/429、异常分片。
- [ ] 模型列表与 verified modalities 分开，未知 TTS/STT/video 明确 unavailable。
- [ ] 为用户服务器 New API/NVIDIA 接入填写端点/格式/采样率/usage 合同并测试；没有实际证据不启用。
- [ ] 密钥 write-only，路由 fallback 不扩大数据出口，免费/未知成本可辨。
- [ ] 在用户授权下单独进行真实模型请求，记录失败/限频；不能用 mock 证明真实渠道全部正常。

完成 MODEL-01…03。

## Task 5：实时语音、音频焦点与桌宠

**Files**
- Create: `shared/plugins/audio.ts`、`server/media/`、`src/lib/media/`、fake streaming audio 及测试。
- Modify: `server/tts/index.ts`、`server/routes/tts.ts`、`src/lib/tts/index.ts`、`src/lib/spoken-reply-stream.ts`、`server/routes/mascot.ts`、`src/components/Live2dOverlay.tsx`。
- Optional external plugin: Pipecat adapter，固定最小 provider 依赖。

- [ ] 旧七类 provider 注册且旧配置仍可播，流式能力通过明确标志启用。
- [ ] fake 音频分三次发送，验证第一段在全部结束前开始解码播放；记录实际首帧与队列大小。
- [ ] sequence/generation、背压、断流/重连、取消旧帧和长文本边界测试。
- [ ] AEC 不可用时维持半双工；麦克风/扬声器权限和 autoplay 等待有 UI 状态。
- [ ] 音频焦点 lease 对手动暂停/切歌/音量 revision 敏感，TTS 结束不覆盖用户操作。
- [ ] 桌宠跟随 TTS 包络与状态；音乐不让桌宠误说话；缺桌宠不影响音频。

完成 VOICE-01…03、MEDIA-01，作为 Muse 的前置合同。

## Task 6：Kanban、计划与用量

**Files**
- Create: `shared/plugins/tasks.ts`、`src/features/tasks/`、任务看板适配及测试。
- Modify: `server/runtime/`、`server/routines.ts`、`server/routine-schedules.ts`、`server/usage-ledger.ts`、`server/routes/usage.ts`、相关 UI。

- [ ] 建 task/run 对应关系和状态转换测试，running 只能由执行器设置；revision 冲突返回可恢复结果。
- [ ] 测试 claim/heartbeat/lease 过期、worker 崩溃和重复事件，不起第二个独立调度器。
- [ ] 计划用 fake clock 测时区/DST、重启漏跑、取消、审批等待、重试上限和预算阻断。
- [ ] 用固定请求账本证明 parent/child/plugin 统计不重复，未知成本不转零，历史行仍可读取。
- [ ] 音视频 units 与 actual/estimated/free/unknown 和币种分别保存，不擅自改变现有预算 entitlement。
- [ ] Kanban、用量页与自然语言面板消费相同服务，按账户/工作区过滤。

完成 TASK-01…03、USAGE-01/02。阶段收尾遵循总路线的检查与隔离端到端要求。


## M6 代码交付与验证进展（2026-11-14）

Task 6 已实现任务中心入口、八种状态、分配/依赖/优先级/来源/账户筛选、评论/产物/归档，任务通过既有 RoutineManager 执行与调度，并持久关联实际 run。运行状态由服务端推进，跨重启恢复沿用既有重试策略，计划取消会回到待办，版本冲突保留界面草稿。执行计划支持一次性时间和带 IANA 时区的 Cron。

统一用量复用现有 JSONL 账本，包含文本、插件调用、服务端 TTS/STT 与图片生成计量。视频时长沿用共享计量合同，真实视频产生方由 M5 提供。父子调用及任务/账户归因、重复调用记录去重、免费/未知/估算/实付、多币种、分页及 CSV 导出已有实现。自然语言声明式面板和沙箱面板读取同一任务/用量服务。

默认执行时长沿用 RoutineManager 的 10 分钟设置。已启用的计划在编辑任务前需要暂停，界面提供停止执行与计划按钮。M6 的低层 run 状态入口由服务端执行器持有。

本机 Electron 操作与隔离恢复、测试命令、截图、全局基线限制见[业务联动验收记录](../../../verification/plugin-integrations.md#m6-代码与本机验收2026-11-14)。M4/M5 及其他里程碑继续按各自验收记录判断。
