# 插件平台验收设计

状态：2026-11-07 设计，所有新插件用例尚未实施。本文是未来验收合同，不是测试通过报告，也不提供不存在的插件 CLI/API。具体源文件与新增脚本规划见[实施计划](../superpowers/plans/2026-11-07-eac-plugin-platform/01-platform.md)。

## Context

验收要证明从市场安装后真实可用、权限不能绕过、停用/升级不会破坏 Bot。测试必须遵循[验证入口](README.md)，不连接用户 live app 或真实数据。

## M1 已落地证据（2026-11-07）

当前已实现 Manifest 解析、安装记录、生命周期、权限求交和 owner/admin 管理 API。合同测试：

```sh
pnpm exec vitest run shared/plugins server/plugins server/routes/plugins.test.ts server/routes/plugins-market.test.ts
```

结果：15 个测试文件、84 个用例通过。本地包安装、supervisor 握手/超时/环境收缩/强制停止、重启后进程插件协调、签名目录的篡改/过期/回放/信任升级拒绝，以及渠道添加→目录刷新→制品安装的 HTTP 链路也包含在内。扩展中心 UI 只做了类型检查，尚未做真实浏览器视觉验收。

真实外部链路也已验证：全新隔离实例自动获得 `eac-community` 默认渠道，从 GitHub raw 拉取签名目录 sequence 2，安装 `eac.hello@0.1.0`，进程插件完成激活/停用。`Ebony-Vinyl/eacbot-extensions` 的 Actions 验证与签名发布工作流均成功。隔离实例也已实际启动并检查：

```sh
EAC_DATA_DIR="$(mktemp -d)" node --experimental-strip-types server/eacbot.ts serve --port 8899 --no-pair
curl http://127.0.0.1:8899/api/health
curl http://127.0.0.1:8899/api/plugins
```

观察到 `/api/plugins` 返回空安装列表，未知安装的激活返回 404 与 `not-found`。另以临时本地包和 `EAC_PLUGIN_PROCESS=1` 验证了 `POST /api/plugins/local` → `activate` → `disable`：安装返回 `installed-disabled`，激活返回 `active`，停用返回 `disabled`；激活响应只含公开摘要，不含 `packageDir`、完整 manifest 或 grants。该临时包使用 `isolation: none`，不能当作 OS 隔离或社区发行审核证据。

这不是真实渠道、平台 Bot、QQ/B站/Muse 或市场 UI 已通过的证据。本文 PLAT-01…10 的完整恶意隔离和 UI 场景尚未执行；`isolation: required` 仍会被拒绝。

## M4–M10 合同证据（2026-11-08）

以下能力已实现并有合同测试；它们不等于整条用户路径已验收。

