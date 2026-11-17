# Neutral UI 前端验收

本次改动影响范围是 Web/Electron 前端呈现模块。

## 变更与备份

使用 `@neutral-reference/ui@0.1.0` 的 Theme、Button、Input、Card、Badge、Drawer 与 EmptyState。包归档保存在 `vendor/neutral-reference-ui-0.1.0.tgz`，与本机组件库原始交付包逐字节一致。许可证与第三方声明保留在包内。

应用保留唯一主入口和现有数据层。新增分组导航、工作区顶栏、明暗主题入口及窄屏抽屉；聊天保留会话栏，任务和资源页面使用完整工作区。共享控件及语义颜色统一到 Neutral 主题。设置、扩展和既有聊天能力继续使用原实现。

修改前备份：`../EACbot-backups/20261116-103100-before-neutral-ui`。前端归档包含 3,456 个文件，已逐文件比对 SHA-256；另存当前工作区补丁和未跟踪源码。恢复说明见 `backup.json` 与设计文档。未覆盖原有 Android 和导航未提交改动。

## 实际执行

2026-11-16，验证预算最多三轮，已使用三轮。

| 检查 | 结果 |
| --- | --- |
| 第一轮定向测试（导航、资源页面、皮肤） | 6 文件、66 项通过 |
| 第二轮 `src/next`、新导航和皮肤测试 | 34 文件、460 项通过 |
| 最后一轮 `pnpm exec vitest run src/next src/components/shell/NeutralWorkspace.test.ts src/lib/skins.test.ts src/lib/skins.default.test.ts` | 35 文件、467 项通过 |
| `pnpm build`（含前端与服务端 TypeScript 检查、Vite 构建） | 通过 |
| 对改动 TS/TSX 执行 `pnpm exec oxlint --deny-warnings` | 通过 |
| `git diff --check` | 通过 |
| 本地组件库归档与 vendor 副本 `cmp` | 一致 |

构建仍提示大于 500 kB 的分块和现有 `::highlight` CSS 兼容提示。本轮没有进行全量测试、Electron 打包或原生窗口验收。

## 隔离浏览器

使用仓库 `control-omb launch` 创建临时 HOME 和临时数据的旧聊天后端；新 core 使用另一个临时目录及 fake agents。`mountPreview` 加载真正的 `src/App.tsx`，只把请求转发到这两个隔离服务。core 的同源转发头只在临时预览脚本中处理，产品认证逻辑没有修改。未对用户真实应用或数据执行验收操作。

通过 Ego Lite 实际操作：

- 输入隔离 core 的一次性配对码，进入 Agent 页面并读到 Hermes 记录。
- Agent → 任务看板 → 终端 → 聊天切换，聊天会话栏仅在会话视图显示。
- 在 Orbit 输入并发送消息，在聊天记录中收到 fake 引擎的 `hello from fake claude`。
- 创建“Neutral UI 验收”看板和“整理本周工作安排”任务，显示新任务及详情。
- 切换浅色/深色，界面与原皮肤存储同步。
- 打开设置，Escape 关闭；经应用面板进入扩展目录。
- 390 × 844 视口打开导航抽屉，选择 Agent 后抽屉关闭；body.scrollWidth 为 390，没有横向溢出。

终端页验证了导航和页面挂载；没有连接真实 SSH 电脑、创建真实终端、测试音频/电脑控制或真实供应商生成。本轮未证明所有历史功能的全量回归。

截图：

- [深色聊天](evidence/neutral-ui/chat-dark.png)
- [浅色聊天](evidence/neutral-ui/chat-light.png)
- [任务看板](evidence/neutral-ui/board-light.png)
- [Agent 页面](evidence/neutral-ui/agents-light.png)
- [窄屏导航](evidence/neutral-ui/mobile-navigation.png)
- [窄屏 Agent](evidence/neutral-ui/agents-mobile.png)

## 回退

备份中的 `frontend-before-neutral-ui.tar.gz` 是修改前前端与依赖清单的完整快照；`working-tree.patch`、`staged.patch` 和 `untracked-source.tar.gz` 单独保留原有工作。回退前先保存重写后的当前文件，再按文件恢复；不使用整仓 hard reset。移除本轮新增的 NeutralWorkspace 文件与 vendor 包后，使用恢复的 lockfile 安装依赖。
