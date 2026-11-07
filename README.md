# EACbot

EACbot 是一个私有的 AI 助手平台：自托管服务端 + 网页/手机界面，每个 bot 拥有独立人格与一台可完全控制的云电脑（Linux 桌面容器）。内置悬浮 Live2D 助手模型，可由 bot 实时控制动作与表情。

## 运行

```sh
pnpm install
pnpm build
node --experimental-strip-types server/eacbot.ts serve --port 8799
```

详细配置见 `docs/`。

## 开发

- Web 界面：`src/`（React + Vite）
- 服务端：`server/`（TypeScript，node 直跑）
- 悬浮模型：`src/components/Live2dOverlay.tsx` + `server/routes/mascot.ts`

---

Based on OpenMausBot (Apache-2.0). Live2D 播放器基于 [LivLiv Player](https://github.com/livliv-dev/player) (Apache-2.0)。