| 范围 | 已实现 | 证据/限制 |
| --- | --- | --- |
| 平台账户 | 账户持久化、宿主身份映射、账户→Bot 绑定、会话级路由、重复/回声/暂停事件在派发前消费 | `server/plugins/platform-accounts.test.ts`、`server/routes/platforms.test.ts` |
| 独立平台 Bot | 可从账户创建 dedicated Bot 并写入 `platformBinding`；侧边栏显示平台标识；解绑不删除 Bot | 路由测试与 `src/components/PlatformBadge.tsx`；入站事件→turn 见下文第二批证据 |
| 共享记忆 | 空间、成员 `read`/`read-write`、CAS revision、epoch 撤销、owner/guest 受众过滤、删除墓碑、导出过滤 | `server/memory-spaces/store.test.ts`；**尚未接入模型自动召回与 About me** |
| 模型/OFM | OFM HTTPS/loopback 校验、`/models` 目录、模态 `verified/unverified/unavailable`、刷新不升级声明、OpenAI-compatible 请求体 | `shared/plugins/models.test.ts`、`server/plugins/ofm.test.ts`；**未对真实 OFM 服务发请求** |
| 音频 | 焦点 lease 优先级、手动暂停/音量 revision 不被 TTS 结束覆盖、流式分片序号/代际/格式校验 | `server/media/audio.test.ts`；**没有真实流式 TTS/播放器接入** |
| Kanban | 任务/运行状态、revision CAS、executor 租约、心跳、过期重领、重复完成幂等、done 需成功；`/api/boards` 已挂载 | `server/plugins/kanban.test.ts`、`server/routes/boards.test.ts`；**无 Kanban UI，未接入现有调度器** |
| 用量 | 按 bot/kind/plugin/model/day 聚合，actual/estimated/free/unknown 分账，rollup 不重复计数 | `shared/plugins/usage.test.ts`；**未写入现有 usage ledger** |
| 设备 | 一次性配对码、能力校验、撤销、命令 TTL、重复 commandId 幂等、迟到成功记为 unknown；`/api/devices` 已挂载 | `server/plugins/device-registry.test.ts`、`server/routes/devices.test.ts`；**无真实设备/健康/HA 插件** |
| 宿主适配 | Web/Electron/Tauri 能力声明，未声明即 unsupported，外链只允许 http(s) | `src/lib/host-adapter.test.ts`；**Tauri 工程未构建** |
| 插件工具调用 | `contributes.tools[].permission`、授权并消费 grant 后经 stdio `tools/call` 调用、非法结果记为 failed | `server/plugins/tool-call.test.ts`、`server/plugins/supervisor.test.ts`；自动挂载见下文第二批证据 |

## 挂载、入站 turn 与官方插件包证据（2026-11-08 第二批）

上表三项“尚未”已完成实现并有测试/fixture 证据：

- **插件工具自动挂载**：活跃插件的工具经 `eac-plugins` MCP 服务器（harness 代理，`server/harness-mcp-request.ts` 新增 `plugins` kind）进入 Bot 回合的 `custom` 服务器，随工具选择与用户服务器同一权限流。`read`/`draft` 效果由宿主在内存中发回合 grant（不落盘），更强效果需要主人发的 grant（principal/audience 为 `bot:<botId>`，Bot 级授权）。证据：`server/host/plugins-mcp.test.ts`（6 用例）、`server/harness-mcp-proxy.test.ts`（新增 plugins 中继用例）。
- **平台入站事件 → Bot turn**：`POST /api/platforms/inbound` 现在把 `delivered` 事件投给绑定 Bot：每会话一个持久线程（`platforms/threads.json`），`startTurn` 以 `unattended`+`automationSource:"webhook"`（不可信数据边界）运行，回复在回合 settle 后进入 per-account outbox（`platforms/outbox.json`），桥经 `GET /api/platforms/accounts/:id/outbox?since=` 拉取、`POST .../outbox/ack` 确认。忙/限流时事件不被消费（409，可重投）。证据：`server/host/platform-inbound.test.ts`（7 用例）、`server/plugins/platform-outbox.test.ts`。
- **官方插件包**：`plugins/eac/` 下 8 个 process 插件（health、home-assistant、bilibili、muse、tieba、xianyu、douyin、xiaohongshu），能力矩阵见其 README。证据：`server/plugins/bundled.test.ts` 逐包校验 manifest 并真实启动进程完成一次 `tools/call`（HA/酷狗/B站/贴吧指向本地 fake HTTP 服务，不发真实外网请求）。

隔离 fixture 端到端（`node --experimental-strip-types scripts/control-omb.ts launch`，`EAC_PLUGIN_PROCESS=1` 经启动器白名单传入子进程）：

- `POST /api/plugins/local` 安装 `eac.health` → `installed-disabled`；`activate` → `active`（stdio 进程握手成功）。
- `GET /api/plugins/:id/tools` 返回 5 个工具；`POST /api/plugins/:id/grants` 为 fixture Bot 发 `health-record-add`（write）grant，`GET .../grants` 可见。
- 创建 QQ 账户 → 绑定现有 Bot → `POST /api/platforms/inbound` 返回 **202 + threadId**（线程映射落盘）→ fake 引擎回合结束 → outbox 出现回复（`hello from fake claude`）→ `ack` 后 outbox 清空；同 eventId 重投返回 `ignored/duplicate`。

