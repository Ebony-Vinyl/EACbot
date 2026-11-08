# Tauri 宿主

状态：**工程已建立，`cargo check` 与合同测试通过；尚未打包签名、未做整体验收**。在 HOST-01…03 与完整旧功能回归通过前，Electron 仍是默认发布宿主；本文不作为 Tauri 可用证据。

## 结构

```
hosts/tauri/
  contract/          纯逻辑 crate（无 tauri 依赖，cargo test 可离线跑）：
                     __EAC_HOST__ 注入脚本、open_external URL 门、invoke 白名单、重启退避
  src-tauri/
    src/main.rs      入口
    src/lib.rs       装配：单实例、窗口状态、托盘、服务监督、注入合同脚本
    src/service.rs   本地 Node 服务监督：随机空闲端口、就绪探测、崩溃重启上限、退出清理
    src/commands.rs  secret_get/secret_set（keyring）、open_external、choose_folder、service_url/status
    tauri.conf.json  窗口/托盘/打包配置（frontendDist 指向仓库 dist/）
    capabilities/    Tauri 2 权限清单
```

## 合同（与 src/lib/host-adapter.ts 对齐）

页面注入 `window.__EAC_HOST__`（由 `contract/src/lib.rs` 生成，窗口创建时 eval）：

- `apiVersion: 1`，`kind: 'tauri'`
- `features`: 只声明真正实现的项（openExternal / chooseFolder / secureStorage / tray）
- `invoke(feature, command, args)`：命令必须在 `commands` 白名单内（当前仅 `secureStorage: [secret_get, secret_set]`），否则调用前即拒绝；Rust 侧 `eac-host-contract::invoke_allowed` 是同一份门
- `open_external` 只放行 http(s) 网址：`file:`、本地路径、环回/内网地址一律拒绝

## 本地运行

```sh
pnpm install --dir hosts/tauri        # @tauri-apps/cli
pnpm build                            # 先构建 Web 产物到 dist/
cd hosts/tauri && pnpm tauri dev      # 需要系统 node 与 Rust 工具链（MSVC/WebView2）
cargo test --manifest-path contract/Cargo.toml   # 合同测试（离线）
cargo check --manifest-path src-tauri/Cargo.toml # 应用编译检查
```

服务启动方式：shell 在仓库根目录运行 `node --experimental-strip-types server/eacbot.ts serve --port <随机> --no-pair`，就绪后把主窗口导航过去；进程崩溃按 1s→2s→4s→8s→10s 退避重启，5 次后停止并通知；shell 退出即杀掉服务。

## 必须补齐（验收 HOST-01…03 前）

- macOS 签名/公证、Linux 安装包：分别记录运行证据，交叉构建不算通过。
- 更新通道：签名清单、回滚、失败恢复；未签名更新不得自动安装。
- 透明置顶桌宠窗口与音频设备选择：当前只有主窗口与托盘。
- 打包资源布局：`server/` 目前以仓库目录运行，发行时需作为 resource 打进包并验证路径解析。
