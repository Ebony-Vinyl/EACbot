# 桌面本机环境接入

本次改动影响范围是桌面启动、本机环境发现、Agent 装配、Herdr 终端和相关前端模块。

## 行为

- 仅桌面托管的任务服务自动发现本机，返回稳定的 `local` 环境；不写 SSH 连接记录，不需要配对码，不允许删除内置本机。
- 从现有 Agent 注册表读取版本探测规则，固定 argv、并行探测，每个进程最多 10 秒。已配置的 Agent（包括禁用项）优先于自动发现。
- 原生 CLI 适配器使用本机 HOME 和现有凭据文件。HTTP 适配器仍需服务地址，不因 CLI 已安装而伪报为已配置。
- Herdr 使用现有 `localConnectPlan`，本机工具使用探测到的绝对路径及本机 PATH；SSH 连接保持原来的主机指纹检查。
- 复用 `electron/shell-path.mjs` 解析 Finder/Dock 启动时的工具路径。
- Agent 页展示安装状态；终端选择器仅对本机筛选已安装工具。安装新工具后重启桌面重新探测。

## 验证（2026-11-16）

预算：最多 3 轮，所有测试数据在临时目录。

- `pnpm exec vitest run --config core/vitest.config.ts core/bootstrap`：77 项通过。
- `pnpm exec vitest run --config core/terminal/vitest.config.ts core/terminal/service.test.ts`：33 项通过，包含本地 Herdr argv 和免 SSH 路径。
- `pnpm exec vitest run src/next/workbench src/next/settings src/next/personal/CreateMission.test.ts`：263 项通过。
- `node --test electron/core-service.node-test.mjs electron/shell-path.node-test.mjs`：4 项通过，子进程 HOME/PATH 隔离。
- `pnpm exec tsc -b`、`pnpm exec tsc -p core/tsconfig.json --noEmit`、变更文件 oxlint、Electron 语法检查和 `git diff --check`：通过。
- `node scripts/bundle-server.mjs`：通过。
- 隔离 Electron 窗口加载真实前端和真实任务服务，以临时假 Codex CLI 验证自动发现、自动授权、本机行和不可删除入口。[截图](evidence/local-computer/computers.png)。
- 真实已安装 Herdr：单独设置临时 HOME、XDG 目录、`HC_SOCKET` 和 `HC_SESSION`，通过真实 TerminalService 启动假 Claude CLI；读取终端得到 `EAC_LOCAL_TERMINAL_OK`。随后结束该测试终端、停止独立 Herdr 并删除临时目录。
- 当前真实桌面只做启动和展示读回：显示本机自动连接以及 Claude Code、Codex 安装状态，工具摘要包含 OpenCode，没有发送真实模型任务。

## 限制

未验证真实模型生成、手机远程配对或完整安装包。模型目录未由引擎报告时保留未知状态。OpenCode/Hermes 的 HTTP 服务不会自动启动，也不迁移旧聊天后端的供应商设置。

自动发现与用户手动配置分开，未修改用户 `core.json`、Agent 凭据或原有 SSH 记录。回退本次源码改动并重启即可移除内置本机接线。
