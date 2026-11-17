# 简约工作空间布局

本次改动影响范围是全局导航、主题配色、项目会话布局与默认外观模块。

## 已确认的设计

以实用为主，白底黑灰区分层级，主要功能直接可见，低频操作归属到相关功能。

- 主导航：对话、项目、任务。任务默认进入已有看板，执行任务和日程是二级入口；对话下保留现有个人助手入口。
- 团队、健康、首页、扩展放入可展开的更多工具。设置固定在导航底部；资源与连接沿用设置内的小面板。
- 项目页使用统一导航，移除重复应用切换、设置和新建入口。当前会话内保留对话与终端切换。
- 白色主区域、浅灰导航、黑色主要操作，减少卡片阴影；语义警告和代码内容保留颜色。
- 新安装默认 Daylight；已有外观选择和手动跟随系统能力保留。

选择复用既有组件、状态和路由，避免重建应用壳或合并不同后端的任务数据。假设现有数据规模与权限模型不变；不增加请求、依赖或后端接口，不修改用户真实会话。

## 验证

测试预算三轮，最终六个测试文件共 38 项通过：导航分组、原有动作可达、项目会话切换与草稿、默认主题与已有选择保留。

- `pnpm exec vitest run src/components/shell/NeutralWorkspace.test.ts src/next/workbench/HerdrPage.test.ts src/next/pages/shell-wiring.test.ts src/lib/skins.test.ts src/lib/skins.default.test.ts src/next/foundation/theme.test.ts`：通过。
- `pnpm typecheck`：通过。
- `pnpm i18n:check`：通过。
- 定向 `oxlint` 与 `git diff --check`：通过。
- 隔离 Electron 使用临时用户目录、本机临时 core 和合成会话内容；验证统一导航可见、项目栏 228px、工具步骤保留、任务二级入口，以及桌面 1260px 和手机 390px 无横向溢出。
- 明暗与手机宽度截图已检查。未重新运行全仓测试、真实模型调用、正式打包或真机触控验收；既有全仓检查问题不在此次修改范围。

## 预览

[项目页](evidence/monochrome-workspace/projects.png) · [任务页](evidence/monochrome-workspace/tasks.png) · [手机宽度](evidence/monochrome-workspace/mobile.png) · [深色兼容](evidence/monochrome-workspace/dark.png)

源码修改前备份保存在仓库同级 EACbot-backups/monochrome-20261117-155615。
