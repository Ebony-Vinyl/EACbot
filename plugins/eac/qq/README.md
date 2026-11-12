# EAC QQ 桥（OneBot v11）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| QQ 消息 → 绑定 Bot 的会话 | production | 经 OneBot v11 正向 WebSocket 接收群聊/私聊，投递到宿主 `/api/platforms/inbound` |
| Bot 回复 → QQ | production | 轮询宿主 `/outbox`，以 `send_group_msg` / `send_private_msg` 发出，OneBot 回执成功后 ack |
| 桥状态与手动发送 | production | `qq-bridge-status`、`qq-send-message`、`qq-bridge-configure` |
| 官方 QQ Bot（QQ 开放平台） | unavailable | 与 OneBot 是两套协议，本桥不冒充支持 |
| 图片/语音/文件消息 | unavailable | 只转发文本；附件不猜测类型也不静默丢弃 |
| 频道（guild）与评论 | unavailable | OneBot v11 没有对应发送动词，事件与回复都明确拒绝 |

## 它做什么，不做什么

桥只搬字节：一条 OneBot 事件变成一条平台入站事件，一条 outbox 回复变成一次 OneBot 动作。**谁说的话是谁、是不是回声、要不要回复、回复什么，全部由宿主判定**：

- 去重按 `eventId`（`qq-<message_id>`），同一事件重投只会被当成 duplicate；
- 回声按 `sender.id === 账户的 externalAccountId` 识别，桥自己不做这个判断；
- 未在宿主登记身份的人一律是 guest，桥不传任何“我是主人”的声明；
- 每个 QQ 会话对应宿主里一个持久线程，群与私聊互不相通。

## 三种结果必须分清

| 情况 | 桥的行为 |
| --- | --- |
| OneBot `retcode: 0` | 视为已交给 OneBot，ack 掉这条回复 |
| OneBot 明确拒绝（非 0 retcode） | **不 ack**，回复留在 outbox 并记录原话；不重试、不假称已发 |
| OneBot 30 秒内不回话 | **不 ack**，记为“结果不明”；人工核对后再处理，桥不自动重发 |

宿主 409（会话正忙或线程数已满）同样不消费事件，桥把事件留在本地队列里继续重试。

## 配置

在插件工作目录写 `config.json`（也可用 `qq-bridge-configure` 工具写）：

```json
{
  "onebotUrl": "ws://127.0.0.1:3001",
  "accountId": "<宿主里这个 QQ 平台账户的 id>",
  "onebotToken": "<OneBot 的 access_token，可选>",
  "serverUrl": "http://127.0.0.1:8799",
  "serverToken": "<EACbot 访问令牌，可选>"
}
```

- **`accountId` 必填**：先在「应用面板 → 平台账户」建一个 `qq` 账户并绑定 Bot，再把它的 id 填进来。
- **`serverToken`**：本机自建服务器（`eacbot serve`，loopback 即 owner）可省略。**Electron 桌面应用与远程部署必须填**，用 `eacbot token create NAME --scope admin --out FILE` 生成——`/api/platforms/*` 需要 admin 权限，client 令牌会被 403。
- **`onebotToken`**：同时以 `?access_token=` 查询参数和 `Authorization: Bearer` 头发送，兼容大多数 OneBot 实现的两种取法。

改完 `config.json` 需停用再激活插件：连接在激活时建立。

## 已知限制

- 只支持**正向 WebSocket**。反向 WS 与 HTTP POST 上报告警的 OneBot 实现需要额外适配。
- 断线重连采用 1s→2s→4s→8s→16s→30s 退避，没有上限，进程不退出。
- 本地待投递队列上限 200 条，溢出时丢弃最旧的一条并记录，不静默扩容。
- 未接入真实 QQ 账号的验收；`QQ-01/02/03` 仍只覆盖 fake OneBot 与隔离 fixture。

## 测试

```sh
pnpm exec vitest run server/plugins/qq-map.test.ts server/plugins/qq-bridge.test.ts
```

`qq-map.test.ts` 覆盖字段映射与所有拒绝分支（无文本、guild、无 id、非数字会话、空回复、各种 retcode）；`qq-bridge.test.ts` 起真实 WebSocket 与真实 HTTP，覆盖收发闭环、忙时保留事件、拒绝不 ack、不回话记为不明、未连接拒发、配置写入与校验。