仍未执行/未通过（同上文既有条目）：真实 OS 沙箱、真实 QQ/B站账户桥、UI 浏觉器视觉验收；`pnpm i18n:check` 仍被仓库既有 stale translations 阻断（非本次新增 key 引起）。

Tauri 宿主（2026-11-08）：`hosts/tauri/` 已建成工程——`contract/` 纯逻辑 crate 4 个测试离线通过（合同脚本、外链门、invoke 白名单、重启退避）；`src-tauri/` `cargo check` 与 `cargo build`（debug）通过。未做：打包签名、更新通道、macOS/Linux 运行证据、桌宠窗口；Electron 仍是默认宿主。

## 全量 Vitest 基线（2026-11-08）

全量 `vitest run` 在本机未能在会话内完成收尾（对测试不可见的退出挂起，遗留一个 fixture server 句柄；两次 reporter 均复现），因此按文件隔离取证。失败 10 项，**逐项与 HEAD（813bba6，无任何未提交改动）隔离复跑对照**：

| 失败用例 | HEAD 上 | 结论 |
| --- | --- | --- |
| `server/index.test.ts` setup answers ×2（引擎个性化未到达 setup 卡，返回静态兜底） | 同样失败 | HEAD 既有缺陷，未修 |
| `server/index.test.ts` persona bytes（期望 78，实际 73，改品牌文案后字节数未更新） | 失败 | **已修复**（期望改 73） |
| `server/drivers/codex.test.ts` shell filters ×2（多出 `omb_gate_config_*`，品牌改环境变量未改全） | 同样失败 | HEAD 既有缺陷，未修 |
| `server/config.test.ts` credential env strip | 同样失败 | HEAD 既有缺陷，未修 |
| `server/drivers/chat-mcp-tools.test.ts` symlink 截断 | 同样失败 | HEAD 既有（Windows 符号链接环境），未修 |
| `server/cloud-lending-memory.e2e.test.ts` ×2 | 同样失败 | HEAD 既有缺陷，未修 |
| `server/routines.test.ts` paused schedule 重开 | 隔离复跑通过 | 并行负载下的偶发，非确定性失败 |

即：本次改动没有新增任何失败，并修复了其中一项；其余 9 项（含 8 项确定性失败）为 HEAD 已有问题，待单独立项处理。`pnpm i18n:check` 同理被 HEAD 既有 stale translations 阻断（15 个 locale 数百条，与本次新增 key 无关）；`pnpm build`、`pnpm lint`、`pnpm check:contrast` 全部通过。

插件相关专项测试（2026-11-08）：

```sh
pnpm exec vitest run shared/plugins server/plugins server/memory-spaces server/media \
  server/routes/plugins.test.ts server/routes/plugins-market.test.ts server/routes/platforms.test.ts \
  server/routes/devices.test.ts server/routes/boards.test.ts src/lib/host-adapter.test.ts
```

结果：28 个测试文件、156 个用例通过。外部扩展仓库新增 `eac.qq` OneBot 适配器源码，其 `plugins/eac/qq/test` 下的 3 个 fake 用例通过（在该仓库内运行 `node --test`，不在本仓库）；它没有连接真实 QQ，也不包含宿主事件投递。

隔离实例端到端（2026-11-08，`EAC_DATA_DIR="$(mktemp -d)" node --experimental-strip-types server/eacbot.ts serve --port PORT --no-pair`）：

- 创建 QQ 账户 → 创建 dedicated Bot（边栏显示 `qq` 标识）→ 写入主人身份 → 入站事件 `delivered` 到该 Bot，重复事件 `ignored/duplicate`。
- 共享空间 `taste`：创建、写入、owner 读取、guest 读取、撤销 epoch、旧 revision 写入返回 409。
- 设备：配对码 → redeem → 命令入队 → 重复 commandId 返回同一命令 → 回执 `succeeded`；未声明能力返回 403。
- Kanban：建板 → 建任务 → claim → 他人 executor 启动被拒 403 → 本人启动成功。

