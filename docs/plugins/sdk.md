# SDK 与运行协议

状态：设计 v1。已实现 Manifest、生命周期、安装记录、权限求交、opt-in stdio supervisor，以及经宿主授权后发送 `tools/call` 并解析 `ActionResult` 的路径。尚未实现：把插件工具自动挂载到 Bot 的 MCP 工具列表、完整 HostContext 面、外部服务传输和 testkit 发布物。现有代码不等于完整 SDK。包结构见 [Manifest](manifest-v1.md)，权限判定见[权限规范](permissions.md)。

## 1. 服务发现与传输

一方适配器与社区插件都经注册表声明服务。后端进程默认使用 stdio NDJSON JSON-RPC 2.0；stdout 仅承载协议，日志写 stderr 并脱敏。外部服务可以使用受鉴权 HTTP/WebSocket 或 MCP 适配器；远端必须 TLS，loopback 不被视为无需身份验证。

握手包含协议版本、安装身份、宿主能力、请求预算和挑战；宿主验证启动进程或连接身份后发短期 token。插件不能通过握手自报管理员或别人的 installationId。服务实例不可被未授权插件替换；版本与依赖满足后才进入 active。

MCP 工具经现有 `server/mcp-gate.ts` 和 `shared/tool-scope.ts` 接入 Agent，复用 `SendTurnInput.integrations`，不为每个平台增加驱动专用路径。这条自动挂载尚未完成；当前只能由宿主授权 API 调用插件工具。

### 1.1 已实现的工具调用

进程插件在 `initialize` 成功后，宿主可发送：

```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"toolId":"send-message","arguments":{},"context":{"installationId":"...","grantId":"...","botId":"...","principalId":"...","audienceId":"...","epoch":1}}}
```

插件必须回答 `ActionResult`（`succeeded/failed/cancelled/indeterminate`）。宿主先检查安装为 active、`contributes.tools[].permission` 与 effect 匹配、grant 覆盖 Bot/principal/audience/账户等资源，并先持久化 `uses` 再调用插件；返回不符合 schema 时记为 `failed`，不把未知答案当成功。stdio 调用有超时，进程退出会拒绝所有未完成调用。

## 2. 最小调用合同

```ts
export type Effect =
  | "read" | "draft" | "control" | "write"
  | "send" | "delete" | "financial" | "security";

export interface CapabilityCall {
  requestId: string;
  traceId: string;
  capability: string;
  version: string;
  arguments: unknown;
  context: {
    workspaceId: string;
    installationId: string;
    botId?: string;
    accountId?: string;
    taskId?: string;
    deviceId?: string;
    principalRef: string;
    audienceRef: string;
    grantRef: string;
    authorizationEpoch: number;
  };
  deadline: string;
  idempotencyKey?: string;
}

export type ActionResult =
  | { status: "succeeded"; value: unknown; receiptId?: string }
  | { status: "failed"; code: string; message: string; retryable: boolean }
  | { status: "cancelled"; reason: string }
  | { status: "indeterminate"; operationId: string; verification: "pending" | "unavailable" };

export interface AcceptedOperation {
  operationId: string;
  state: "accepted";
}
```

`context` 是宿主根据已验证的调用链注入的只读对象，不是模型工具参数。插件返还的 `succeeded` 要经过适配器验证；涉及外部效果的工具需回执或可观察状态。`AcceptedOperation` 是开始异步工作的协议回包，不能当作最终 ActionResult。

参数在批准时冻结并计算摘要；执行前重新验证身份、epoch、账户和摘要。批准“发 A”不能用于发 B。`requestId` 匹配单次调用；业务幂等键对应同一效果，不随网络重试随机生成。

取消是独立 `requests.cancel` 消息，按 requestId 关联；取消未派发动作可确定终止，已派发外发若无回执则为 indeterminate，不能伪造 cancelled。流式音频需携带 generation，取消后丢弃旧 generation 的帧。

## 3. 生命周期

| 状态 | 允许动作与退出条件 |
| --- | --- |
| discovered | 查看来源、版本、权限；未下载不执行包代码 |
| downloaded | 制品仅在独立暂存目录；未校验不能解包激活 |
| verified | 签名、摘要、结构与兼容校验完成，尚未授权 |
| installed-disabled | 已安装但不激活、不自动运行任务 |
| starting | 建立隔离、握手、依赖和配置检查；超时转 failed |
| active | 接收获授权调用；定时执行仍须规则授权 |
| stopping | 停止新调用，取消/排空任务，撤销订阅和令牌 |
| disabled | 无可调用能力；保留配置与数据 |
| blocked | 依赖、权限或隔离不足；显示恢复条件 |
| failed | 启动/运行错误，记录原因并限次恢复 |
| revoked | 渠道或用户撤回；拒绝启动/更新与外发，保留数据 |

更新可用是 installed/active 之外的元数据，不打断现有生命周期。宿主退出先停止接单再调用 dispose；进程不响应时按截止时间终止，仅终止该安装拥有的进程树。

