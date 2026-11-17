# EACbot 交接文档

最后更新：2026-11-15
分支：`feature/hermes-command-center`

这份文档写给接手的人。它说明现在代码是什么状态、哪些做完、哪些没做、下一步从哪下手，以及**不要**做什么。

---

## 一、一句话现状

EACbot 现在是**旧前端（二改 Mausbot 那版，含看板）+ 新后端 `core/`（Hermes 指挥中心）**。旧前端是唯一的 App，五个新功能页作为视图挂在它的壳里。旧前端的原有数据层仍指向旧服务端，**新旧后端尚未合并**——这是下一阶段的主要工作。

---

## 二、前端：已按要求复刻回原样

### 入口

| 文件 | 状态 |
|---|---|
| `index.html` → `src/main.tsx` → `src/App.tsx` | 旧前端唯一入口，已恢复 |
| `rail.html` → `src/rail.tsx` | 桌面端窗口栏，保留 |
| `src/styles.css`（3173 行，11 套皮肤） | 未改动 |
| `vite.config.ts` | 只有 `index` 和 `rail` 两个入口 |

**`workbench.html` 及其整套平行壳已删除。** 如果看到有人想再建第二个入口，先读本文第三节。

### 五个新页面

导航在侧栏"收件箱"下面，样式与收件箱一致，简单模式和高级模式都可见：

| 页面 | 组件 | 说明 |
|---|---|---|
| Hermes 助理 | `src/next/personal/PersonalAgentPage.tsx` | 个人助理对话、任务树、任务详情 |
| 任务 | `src/next/personal/MissionCenter.tsx` | 任务列表与筛选 |
| 云电脑 | `src/next/settings/CloudComputerSettings.tsx` | 用户自配 SSH 电脑，增删改测 |
| Agent | `src/next/settings/AgentSettings.tsx` | 用户自装 Agent 与模型 |
| 终端 | `src/next/workbench/Workbench.tsx` | Herdr 式多窗格真实终端 |

### 接线方式（照抄，别发明新的）

新页面**不是**另一个 App，是旧壳的视图。四个挂点：

1. `src/state/store.tsx`
   - `NEW_PAGES` 常量 + `NewPage` 类型（第 ~566 行）
   - `activeView` 联合类型包含 `NewPage`
   - `{ type: "showNewPage"; page: NewPage }` action
   - reducer 的 `case "showNewPage"` 分支
   - `selectionRevision` 的导航 action 列表里也加了 `showNewPage`

2. `src/App.tsx`
   - `isNewPage()` 守卫（文件末尾）
   - `Shell` 里的三元分支：`isNewPage(state.activeView) ? <CommandPageView page={...} /> : ...`

3. `src/components/SidebarCommandPages.tsx`（新文件）
   - 五条导航行，挂在 `src/components/Sidebar.tsx` 的 `SidebarInboxRow` 之后

4. `src/next/pages/CommandPageView.tsx`（新文件）
   - 把 `activeView` 映射到具体页面组件
   - 外面套 `PageFrame`（`bg-app`，让背景透光）
   - 未配对时显示 `PairingGate`

**为什么导航不放 `SidebarFooterNav`：** 那个组件在简单模式下 `return null`，rail 模式下只返回 Apps。放那儿的话简单模式用户根本进不去新页面。`SidebarInboxRow` 是唯一在所有密度和模式都可见的位置。

### 视觉规则（违反会破坏产品身份）

- 只用 `src/styles.css` 的语义 token：`bg-app` / `bg-panel` / `bg-raised` / `bg-card` / `bg-inset` / `bg-menu` / `text-ink*` / `border-hairline` / `border-edge` / `bg-accent` 等
- **绝不写死色值**，会破坏换肤
- 气泡用配对 token：`--color-bubble-user` + `--color-bubble-user-ink`
- 面板用 `bg-app` / `bg-panel` / `bg-frame`，**不要在组件 CSS 里重新声明这三个颜色**——`:root[data-background-live]` 靠它们做透光
- 动效用 `src/lib/use-spring` 的 `springTo` 或 CSS 过渡，不引入动画库，不写 rAF 积分器
- 必须支持 `prefers-reduced-motion` / `prefers-reduced-transparency`

### 不使用的库

`@astryxdesign/*` 和 `@stylexjs/stylex` 已从 `package.json` 和全部源码移除。不要再引入。

---

## 三、不要重犯的错误

上一轮做过一次，已回滚，记录在这里避免重演：

**错误做法**：新建 `workbench.html` + `src/next/components/{Workbench,WorkbenchTopNav,WorkbenchSideNav,WorkbenchPanel,WorkbenchSettings,...}.tsx`，一整套自己的壳，然后让 `core` 把 `workbench.html` 当根页面。结果旧前端一行没删但根本没被访问到，用户看到的是"在新前端上改了一下"。