这些是隔离 fixture 的实际观察，不是生产账号或 UI 视觉验收。

尚未执行/未通过：

- `pnpm i18n:check` 仍被仓库既有 stale translations 阻断；新增 `extensions.*` 与 `platforms.*` 只补了 en/zh。
- `src/locales/vocabulary.test.ts` 的失败项是既有文案，不涉及本次新增文件；没有据此宣称全量检查通过。
- 未跑完整 `pnpm test`；PLAT-05 的真实 OS 隔离、PLAT-07 的 Bot 自动工具调用、UI-01…03 的浏览器视觉验收仍缺证据。

## 代码审核后的修复（2026-11-08）

独立审核发现的缺陷已修复并有测试覆盖：

- 平台账户 `status` 改为经 schema 校验后写入，非法值不再把整个账户文件变成不可读。
- 四个新存储（平台、设备、记忆、看板）在写入前检查 schema 上限，超限返回冲突错误，而不是写出一个下次启动会被判为损坏的文件；设备配对会清理过期/已用条目，命令历史有界。
- 工具未显式声明 `permission` 时，只在该 effect 恰好对应一个权限时才可调用；否则工具不出现。
- 记忆成员降级为只读时同时提升 epoch；设备命令 id 不能跨设备复用；音频焦点租约过期会恢复被暂停的音乐。
- 插件 stdin 增加 `error` 监听，管道已关闭时拒绝待处理调用而不是让 `EPIPE` 逃逸。
- 宿主 `invoke` 只放行 `commands[feature]` 中声明的命令。
- Kanban 完成操作先校验执行者；失败/取消的运行可以重跑，成功的不可重跑。
- 模型目录刷新会移除提供方已下架的模型。

## 环境与证据

现有隔离启动方式：

```sh
node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb doctor --url http://127.0.0.1:PORT
```

将 PORT 替换为启动器实际打印值，保留 URL、PID、临时数据目录和日志路径。每个假渠道、插件、账户和设备使用独立临时资源；不通过静默端口发现访问用户实例。