注册服务、工具、UI、事件和任务入口均返回 disposer。部分激活失败要撤销已完成的注册；旧版本未成功停用时不能同时启用新版本消费同一事件。

## 4. HostContext 面

设计 API 分组：`services`、`capabilities`、`events`、`storage`、`secrets`、`tasks`、`models`、`ui`、`log`。不存在“拿到整个 server/store”接口。

- `services`：发现已授权服务版本，不暴露 live 对象。
- `capabilities`：经 broker 调用，不能绕过 effect/账户/受众检查。
- `storage`：只访问自身 installation 命名空间，写入支持 revision/CAS 和配额。
- `secrets`：获取值无关状态或凭据引用；默认 broker 注入鉴权，不返明文。
- `tasks`：创建已授权的任务模板实例，受调度配额与取消语义约束。
- `models`：调用已选模型，携带数据用途、trace 与成本预算，不自建未经记录的模型请求。
- `ui`：注册 manifest 已申报的贡献，无任意宿主 DOM/路由注册。
- `log`：结构化级别、错误码和关联 ID，禁止秘密与完整私信。

示例源码落点 `packages/plugin-sdk/` 和 `packages/plugin-testkit/` 为计划新增，不能在实现前执行所谓 `create-eac-plugin` 命令。

## 5. 事件协议

```ts
export interface DomainEvent {
  eventId: string;
  schemaVersion: number;
  type: string;
  occurredAt: string;
  producerInstallationId: string;
  workspaceId: string;
  botId?: string;
  accountId?: string;
  deviceId?: string;
  taskId?: string;
  traceId: string;
  causationId?: string;
  streamId: string;
  sequence: number;
  payloadRef: string;
}
```

payloadRef 对应受授权存储，不通过广播发秘密。事件来源验证证明生产者身份，不证明内容是真实事实或可信指令。所有外部文本进入模型均保留不可信来源标记。

交付默认 at-least-once、有界重放，消费者以 eventId 去重；同 stream 内按 sequence 排序，跨 stream 不承诺全局顺序。超出重放窗口请求状态快照；慢消费者触发背压或断开，不能无限缓存。

状态通知可以合并为最新快照；交易/外发结果等不可丢事件进入持久 outbox。死信保留 ID、错误码和可控数据引用，人工重放仍需重新授权。用户撤销授权后不因重放获得旧权限。

## 6. 默认预算

以下是 EAC v1 的设计默认值，不是实测性能或上游限制。调整需同步合同测试与审核。

| 项 | 默认 |
| --- | --- |
| 控制消息 | 单帧 1 MiB；音频不走 JSON base64 控制帧 |
| 握手/健康探测 | 10 秒 / 5 秒 |
| 普通能力调用 | 30 秒默认；显式长任务最多 15 分钟并可取消 |
| 停止宽限 | 5 秒后终止所属进程树 |
| 事件队列 | 每订阅 256 项或 4 MiB，先达到者触发背压 |
| 重放 | 24 小时且每安装最多 10,000 条，受数据保留策略进一步限制 |
| 自动重启 | 10 分钟内最多 3 次，指数退避后熔断 |
| 外发重试 | 仅确定未执行或平台保证幂等时自动重试；不明结果暂停 |
| UI 查询 | 每 frame 10 秒最多 10 次；轮询最短 5 秒，优先事件订阅 |

资源预算不能只在 manifest 写数字；运行平台无法强制 CPU/内存/网络限额时必须报告未强制，并依所需隔离策略决定能否启动。

## 7. 存储、迁移与异常

沿用 `writeFileAtomic` 等已有可靠原语，业务配置、安装状态、秘密、缓存、审计分离。迁移先备份快照并校验，再在工作副本上执行，成功后原子切换。新代码不得直接覆盖旧状态后再声称可回滚。

标准错误码：`INVALID_ARGUMENT`、`VERSION_UNSUPPORTED`、`DEPENDENCY_UNAVAILABLE`、`PERMISSION_DENIED`、`AUTH_EXPIRED`、`SANDBOX_UNAVAILABLE`、`CONFLICT`、`RATE_LIMITED`、`DEADLINE_EXCEEDED`、`DEVICE_OFFLINE`、`UPSTREAM_UNAVAILABLE`。错误信息使用脱敏说明与用户恢复动作；详细堆栈不自动发给模型或前端。

`RATE_LIMITED` 可附 retryAfter；只有可重试且幂等语义明确的调用才自动重试。`indeterminate` 不改写成普通失败来触发重试。

## 8. 合同测试要求

testkit 必须提供假的宿主、模型、事件、存储、时钟、审批、设备和音频焦点。插件开发者无需真实账号即可测试：生命周期逆序清理、取消、幂等、权限撤销、版本不兼容、缺依赖、队列超限、进程崩溃、数据迁移失败及 UI 越权。

具体测试 ID 与发布证据见[平台验收](../verification/plugin-platform.md)和[集成验收](../verification/plugin-integrations.md)。
