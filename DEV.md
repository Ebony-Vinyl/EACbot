# 开发指南（DEV）

EACbot 的完整源码仓库。本文档面向后续开发者（人或 AI）。最新状态与已知问题另见[交接文档](docs/HANDOVER-2026-11-08.md)。

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

3. **公告模块**
   - 服务端 `server/announcements.ts`（本地管理员公告，存 `announcements.json`）+ `server/announcement-feed.ts`（运营方远程公告源，`EAC_ANNOUNCEMENTS_URL` 每 10 分钟拉取）+ `server/routes/announcements.ts`（`GET /api/announcements` 全员可读；owner/admin 管理 `/api/announcements` 与 `/api/announcements/manage`）。
   - 前端 `src/components/AnnouncementsStrip.tsx`（每端顶部横幅，关闭记录在 localStorage，按 updatedAt 判定重新显示）；管理页在 设置 → Announcements（仅 owner/admin）。
   - 远程源格式：`{"version":1,"announcements":[{"id","title","body","level":"info|important","startsAt?","endsAt?"}]}`。

4. **数据目录**：`~/.eacbot/`（`server/config.ts` 的 `DATA_DIR`，可用环境变量 `EAC_DATA_DIR` 覆盖）。

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

## 插件优先架构开发计划

以下文档是 2026-11-07 的设计与 2026-11-08 的实施状态。已落地：M1 合同/注册/授权、M3 签名渠道与扩展中心、**插件工具经 `eac-plugins` MCP 服务器自动挂载进 Bot 回合**（read/draft 回合内自动授权，更强效果需主人发 grant，见扩展中心的“授权”页）、**平台入站事件 → 绑定 Bot 的会话 turn**（回复进入 outbox 由桥取走）、**官方插件包 8 个**（`plugins/eac/`：health、home-assistant、bilibili、muse、tieba、xianyu、douyin、xiaohongshu，能力矩阵见其 README）、**Tauri 宿主工程**（`hosts/tauri/`，cargo check 与合同测试通过；打包签名未做，Electron 仍是默认宿主）。进程插件需 `EAC_PLUGIN_PROCESS=1`。仍未实现：真实 OS 沙箱、SDK 发布物/testkit、QQ/B站桥的真实账户接入（合同与插件侧工具已就绪）。

- [总体架构](docs/superpowers/specs/2026-11-07-eac-plugin-platform-design.md)：稳定宿主、插件边界、平台 Bot、共享记忆与渐进迁移。
- [产品与界面设计](docs/superpowers/specs/2026-11-07-eac-product-experience.md)：扩展市场、平台看板、主题布局与模型生成面板。
- [业务集成设计](docs/superpowers/specs/2026-11-07-eac-integrations-design.md)：OFM、实时语音、QQ/B站/国内平台、Muse、健康、家居与 Tauri。
- [插件开发发布规范](docs/plugins/README.md)：manifest、SDK、权限、渠道、社区 PR、安全审核和兼容性。
- [官方插件包](plugins/eac/README.md)：八个内置插件的能力矩阵与配置方法。
- [分阶段实施计划](docs/superpowers/plans/2026-11-07-eac-plugin-platform/README.md)与[需求追踪矩阵](docs/superpowers/plans/2026-11-07-eac-plugin-platform/requirements.md)。
- [上游评估](docs/research/2026-11-07-eac-upstream-evaluation.md)：参考依据、复用边界与待验证能力。
- 验收设计：[插件平台](docs/verification/plugin-platform.md)、[业务联动](docs/verification/plugin-integrations.md)、[发布与恢复](docs/verification/plugin-release.md)。

界面入口：应用面板（侧边栏拼图按钮）顶部两张卡片直达**扩展中心**与**平台账户看板**；每个已安装插件有“授权”页（工具 × Bot 发 grant）；带 `platformBinding` 的 Bot 在侧边栏显示平台徽标。Muse 的真实出声需要播放端（KugouMusic.NET 桥）回报回执；国内平台消息收发需要各自的桥接入 `/api/platforms/inbound`。

## License

Apache-2.0（沿用上游）。基于 OpenMausBot；Live2D 播放器来自 LivLiv Player。二者署名见 README 与 NOTICE。
