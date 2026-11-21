# OpenBot 前端独立还原交接

日期：2026-11-21

状态：左侧功能轨、会话栏、聊天画布、设置页与移动端关键交互已完成首轮实现和隔离浏览器验收；完整 OpenBOT 页面清单与原生 Electron 回归仍需继续。本页顶部为当前交接状态，后面的章节保留早期调查记录。

开始修改前先读根目录 `AGENTS.md`、`docs/verification/README.md`，然后按以下顺序读：

1. [详细实施计划与下一模型起步顺序](openbot-ui-implementation-plan-2026-11-21.md)。
2. [逐页、逐状态和业务 / 动效验收标准](../verification/openbot-ui-acceptance.md)。
3. [独立实现与来源边界](openbot-independent-ui.md)。

用户要求是**完美复刻 OpenBOT 前端本身**，不是“类似风格”的重新设计。协作方式是**主控模型 + 最多五个同时活跃的子智能体**，主控不占五个名额。用户最后要求先写好文档、切换模型再开发；本次文档收尾不继续改源码或启动应用。

## 最新交接摘要（2026-11-21）

### 在哪里继续

- 交付分支：`feat/openbot-ui-replica`，从 `main@0170bc6` 出发，提交后推送到 `origin`。接手者先运行 `git fetch origin`，再检出这个远程分支。
- 用户原工作区：`D:/EACbot`；音乐、后端和前端改造此前都在同一未提交工作树中，本轮按用户要求把它们作为当前完整源码一起交付。不要把这里误认为只有壳层改动的旧快照。
- 本会话快照：`D:/EACbot/.zcode/openbot-ui-20261121/`，有原改动补丁、状态和8955个路径基线哈希。
- 任务资料：`D:/EACbot/.superpowers/sdd/openbot-ui-handoff-2026-11-21/`。
- 开发依赖使用仓库锁文件安装；不要复用旧工作树里的 `node_modules` Junction。

### 启动与继续

```powershell
git fetch origin
git switch --track origin/feat/openbot-ui-replica
pnpm install --frozen-lockfile
pnpm dev:server
pnpm dev
```

前端隔离验收使用独立 fixture，不连接用户正在运行的应用或真实数据：

```powershell
pnpm build
$env:EAC_CDP_CHROME = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node --experimental-strip-types scripts/verify-workspace-ui.ts .omb-scratch/verify-evidence/workspace-ui --static-dir dist --visuals --regressions
```

### 已完成与未完成

| 项目 | 准确状态 |
| --- | --- |
| 桌面壳层 | 52px 左侧功能轨、280px 可拖动会话栏、聊天画布和 38px 聊天顶栏；默认明暗色值按已保存的 OpenBOT 参考校准。 |
| 左侧入口 | Inbox、Herdr、任务看板、文件、用量、设置与「更多」使用现有业务 Action；Task board 和 Usage 保留 owner/admin 门禁，Servers 保留桌面 bridge 门禁。 |
| 会话栏 | 搜索和新建位于顶部；Projects/Chat 切换、会话宽度持久化、折叠密度、行菜单、置顶和拖放保留；连接器入口固定在底部。 |
| 聊天 | 助手身份居中、模型选择靠右并下移到聊天画布顶栏；发送、刷新、输入区、右侧面板与既有业务状态保留。 |
| 设置 | 工作区内设置页、280px 设置导航、搜索、分组和关闭返回原页；手机保留选择器与关闭行为。 |
| 移动端 | 紧凑会话头像条、抽屉焦点与 inert、看板键盘切换、Escape 关闭和 Inbox 跨层打开。 |
| 动效 | 使用现有 WAAPI spring；支持 reduced-motion，面板退场隔离。 |
| 隔离浏览器验收 | 最新左侧栏构建 `28060f6…` 与连接器修正构建 `541ea53…` 已在 Edge 1440×900、390×844 和 767/768/1024/1600px 场景检查；发送、刷新、设置返回、侧栏拖动、移动看板与 Inbox 通过。证据见 `.superpowers/sdd/openbot-ui-handoff-2026-11-21/evidence/`。 |
| 工程检查 | 本轮 `tsc -b`、目标 oxlint、Vite 生产构建通过；相关导航/会话/抽屉专项 30 项通过。仓库仍有既有设置 SSR 快照和文件大小门禁失败，不能写成全仓绿灯。 |
| 完整 OpenBOT 覆盖 | 未完成：工作流画布、CRM、市场目录、逐页视觉像素差、原生 Electron 标题栏/快捷键/真实设备与所有后端集成仍需逐项验收。 |
| 提交 / 推送 | 本轮按用户要求提交并推送；准确提交哈希以远程分支为准。 |

### 接手者优先顺序

1. 先跑 `pnpm typecheck`、目标测试和隔离 fixture，确认当前分支在你机器上的结果。
2. 对照 `docs/verification/openbot-ui-acceptance.md` 继续 V01–V24；不要把当前壳层通过当成完整复刻。
3. 优先复核原生 Electron 窗口、所有功能页、流式/工具/审批/失败恢复与权限矩阵。
4. 工作流画布、CRM 和市场目录缺少对应业务能力；先补业务，再声称视觉复刻。
5. 不要用 OpenBOT 源码、CSS、类名体系或专有素材替换本分支的独立实现；来源边界见 `docs/design/openbot-independent-ui.md`。

下面的章节保留最初的实施计划和调查过程；涉及“未同步”“未运行”“顶部工具栏”等阶段性措辞时，以本节和 `docs/verification/workspace-ui.md` 的最新结果为准。


## 源码交付范围

本轮交付包含当前工作树的完整前端、音乐功能、Electron 接线、服务端与共享协议、测试和依赖锁文件。`NOTICE` 保留仓库既有的第三方归属声明；按用户要求，单独的来源说明、设计/验收文档和截图不进入提交。

### 接手检查

```powershell
git fetch origin
git switch --track origin/feat/openbot-ui-replica
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
```

随后用 `scripts/verify-workspace-ui.ts` 启动隔离 fixture。需要进一步理解实现时，直接阅读 `src/App.tsx`、`src/components/shell/`、`src/components/Sidebar.tsx`、`src/components/SettingsModal.tsx` 及各自测试。

已知缺口：完整 OpenBOT 页面逐项视觉验收、原生 Electron 回归、真实设备与全部外部集成尚未完成；仓库原有设置 SSR 快照和文件大小门禁失败仍需单独处理。

## 源码入口

- 工作区壳层：`src/App.tsx`、`src/components/shell/NeutralWorkspace.tsx`、`workspace-shell.css`、`workspace-conversations.css`。
- 会话与移动端：`src/components/Sidebar.tsx`、`ConversationSidebar.tsx`、`MobileConversationStrip.tsx`、`ShellViewSwitch.tsx`。
- 设置：`src/components/SettingsModal.tsx`、`settings-workspace.css`。
- 音乐：`src/components/music/`、`src/lib/music/`、`server/music/`、`shared/music.ts`。
- 验证：`scripts/verify-workspace-ui.ts` 及各组件同目录测试。