**正确做法**：旧前端就是 App。新功能是它的视图（`activeView` + `Sidebar` 行 + `App.tsx` 分支）。`core` 的 `entryFile` 必须是 `index.html`。

`src/next/components/` 已不存在。如果它重新出现，说明有人又走错路了。

---

## 四、后端：`core/`（新）

### 结构

```
core/
  bootstrap/     # 唯一装配入口：main.ts 启动，server.ts 组 HTTP 层
  http/          # 无框架 Node HTTP、路由、SSE、WSS、静态资源
  identity/      # 本地用户、设备配对、会话撤销、scope
  missions/      # SQLite WAL 任务树、状态机、事件
  agents/        # Agent 注册、能力探测、模型目录、适配器
  environments/  # 通用 SSH 云电脑
  terminal/      # Herdr Core (hc) 帧协议桥、PTY、attach
  orchestration/ # Hermes 指挥用的 12 个 scoped MCP 工具
  events/        # 事件总线
```

### 启动

```bash
EAC_CORE_FAKE_AGENTS=1 \
EAC_CORE_DATA_DIR=D:/EACbot/.zcode/ui-core-data \
EAC_CORE_PORT=8789 \
node --experimental-strip-types core/bootstrap/main.ts
```

启动后终端会打印一次性配对码，10 分钟过期。

### 配对

```bash
curl -X POST http://127.0.0.1:8789/api/v1/pairing/claim \
  -H "content-type: application/json" \
  -d '{"code":"XXXX-XXXX","label":"my-device"}'
```

返回 `{ token, session }`。前端把 token 存进 `localStorage["eacbot.workbench.session.v1"]`。

### 路由（`/api/v1`）

`/health`、`/pairing/claim`、`/agents`、`/agents/:kind`、`/agents/:kind/models`、
`/missions`、`/missions/:id`、`/missions/:id/history`、`/missions/:id/tree`、
`/missions/:id/{steer,interrupt,resume,cancel}`、`/environments`、`/environments/:id`、
`/terminals`、`/sessions`、`/events`（SSE）、`/terminals/:id/stream`（WSS）

### 测试

```bash
npx vitest run --config core/vitest.config.ts
# 201 passed | 2 skipped
```

### 静态服务

`core/bootstrap/server.ts` 用 `entryFile: "index.html"`。构建产物 `dist/index.html` 存在时才启用静态服务。

---

## 五、验证结果（2026-11-15）

| 项 | 结果 |
|---|---|
| `npx tsc -b` | 通过 |
| `npx oxlint --deny-warnings .` | 6143 文件，0 警告 0 错误 |
| `core` 测试 | 201 通过 / 2 跳过 |
| 前端相关测试 | 830 通过 / 45 文件 |
| `npx vite build` | 通过，3m31s，只产出 `index.html` + `rail.html` |
| 真浏览器 | 旧前端完整、模糊壁纸、五入口、云电脑页读到 Instabox 真机、终端弹窗给出真机 |

### 已知的既有失败（与本次改动无关）

`src/components/Sidebar.simple-layout.test.ts` 有 2 个失败：

- `draws the same faint edge in both modes, ...` — 断言 `border-r-[0.5px] border-edge`，实际类名里没有
- `opens the command palette instead when a side panel holds the sidebar collapsed`

已验证：`git checkout src/components/Sidebar.tsx` 后照样失败，且该测试文件自首次提交 `0381ca1` 起未被修改。属于仓库既有状态，不是本次引入。

---

## 六、本次修的两个 bug

### 1. 终端页提交硬编码 `env-visual`

**现象**：终端页"打开终端"下拉显示真实电脑，但提交的是占位符 `env-visual`，服务端必然拒绝。

**根因**：`src/next/workbench/Workbench.tsx` 的电脑列表从 mission 的 `environment` 反推，而 fixture mission 填的是 `env-visual`。

**修复**：新增 `readComputers()` 读 `GET /api/v1/environments`，`load()` 里一起取；`environments` 优先用真实列表，列表未到时才回退到 mission 反推。回归测试在 `src/next/workbench/Workbench.test.ts`。

**验证**：浏览器里下拉框给出 `c39d6113-…`（Instabox 真机），页面不再出现 `env-visual`。

### 2. "Move from Grok Bot" 迁移弹窗

**现象**：首启动弹窗挡住界面，是旧产品入口。

**修复**：`src/components/AppNotices.tsx` 里 `grokDue` 钉成 `false`。**不能整段删**——通知队列读这个值给其他卡片排序。对应的 7 个测试已删。

---

## 七、下一步（按优先级）

### 1. 旧页面数据层接 `/api/v1`（最高优先级）

**现状**：旧前端用 `/api/bots`、`/api/auth/session`、`/api/team` 等（旧服务端 8799），新页面用 `/api/v1` + bearer（`core` 8789）。两套并存，靠 Vite proxy 指向其中一个。

