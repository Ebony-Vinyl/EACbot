# 桌面宿主

EAC 的页面与服务器核心共用一套合同，宿主只提供平台能力。`src/lib/host-adapter.ts` 是唯一的能力入口：它只承认宿主明确声明的能力，未声明的能力一律 `unsupported`，不会把“可能有”当成“可用”。

## 已实现

- `web`：只声明浏览器真实具备的能力；原生文件夹选择、托盘、透明置顶、系统凭据、自动更新均为 `unsupported`。
- `electron`：从现有 preload bridge 的函数存在性推断 `openExternal` 与 `chooseFolder`；其余能力不猜测。
- `tauri`：读取页面注入的 `window.__EAC_HOST__ = { apiVersion: 1, kind: "tauri", features, commands, invoke }`，只执行声明为 `available` 的能力，且 `invoke` 只放行 `commands[feature]` 中列出的命令。
- 外部链接只允许 `http(s)`；`file:` 等协议在调用宿主前就被拒绝。
- 合同测试：`pnpm exec vitest run src/lib/host-adapter.test.ts`。

## 未实现

`hosts/tauri/` 目前只有设计说明，没有可运行的 Tauri 工程，也没有在 Windows/macOS/Linux 上构建或验证过。Electron 仍是唯一发布宿主。Tauri 需要补齐：

1. 托管同一 Node 服务：就绪探测、端口冲突、崩溃恢复、退出清理与单实例。
2. 页面注入 `__EAC_HOST__`，只声明真正实现的命令。
3. Windows 托盘、透明置顶桌宠、音频/麦克风、系统凭据、签名更新逐项验证。
4. 远端模式下本地设备按配对授权，不能把 Node 服务权限和桌面壳权限混为一谈。
5. HOST-01…03 与旧功能回归通过后才讨论默认切换。

在这些完成前，本文和任何发布说明都不得写成“Tauri 已支持”。
