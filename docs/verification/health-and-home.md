# 健康与家居（health and home）

两个核心数据域：健康读数与家居设备。它们不是插件：数据由一个宿主模块持有，适配器各自只管一种协议。
本配方用隔离 fixture 验证，绝不指向你自己的数据目录。

## 为什么在核心里

插件宿主在打包版里默认不启动进程（`server/index.ts` 的 `enableProcessRuntime` 只在
`EAC_PLUGIN_PROCESS=1` 时打开），而 `PluginRegistry.install` 会拒绝任何声明了 `scope.domains` 的权限。
健康与家居都要出网、都要"默认只有主人能读"，这两件事必须由宿主强制执行，所以它们是
`server/health/` 与 `server/home/` 两个域，厂商接入是它们下面的适配器。

## 边界

| 模块 | 只依赖 | 不依赖 |
| --- | --- | --- |
| `shared/health.ts`、`shared/home.ts` | zod | 任何实现 |
| `server/health/store.ts` | 契约、`node:sqlite` | HTTP、适配器、授权 |
| `server/health/importers/*` | 契约 | 存储、其他导入器 |
| `server/health/adapters/*` | 契约 | 存储、HTTP 路由、其他适配器 |
| `server/health/cloud-store.ts` | 契约 | 存储、HTTP |
| `server/health/sync.ts` | 契约、适配器、两个 store | HTTP 路由 |
| `server/health/audience.ts` | `server/audience.ts` | 存储、HTTP |
| `server/home/registry.ts` | 契约 | 存储、HTTP、策略 |
| `server/home/policy.ts` | 契约 | 存储、适配器 |
| `server/home/adapters/*` | 契约 | 存储、路由、其他适配器 |
| `server/*/host.ts` | 自己的子模块 | 另一个域 |

`server/health/` 不 import `server/home/`，反之亦然；两者的 `host.ts` 是唯一装配点。
云端适配器彼此不知道对方存在，加一个 provider 是 `adapters/` 下一个新文件加 `sync.ts` 里一个 case。

## 起一个隔离 fixture

```sh
TMP=$(mktemp -d)
EAC_DATA_DIR="$TMP/data" HOME="$TMP/home" USERPROFILE="$TMP/home" \
  EAC_PORT=19981 node --experimental-strip-types server/index.ts
```

`EAC_DATA_DIR` 与 `HOME` 都指向临时目录，所以不碰 `~/.eacbot`。

## 健康：写入、读回、去重、导入

```sh
B=http://127.0.0.1:19981

# 一条手工读数
curl -s -X POST "$B/api/health/records" -H 'content-type: application/json' \
  -d '{"metric":"weight_kg","value":72.4}'

# 概览：摘要、序列、来源
curl -s "$B/api/health/overview?days=30"
```

期望：`added: 1`，概览里 `summaries` 含 `weight_kg`，`sources` 含 `manual`。

同一个 `(sourceId, metric, at, endedAt)` 再写一次是**替换**，不是新增：

```sh
curl -s -X POST "$B/api/health/import" -H 'content-type: application/json' \
  -d "{\"path\":\"$TMP/health.csv\"}"
# 第二次同一文件：added 0，replaced 3
```

CSV 里一行坏数据只跳过那一行，并按行号报出原因：

```csv
metric,value,at
steps,9000,2026-11-10T08:00:00Z
steps,bad,2026-11-12T08:00:00Z
```

期望 `problems: [{"row": 3, "reason": "value \"bad\" is not a number"}]`，前一行仍然导入。

支持三种格式：`csv`（`metric,value,at[,unit,endedAt,note]`，列序任意）、`json`（数组或
`{samples: [...]}`）、`apple-health`（`export.xml`，按 `<Record>` 扫描而非解析整个文档）。

## 家居：快照、控制、确认、审计

`config.json` 里给一个适配器：

```json
{ "home": { "adapters": [{ "kind": "home-assistant",
  "baseUrl": "http://127.0.0.1:19991", "token": "<long-lived token>", "label": "测试家" }],
  "botAccess": "control" } }
```

```sh
curl -s "$B/api/home"                                  # 适配器、区域、实体
curl -s -X POST "$B/api/home/commands" -H 'content-type: application/json' \
  -d '{"entityId":"home-assistant:light.kitchen","action":"turn_on"}'
curl -s "$B/api/home/history?limit=5"                  # 审计
```

期望：

- 快照里锁只列出其状态允许的方向（`locked` 只给 `unlock`），传感器没有任何指令。
- `turn_on` 回执 `succeeded`，`observed` 是**回读**的状态，不是请求里的值。
- 门锁的 `unlock` 第一次返回 `409 sensitive_requires_confirmation`，带 `confirm: true` 才执行。
- 审计落在 `<dataDir>/home-audit.jsonl`，每行一个 JSON 对象，`actor` 是 `person` 或 `bot:<id>`。
- 适配器挂掉时 `status: "unreachable"`，其余适配器照常工作，快照不失败。