**后果**：proxy 指向 `core` 时旧聊天页显示"正在连接你的机器人"；指向旧服务端时新页面读不到数据。

**要做**：按页面优先级把旧前端的 `src/state/store.tsx` 数据层接到 `/api/v1`。建议顺序：

1. **聊天页**（`ChatView` + `store.tsx` 的 hydration）——旧壳主界面，也是 Hermes 对话的落点
2. 侧栏 bot 列表 / 任务列表
3. 设置页

**注意**：`store.tsx` 是 3000+ 行的 reducer，改动前先读 `src/state/saved-state.ts` 和 `src/state/api.ts` 理解 hydration 链路。

### 2. 接通 Hermes 指挥闭环

`core/orchestration/` 已有 12 个 scoped MCP 工具（任务创建、分配、等待、审批、取消等），但**尚未连到运行中的 Hermes**。要做：

- Personal Thread 绑定一个 Hermes gateway session
- 把 MCP 工具注册给 Hermes
- 子任务完成后写 durable inbox 唤醒 Hermes 一次
- 需要模型凭证才能做真实验证

### 3. Android 客户端

`apps/android/` 有骨架，`docs/android.md` 有说明。需要：

- `EnvironmentRef` 字段同步到新后端 `EnvironmentSummary`
- 模拟器 + 真机验证

### 4. 删除旧后端

`server/` 目录（约 14000 行）在新路径验收后整体删除。**不要提前删**——旧前端的现有页面还依赖它。

### 5. 清除 Boat 与商业云入口

`NOTICE`、`apps/docs/`、部分 `server/` 文件里仍有残留。注意 `src/components/GrokMoveDialog.tsx` 和 `GrokBotMark.tsx` 现在是死代码（弹窗已禁用），可以连同测试一起删。

---

## 八、约束（务必遵守）

### 安全

- **永远不要在用户的真实 EACbot 数据上验证改动**。用隔离 fixture：`EAC_CORE_DATA_DIR` 指向临时目录。
- 不要删除 EACbot 以外的服务。EACbot 自己的服务可以改。
- 秘密只放临时测试配置或服务端密钥存储，不进仓库、日志、截图、浏览器、手机。

### 许可

- 内置壁纸是 **CC BY-NC 4.0**，仅限非商业使用。项目本身 Apache-2.0。
- `herdr-core (hc)` 是 Apache-2.0，保留 `third_party/herdr-core/` 的 NOTICE 和版本归属。
- `docs/design/grokbot-ui-notes.md` 记录的是交互结构研究，来源仓库**无 LICENSE**，只能借鉴交互，不能复制代码/素材/文案。

### 产品

- **不销售云电脑**。没有套餐、升级、Hosted Cloud、供应商推荐、广告、埋点。只有"连接我的云电脑"。
- Agent 是用户自己安装的软件，EACbot 只负责启动、观察、记录，不代理登录、不销售。
- 不保留旧产品命令作为正式入口。

### 代码

- 注释只写代码说不出的东西：许可声明、外部强制的行为、公共契约的文档、上游 issue 链接、安全不变量。不写"下一行做什么"、不记录历史、不画横幅、不留注释掉的代码。
- 不抑制守护正确性的 lint 规则，改代码。
- 改动必须能在重新部署后存活：默认值放仓库，不放运行时数据目录。

---

## 九、快速上手

```bash
# 1. 依赖
pnpm install

# 2. 旧前端（5199，proxy 到 8799）
pnpm dev

# 3. 旧服务端（8799）
pnpm dev:server

# 4. 新后端 core（8789）
EAC_CORE_FAKE_AGENTS=1 \
EAC_CORE_DATA_DIR=/tmp/eac-core \
EAC_CORE_PORT=8789 \
node --experimental-strip-types core/bootstrap/main.ts

# 5. 让 Vite 代理指向 core（测新页面时）
EAC_PORT=8789 pnpm dev

# 6. 检查
npx tsc -b
npx oxlint --deny-warnings .
npx vitest run --config core/vitest.config.ts
npx vitest run src/next
npx vite build
```

---

## 十、关键文件索引

| 想知道… | 看 |
|---|---|
| 旧壳怎么路由视图 | `src/state/store.tsx` 搜 `activeView` |
| 新页面怎么挂进旧壳 | `src/App.tsx` 搜 `isNewPage`、`src/next/pages/CommandPageView.tsx` |
| 侧栏导航怎么加 | `src/components/SidebarCommandPages.tsx` |
| 皮肤和背景规则 | `src/styles.css` |
| 背景层 | `src/components/background/AppBackground.tsx` |
| 新后端启动 | `core/bootstrap/main.ts` |
| 新后端路由 | `core/http/routes.ts` |
| 协议类型 | `packages/agent-protocol/` |
| 终端帧协议 | `core/terminal/stream.ts`、`src/next/workbench/terminal-transport.ts` |
| Hermes 指挥工具 | `core/orchestration/` |
