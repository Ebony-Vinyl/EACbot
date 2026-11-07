# 开发指南（DEV）

EACbot 的完整源码仓库。本文档面向后续开发者（人或 AI）。

## 架构

- `src/` — Web 界面（React + Vite）。桌面/手机浏览器与 PWA 都用它。
- `server/` — 服务端（TypeScript，Node 24 以 `--experimental-strip-types` 直跑，无需编译即可运行）。
- `shared/` — 前后端共享类型与工具。
- `public/characters/` — 内置 Live2D 角色模型（LivLiv 格式）。
- `docs/`、`skills/`、`companion/`、`connector/`、`electron/` 等 — 上游沿用目录，各自独立。

## 关键自研功能（本项目新增）

1. **悬浮 Live2D 助手**
   - 前端：`src/components/Live2dOverlay.tsx`（页面悬浮 + EventSource 订阅命令流）、`src/lib/live2d.ts`（开关状态，localStorage）。
   - 设置开关：`src/components/AppSettingsRows.tsx` 的 `Live2dRow`（挂在 `SettingsModal` 与 `SettingsSimplePages`）。
   - 服务端：`server/routes/mascot.ts` — `GET /api/mascot/stream`（SSE 广播）与 `POST /api/mascot/cmd`（loopback 或 session 可发）。
   - 命令：`act`（nod/shake/tilt/hop/shy）、`expression`、`params`、`say`（text 走浏览器 TTS / clip 为音频地址）、`load`（切换角色）、`scale`。

2. **bot 头像池**
   - 服务端 `server/avatar-pool.ts`：新 bot 创建时从数据目录的 `avatar-pool/` 里按 bot id 稳定散列取一张图，经 `saveImage` 存入 attachments 并设为头像（圆形裁剪）。
   - 往池子里加图：直接放入 `png/jpg/webp/gif` 文件即可，无需重启。

3. **数据目录**：`~/.eacbot/`（`server/config.ts` 的 `DATA_DIR`，可用环境变量 `EAC_DATA_DIR` 覆盖）。

## 构建与运行

```sh
pnpm install          # Node >= 24
pnpm build            # tsc -b && tsc -p tsconfig.server.json && vite build
node --experimental-strip-types server/eacbot.ts serve --port 8799 --no-pair
```

- Web 产物在 `dist/`；服务端启动时用环境变量 `EAC_STATIC_DIR=<dist 路径>` 指向它。
- 只改了服务端代码时可不重新构建 Web，重启进程即可。

## 约定

- 服务端路由写在 `server/routes/*.ts`，返回 `PASS` 表示不处理；在 `server/index.ts` 里 `ROUTES.push(...)` 注册。
- 设置开关类 UI：参考 `src/lib/send-key.ts`（useSyncExternalStore + localStorage）+ `AppSettingsRows.tsx` 的 Row 模式。
- 文案要进 `src/locales/en.json` 与 `src/locales/zh.json`（key 缺失时 UI 会显示 key 名）。
- 仓库内不允许出现：任何部署服务器的 IP/域名、SSH 信息、API key、真实用户数据。配置一律走环境变量或运行时数据目录。

## License

Apache-2.0（沿用上游）。基于 OpenMausBot；Live2D 播放器来自 LivLiv Player。二者署名见 README 与 NOTICE。