实现相关阶段后，运行实际已有的单元/集成测试及：

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm check:contrast
pnpm test
pnpm build
```

新插件命令和测试脚本必须先实现、加入帮助/测试并验证，再更新本文；目前不列假命令。为每项记录动作前后状态、关联 ID、日志、断言与截图/录屏。pass 必须有证据；无账号、无设备、缺依赖或尚未实现都不能算 pass。

## 平台基础用例

| ID | 前置与动作 | 期望结果/观察点 |
| --- | --- | --- |
| PLAT-01 | 合法/非法 manifest，重复 key、未知版本、路径逃逸、权限遗漏、依赖环 | 合法解析；非法在执行任何入口前拒绝，说明具体原因 |
| PLAT-02 | 依次安装、激活、停止、重启、卸载；第二步激活注入异常 | 首次 installed-disabled；持久状态正确；部分注册逆序撤销，无残留任务/进程 |
| PLAT-03 | owner/guest、Bot A/B、账户 A/B、允许/过期/撤销 grant 组合调用；审批后更换参数 | 仅交集授权通过；参数变更重批；queue 派发重新检查；allow-once 不重复消费 |
| PLAT-04 | 插件 A 崩溃/超时/重启风暴，插件 B 与聊天持续工作 | 故障局限 A，退避熔断；不影响 B/Bot；依赖边界和现有棘轮通过 |
| PLAT-05 | 恶意测试进程尝试读宿主秘密、跨目录、直接联网；隔离后端不可用 | OS 实测阻止越界；required 模式拒绝启动，可信模式不假标安全 |
| PLAT-06 | 网络/存储/模型 broker、跨域 redirect、SSRF、秘密输出；模拟外发回执丢失 | 秘密不泄漏、出口正确；不明结果 indeterminate，非盲重试；审计无正文 |
| PLAT-07 | 空 fixture 从临时签名源安装工具，授权给一个 Bot 后调用 | 安装/启用/授权分开；只有指定 Bot 看到工具；产生可观察真实结果 |
| PLAT-08 | 安装主题/面板，重启、禁用、卸载当前布局；frame 伪造 RPC | 贡献可恢复和移除，内置回退可用；越权/错误来源拒绝；宿主审批不被遮挡 |
| PLAT-09 | 重复安装、安装取消、并发更新、在事务阶段崩溃后启动 | 没有半 active 版本或双消费者；只清理所属暂存；数据保留策略正确 |
| PLAT-10 | 创建 Bot、聊天、工具审批、现有 MCP/连接器、旧 TTS/桌宠和记忆回归 | 旧配置继续可用；不要求重新登录或迁移丢数据；失败记录不能吞掉 |

## 平台 Bot 与记忆用例

| ID | 前置与动作 | 期望结果/观察点 |
| --- | --- | --- |
| BOT-01 | 连接 fake QQ/B站账户，各选择授权原 Bot 或新建独立 Bot，重启 | 两模式都工作；左侧独立条目、平台标识、任务/看板绑定正确 |
| BOT-02 | 两账户/两 Bot、同一事件重复投递、规则重叠、自身消息回声 | 不串账户；每事件一个主处理 Bot；冲突可解释，回声不循环 |
| BOT-03 | guest 群成员要求点歌并读主人记忆、改价或改权限 | 仅已授权范围动作可执行；不能继承主人权限或修改路由/共享 ACL |
| BOT-04 | 隐藏、暂停、解绑、停用插件、删除 Bot 分别执行 | 隐藏不等于暂停且有提示；解绑撤销队列/路由；删除不误删其他共享成员数据 |
| MEM-01 | A/B 同空间，C 未加入；A 写允许共享的偏好，B 检索，C 尝试 | A/B 按权限共享，C 拒绝；私有和健康数据不混入；凭据从不进入记忆 |
| MEM-02 | read 成员写入、群成员修改主人 About me、受限 audience 检索 | 宿主拒绝；自动召回/旧 About me/文件与搜索不能绕过 ACL |
| MEM-03 | 开启会话后撤销空间，立即发新 turn，并检查 fake 模型实际上下文 | 旧 token/cache 失效，旧 provider session 重建或拒绝；后续请求不含撤销内容，未外发响应受控 |
| MEM-04 | 并发改同条目、删除条目、索引/摘要缓存命中、导出空间 | CAS 冲突不覆盖；派生可追踪数据清理；导出按 ACL；已向第三方披露不可回收有说明 |

## UI 用例

| ID | 动作 | 期望 |
| --- | --- | --- |
| UI-01 | 市场搜索/分类/详情/安装/管理源，在明暗与窄屏、键盘下操作 | 布局无溢出，状态明确、对比度/焦点正确；安装与连接不混淆 |
| UI-02 | 切主题/布局，加载故障插件，启安全模式，启减少动态效果 | 审批/恢复入口始终可见；故障贡献被隔离；回退正确，无强制动画 |
| UI-03 | 自然语言生成任务+用量面板，预览保存/编辑/回滚/导入；撤销某数据源 | 实际数据绑定，未授权动作拒绝；缺依赖有恢复说明；导入不导入权限 |

视觉测试采用 1280×800、1440×900 与 390×844 的代表尺寸，另覆盖缩放和中文长文案。动作录屏用于安装过渡、拖拽、焦点和播放器联动；静态截图不足以证明动效流畅。性能报告注明硬件、数据量与冷/热启动，不把设计目标当实测。

## 通过条件与清理

任何跨工作区/账户/受众泄漏、越权外发、重复发送、秘密泄漏或恢复数据损坏均阻断。单测通过不证明用户路径；必须同时有安装与结果状态证据。

结束按启动器方式 Ctrl-C，清理自己创建的假服务/下载目录，保留脱敏日志。不按进程名杀服务，不删除全局 temp，不接触用户 live 数据。

业务用例见[集成验收](plugin-integrations.md)，分发与部署见[发布验收](plugin-release.md)。
