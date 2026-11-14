# 平台看板与国内平台运营

状态截至 2026-11-14。平台看板契约、宿主服务、路由、看板原语库、平台中心与六个平台的插件均已实现，并在隔离实例上端到端验证。

## 已实现

| 部分 | 位置 | 状态 |
| --- | --- | --- |
| 看板契约（严格 zod，插件不能注入标记） | `shared/plugins/boards.ts` | 完成 |
| 平台声明 `contributes.platform` | `shared/plugins/manifest.ts` | 完成 |
| 宿主看板服务（60 秒缓存、契约校验、错误如实上报） | `server/plugins/platform-boards.ts` | 完成 |
| 看板路由 | `server/routes/platform-boards.ts` | 完成 |
| 看板原语库（16 个原语，零新依赖） | `src/components/platforms/kit.tsx` | 完成 |
| 平台中心 / 侧边栏「平台」/ Apps 面板「国内应用」 | `src/components/platforms/`、`SidebarFooterNav.tsx`、`PluginsPanel.tsx` | 完成 |
| 共享网页线路与桥（队列、重试、限额、审计） | `plugins/eac/shared/` | 完成 |

## 六个平台

| 平台 | 线路 | 看板 | 自动化 | 未实现（如实标注） |
| --- | --- | --- | --- | --- |
| 闲鱼 | 协议线 + 网页线 + 自动降级 | 专用 | 自动回复、商品/订单同步、发布/改价/发货/退款 | 验证码与风控 |
| 贴吧 | 网页线 | 专用 | 回复通知、帖子/楼层读取、回帖 | 验证码与风控 |
| 小红书 | 网页线 | 内容台 | 选题/素材/草稿/计划、发布 | 数据回捞、验证码 |
| 抖音 | 网页线 | 内容台 | 选题/素材/脚本/分镜/计划、发布 | 数据指标、验证码 |
| B站 | 公开接口 | 通用 | 搜索、视频信息、热门榜、点赞、评论 | 弹幕/投币/收藏/关注、字幕 |
| QQ | OneBot 桥 | 通用 | 收发文本消息 | 图片/语音/文件、频道、反向 WS |

高风险动作（闲鱼的发布/改价/发货/退款、贴吧回帖、小红书/抖音发布）在规则里逐项设 `auto` 或 `manual`。默认 `manual`：进入待审批队列，由人确认后执行。两种路径都写审计。

## 验证

### 自动化

```sh
pnpm exec vitest run shared/plugins server/plugins server/routes/plugin-ui.test.ts server/routes/platform-boards.test.ts server/host/plugins-mcp.test.ts server/host/platform-inbound.test.ts
```

记录结果：34 个文件 / 241 个用例通过。其中 `server/plugins/xianyu-bridge.test.ts` 15 个用例，含协议线的真实 WebSocket 收发闭环（假网关 + 假宿主，无真实账号）、网页线的解析与自检、动作审批与审计。

```sh
pnpm typecheck && pnpm lint && node scripts/generate-locale.mjs --check
```

`pnpm lint` 全仓零警告。`i18n:check` 的 1207 条 stale 翻译在本次改动前后数量一致，均为既有问题，未新增。

### 隔离实例

```sh
EAC_PLUGIN_PROCESS=1 node --experimental-strip-types scripts/control-omb.ts launch
```

进程插件需要 `EAC_PLUGIN_PROCESS=1`；没有它时安装后状态为 `blocked`，看板如实报 `runtime-unavailable` 而不是假装可用。

验证过的路径：

1. 安装并激活六个插件，`GET /api/platform-boards` 返回六个平台且 `state: "ready"`、`live: true`。
2. `GET /api/platform-boards/<platform>` 逐个返回合法契约，未实现能力都带原因。
3. `POST .../operate` 的写动作按规则进入待审批队列，未知动作被拒绝（`unknown board action`）。
4. 队列项与审计记录同时出现在看板，`headline` 的待审批计数一致。
5. 审批一个无法执行的动作时，错误信息是插件自己的原话（`no transport line is running, so nothing can be sent`），且该失败写入审计。

## 待真实账号验证

以下只能由持有人在真实账号上验证，fixture 无法覆盖：

- 闲鱼协议线的真实 token 获取与 push 解包（`wss://wss-goofish.dingtalk.com/`）。
- 各平台网页选择器是否仍与线上页面一致。看板的「运行网页自检」会逐项报告哪一项没命中。
- 真实发布、改价、回帖是否被平台接受。
- 登录态过期、验证码出现时的暂停与提示是否如实。

## 已知限制

1. 协议线是非公开接口，平台可随时变更；失效时看板报错，`transport: "auto"` 会降级到网页线。
2. 网页选择器会随改版失效；解析是纯函数，选择器集中在一个文件，改版时只改那里。
3. 不做验证码破解、指纹伪装或限速绕过；遇到安全验证一律暂停并交给人。
4. `plugins/eac/shared/` 存放各插件共用的代码，不是插件包（没有 `eac-plugin.json`）。
