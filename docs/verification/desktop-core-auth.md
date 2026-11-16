# 桌面本机任务服务授权

本次改动影响范围是 Electron 任务服务进程、新 core 启动装配和任务前端认证模块。

## 行为

本机桌面主窗口首次进入任务页面时，Electron 启动自己管理的新 core 子进程，使用随机回环端口和当前工作区数据目录下的 `task-core/`。core 通过继承的私有 IPC 通道交给父进程一份 owner 会话，渲染端经受限 preload 获取连接并仅保存在内存。没有 HTTP 免认证入口，不因来源为 localhost 自动授权。桌面未配置 Agent 时返回空列表，不创建模拟 Agent。

IPC 使用既有本机 origin 和主工作区校验，并额外拒绝远端客户端与子 frame。桥不对远端页面开放。core 的 CORS 只允许启动它的桌面页面 origin，API 仍验证 Bearer。SSE 与终端 WebSocket 使用 core 自己的地址及原单次票据。

任务页面每两秒检查连接；core 退出后按需重启、换发会话，下一次 API 请求使用新地址和凭据。不会自动重放失败的业务变更。桌面退出和父进程断开时关闭 core。外部浏览器和手机继续沿用配对路径；本次未添加手机到新 core 的远端传输或配对码管理界面。

源码模式使用 `core/bootstrap/main.ts`；发行模式使用 `dist-server/task-core.js`。已有 server 资源目录会携带该产物。

## 验证（2026-11-16）

- `node --test electron/core-service.node-test.mjs`：真实隔离 core 子进程，无码 owner 授权、无凭据 401、外部 origin 403、进程退出重启、旧 token 失效及新 token 可用通过。
- `pnpm exec vitest run --config core/vitest.config.ts`：203 项通过。
- `pnpm exec vitest run src/next/foundation src/next/pages`：50 项通过，包含凭据不写 localStorage、请求使用重启后地址和 token。
- `pnpm exec tsc -b` 通过。core 独立类型检查初次发现可选 disconnect 调用错误，修正后 `pnpm exec tsc -p core/tsconfig.json --noEmit` 通过。
- 改动模块 oxlint、Electron 主进程/preload 语法检查及 `git diff --check` 通过。
- `pnpm exec vite build` 通过，仍有大分块提示。
- 单独 esbuild 构建 task-core.js 通过。
- 使用临时 userData、临时 core 数据和真实 Electron + preload IPC 加载隔离 UI：Agent 页面免配对进入，结束 core 子进程后自动恢复，电脑页面可读取，最终 `automaticAuthorization=true, restartRecovery=true, pairingGate=false`。

Electron 验收使用独立最小宿主接入真实进程管理模块和真实前端，未重启用户当前应用，也未验收正式 main.mjs 的全部窗口/环境切换流程。首次脚本将 app.whenReady 放进顶层 await 导致初始化等待，改为 ready 回调后通过。

## 限制

首次完整 `node scripts/bundle-server.mjs` 在原服务 bundle 阶段遇到 Matter 依赖的 `bun:sqlite` 无法解析；后续已修复该构建边界，完整 bundle 与脱离 node_modules 的服务 smoke 通过，见 [Matter 打包修复](matter-bundle.md)。尚未制作签名桌面发行包。未执行全仓测试、真机手机配对、真实 SSH 终端或真实模型请求。

回退本次 core-service、启动装配、preload/type bridge 和任务认证改动即可恢复原配对路径；不需要迁移旧聊天数据。新 core 的数据位于独立 task-core 子目录。
