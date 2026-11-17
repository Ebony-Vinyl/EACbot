# EAC 闲鱼助手

闲鱼账户桥与运营台。两条传输线路并存，上层（知识库、规则、队列、审计、看板）只写一遍。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 知识库与自动回复规则 | production | 保存于插件工作目录 `xianyu-kb.json`；每日上限、仅回复可信人、按动作设 auto/manual |
| 接收消息并交给 Bot | production | 两条线路都投递到宿主 `/api/platforms/inbound`，Bot 回复从 `/outbox` 取回；与 QQ 桥同一套合同 |
| 协议线路 | experimental | 直连消息网关：mtop 签名 + LWP over WebSocket，15 秒心跳，token 过期自动重取。非公开接口，平台可随时变更 |
| 网页线路 | experimental | 驱动一个你已登录的 Chrome（CDP）。不持有 Cookie；页面改版后「自检」会指出哪一项不再匹配 |
| 商品与订单同步 | experimental | 依赖网页结构；失败如实上报，不返回编造数据 |
| 发布 / 改价 / 发货 / 退款 | experimental | 每项在规则里独立设 `auto` 或 `manual`；`manual` 进待审批队列，`auto` 执行后写审计 |
| 验证码与风控 | unavailable | 遇到安全验证一律暂停并交给本人处理。不做破解、不做指纹伪装、不做限速绕过 |

## 两条线路

`config.json` 的 `transport`：

- `protocol`：用 `cookie` 换取 IM token，直连 `wss://wss-goofish.dingtalk.com/`。延迟低，不需要浏览器；Cookie 失效时如实报 `session-expired`。
- `web`：用 `cdpUrl` 连接一个你已登录闲鱼的 Chrome，操作真实页面。不需要 Cookie，抗协议变更，能覆盖发布/改价这类只有网页才有的操作。
- `auto`：`protocol` 为主，它断开时切到 `web`，切换会记在看板与日志里。一条线路发送失败时不会让另一条重发同一条消息。

## 动作与审批

`rules.actions` 逐项控制：`publish`、`set-price`、`ship`、`refund`。默认全部 `manual`：动作进入待审批队列，由你在看板确认后执行。改成 `auto` 后由插件直接执行。两种方式都写入 `xianyu-audit.json`，看板可读。

## 许可与来源

本插件的协议行为（端点形状、签名规则、push 打包方式）参考了公开流量与下列项目所描述的事实，**未复制任何代码**：

- [xianyu-auto-reply](https://github.com/zhinianboke/xianyu-auto-reply)：AGPL-3.0 且声明禁止商业用途，与 Apache-2.0 不兼容。
- [xyxyxy](https://github.com/chinamonarchs/xyxyxy)：无许可证，核心为模拟器 hook 与风控绕过，不引入。

## Cookie 安全

Cookie 只保存在本机插件工作目录 `config.json`（`0600`），只用于直接与闲鱼通信，绝不发给任何第三方。网页线路不需要 Cookie：登录态留在你自己的浏览器里。
