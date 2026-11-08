# EAC 闲鱼助手

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 知识库/自动回复规则（本地） | production | 保存于本机 `xianyu-kb.json`；范围、只回复可信人、每日上限可配置 |
| 商品搜索 | experimental | 移动 Web mtop 接口 + 已登录 Cookie；无官方合同，Cookie 过期如实报 `session-expired` |
| 消息收发（会话内自动回复） | 需要桥接 | 由独立的闲鱼桥（如 xianyu-auto-reply 类项目）投递事件到宿主 `/api/platforms/inbound`，回执从 `/outbox` 取 |
| 发布/改价/订单交易 | unavailable | 高影响操作逐项核实前不实现，不假装可用 |

## Cookie 安全

Cookie 只保存在本机插件工作目录 `config.json`，只用于直接与闲鱼通信，绝不发给任何第三方。出现风控/验证要求时插件停止并上报，不做任何绕过。
