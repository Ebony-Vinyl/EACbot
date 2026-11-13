# EAC 飞书桥（Feishu / Lark）

| 能力 | 状态 | 说明 |
|---|---|---|
| 飞书私聊/群聊文本 -> 绑定 Bot | 已实现（需真实租户验收） | 通过 lark-cli 的 `im.message.receive_v1` 事件，投递到 EAC `/api/platforms/inbound` |
| Bot 回复 -> 飞书 | 已实现（需真实租户验收） | 轮询 EAC outbox，优先回复原消息，带 `uuid` 幂等键 |
| @ 识别、群/私聊区分 | 已实现 | 只接受配置的 chat 和 allowedSenders |
| 图片/文件/语音/视频/卡片 | 不支持 | 第一版只接收 `text`；其他类型明确跳过，不伪造内容 |
| 飞书原生审批卡 | 不支持 | EAC 的审批仍在本地 UI；不要为了“能用”改成 full |
| 多实例长连接 | 不支持 | 同一飞书应用只允许一个事件消费者 |

## 它做什么

飞书企业自建应用 -> `lark-cli event consume im.message.receive_v1 --as bot` -> 本地持久队列 -> `/api/platforms/inbound` -> 绑定 EAC Bot 的回合 -> `platforms/outbox.json` -> `lark-cli im +messages-reply` -> 飞书原消息。

桥只搬文本。发送者是谁、是否为 owner、是否允许多个群、是否被 @，由桥的配置和 EAC 宿主共同约束；桥不会因为消息内容把某人提升为主人。

## 配置

在插件工作目录写 `config.json`：

~~~json
{
  "cli": "D:/tools/lark-cli.exe",
  "larkConfigDir": "D:/eacbot-data/lark-feishu",
  "accountId": "<EAC 平台账户 UUID>",
  "botOpenId": "ou_xxx",
  "botAppId": "cli_xxx",
  "serverUrl": "http://127.0.0.1:8799",
  "serverToken": "<可选，admin token>",
  "chats": "oc_group1:mentions,oc_group2:all",
  "allowedSenders": "ou_owner1,ou_owner2",
  "directMessages": true,
  "otherChats": "none",
  "pollMs": 1000
}
~~~

- `cli` 推荐指向真实的 `lark-cli.exe`；也支持 `.cmd` 包装器。`.cmd` 的参数由插件生成，文本只走 stdin；不要填 `.ps1`，PowerShell 对 `--flag` 的参数绑定不可靠。
- `larkConfigDir` 必须独立；app secret 由 lark-cli 存到系统钥匙串，EAC 配置不要保存 app secret。
- `chats` 为空表示不接收群；`allowedSenders` 为空表示不接收任何人。这是失败关闭的安全默认。
- `otherChats=mentions` 只接收未列出群里的 @ 消息；不建议第一版使用 `all`。

## 准备飞书应用（人工步骤）

1. 创建**企业自建应用**并开启机器人能力。
2. 申请最小权限：私聊 `im:message.p2p_msg:readonly`、群 @ `im:message.group_at_msg:readonly`、发送 `im:message:send_as_bot`；需要群列表/成员时再申请 `im:chat:readonly`/`im:chat.members:read`。
3. 在事件与回调中选择**使用长连接接收事件**，添加 `im.message.receive_v1`。
4. 发布应用版本，设置可用范围，把机器人加入测试群。
5. 用独立配置目录初始化 lark-cli：

~~~powershell
$env:LARKSUITE_CLI_CONFIG_DIR = 'D:/eacbot-data/lark-feishu'
lark-cli config init --app-id cli_xxx --app-secret-stdin
lark-cli config strict-mode bot --global
lark-cli auth status --json
lark-cli api GET /open-apis/bot/v3/info --as bot --format ndjson
~~~

不要把 app secret 粘贴到聊天、日志或 EAC 的配置中。

最后一条返回的 `bot.open_id` 填到配置的 `botOpenId`；`auth status` 里的应用 ID 可填到 `botAppId`。

## 失败语义

- 飞书事件先落本地队列，再异步投递；宿主 409/5xx/网络错误保留并退避。
- 宿主 400/404/422 是不可重试的拒绝，丢弃并计数。
- 飞书回复成功才 ack；30 秒无回执/超时标为 unknown，不假装成功。
- 230011/撤回/找不到：标记 gone，ack，不无限重试。
- 230071/230072：去掉话题回复再试一次。
- 230011 之外的 4xx 不会无限重试，保留错误供人工检查。

## 已知限制

- 第一版是文本桥，不支持附件和飞书卡片。
- EAC 平台身份目前没有真正进入工具 confinement；第一版只开放主人私聊/指定主人群。
- 进程插件需要 `EAC_PLUGIN_PROCESS=1`，否则 EAC 不会启动它。
- 同一飞书应用不能开多个长连接消费者；多实例需要 Webhook + 共享队列/网关。

## 测试

~~~sh
pnpm exec vitest run server/plugins/feishu-map.test.ts server/plugins/feishu-bridge.test.ts
~~~

测试使用 fake lark-cli 和 fake EAC HTTP，不接触真实飞书账号。
