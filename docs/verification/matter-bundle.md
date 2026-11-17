# Matter Node 打包修复

本次改动影响范围是服务端发行打包模块。

## 根因与修复

Matter.js 0.18.0 的 SqlitePlatform 根据 `process.versions.bun` 动态导入 BunSqlite 或 NodeJsSqlite。esbuild 在构建时解析两条路径，无法解析 Bun 专有内置模块 `bun:sqlite`。

只将 `bun:sqlite` 标为 external 会把该导入提升到 ESM 顶层，Node 仍会在启动时报 ERR_UNSUPPORTED_ESM_URL_SCHEME。已通过独立运行探针确认并放弃此方式。

最终在 `scripts/bundle-server.mjs` 对 Matter SqlitePlatform 内的 BunSqlite 动态导入保留 external 边界。限定 importer 和 dynamic-import 类型，NodeSqlite 仍正常打包，其他依赖不受影响。路径分隔符先归一化以兼容 Windows 构建机。发行运行环境是 Node/Electron，不分发不可达的 Bun 平台适配器；如果未来支持 Bun，应单独准备 Bun 产物。

## 验证

2026-11-16，最多三轮验证。

- 完整 `node scripts/bundle-server.mjs` 与标准 `pnpm build:server` 均通过，包含 task-core.js。
- 将 Matter 实际 SqlitePlatform 用相同构建规则打包到仓库外临时目录，在 Node 24 下创建数据库、写入、关闭、重新打开和读回通过。
- `node scripts/smoke-packaged-server.mjs` 通过：仓库外无 node_modules 的服务启动、13 个代理路径、MCP stdio、doctor/bots、加密备份 worker、容器启动器清理、桌面入口两次启动及企业层加载。
- 打包脚本 oxlint 与 `git diff --check` 通过。

没有升级或修改 node_modules，没有替换 SQLite 实现，没有触碰真实应用数据。完整安装包签名、公证和发行渠道未在本轮验证。回退仅需移除 matter-node-runtime 构建插件。