## 云端健康：OAuth、同步、断开

云端源和文件导入走同一张 `health_samples` 表，只是行来自一个 OAuth 应用而不是一个文件。
先在 `config.json` 里登记一个 provider 应用（token 永远不进 config）：

```json
{ "health": { "sources": [{ "sourceId": "withings", "kind": "cloud", "provider": "withings",
  "app": { "clientId": "<app id>", "clientSecret": "<secret, 可省>" } }] } }
```

```sh
curl -s "$B/api/health/cloud"                                  # 哪些 provider 可读、哪些源已登录
curl -s -X POST "$B/api/health/cloud/connect" -H 'content-type: application/json' \
  -d '{"sourceId":"withings"}'                                 # 返回 authorizationUrl
# 在浏览器里打开它，授权后 provider 会把浏览器送回 127.0.0.1 上的回调
curl -s "$B/api/health/cloud/status?sourceId=withings"
curl -s -X POST "$B/api/health/cloud/sync" -H 'content-type: application/json' -d '{"sourceId":"withings"}'
curl -s -X DELETE "$B/api/health/cloud" -H 'content-type: application/json' -d '{"sourceId":"withings"}'
```

期望：

- `connect` 返回 `phase: "waiting"` 和一个 `authorizationUrl`，其中带 `code_challenge_method=S256`。
- 回调落在 `127.0.0.1:<派生端口>` 上由 `HealthOAuthManager` 临时开的监听器里；state 不匹配时**不消耗**这次登录。
  这个回调地址由 `server/health/adapters/oauth.ts` 里的常量拼出，不经过主路由表。
- 第一次 `sync` 写入行（`added > 0`），同一窗口再同步是 `replaced` 而不是 `added`：身份键仍是
  `(sourceId, metric, at, endedAt)`。
- 令牌存在 `<dataDir>/health-cloud.json`（0600），config.json 里只有 client id 和 secret。
- 刷新令牌只发给配置里那个 app；`refresh` 失败时源被标成 `expired`，不写半批数据。
- `DELETE` 一次清掉这个源的所有读数并删除登录。

只有 `withings` 和 `oura` 有读取器；`polar`、`fitbit` 能走完 OAuth 但 `sync` 会明确拒绝，不会假装成功。

## 家居：Matter 直连

Matter 走 `@matter/main`（Apache-2.0），控制器是宿主进程里的一个 ServerNode，fabric 存在 `<dataDir>/matter`。

```json
{ "home": { "adapters": [{ "kind": "matter", "label": "家里" }] } }
```

```sh
curl -s "$B/api/home"                                          # 适配器状态（ready 表示控制器在线）
curl -s -X POST "$B/api/home/pair" -H 'content-type: application/json' \
  -d '{"code":"3497-011-2332"}'                                # 配对码，或 {"passcode":20202021,"discriminator":3840}
```

期望：

- 配对成功后设备端点出现在 `/api/home` 的 `entities` 里，`entityId` 形如 `matter:<nodeId>:<endpointId>`。
- 灯有 `turn_on`/`turn_off`/`toggle`；门锁只给与其当前状态相反的那一个方向；传感器没有任何指令。
- 控制回执 `succeeded` 且 `observed` 是**回读**的：回执里的状态来自一次 CASE 读，不是订阅缓存，
  所以命令刚发完读到的是设备真正持有的值。
- 没有可配对设备时，配对请求在超时后返回 `pairing_failed` 并说明原因，不会挂住。
- 配对码格式不对时立即返回 400，不发起搜索。

Matter 的 UDP 端口在真机上用系统分配；两个节点共用一个模拟网络时各自要不同的端口，fixture 才需要。

## 回执的三种状态

| 状态 | 含义 | 后果 |
| --- | --- | --- |
| `succeeded` | 服务调用返回成功，且已回读状态 | 可以报告已生效 |
| `failed` | 服务明确拒绝（401/404/400） | 报告失败，不重试 |
| `indeterminate` | 超时、连接断开、5xx | **可能已生效**；不重试、不报告成功，先读回状态 |

## 检查

```sh
pnpm exec vitest run server/health server/home src/lib/health-view.test.ts
pnpm typecheck
```

## 未实现（如实）

- 云端读取器只有 Withings 与 Oura。Polar 与 Fitbit 的 OAuth 能走完，但没有读取器，`sync` 会拒绝。
- 手机中转（HealthKit / Health Connect）：小米运动健康与 Apple Health 的自动同步需要原生客户端，
  目前只能导入导出文件。
- 其他家居适配器（美的局域网、涂鸦）：`homeConfigSchema` 接受 `home-assistant` 与 `matter`。
- Home Assistant 的 WebSocket 实时订阅：现在按需轮询。
- Matter 只映射到本域有的能力：一台设备的自定义 cluster、场景、固件升级都不在能力表内。
- Matter 的 attestation 在缺少 DCL 证书服务时按 matter.js 的兼容模式放行（日志里有 WARN），
  这不是生产级的设备认证。
