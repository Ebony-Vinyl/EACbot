# 15 控制门禁：EAC_CONTROL_* 缺失时的人机互斥

对照日期：2026-11-14
仓库：D:\workspace\EACbot-clean-core，分支 codex/clean-core，基线提交 7dcddc1
对应审计：04-cloud.md 的 C44（control-client 未配置即 DISENGAGED）与 L09（mcp-bridge 没有 gate 就不拦截）

## 结论

**改了代码。** 范围为三座“由服务端挂载、可能同时被人和 AI 操作”的电脑桥：本机、Local VM、VPS。
缺 `EAC_CONTROL_URL`/`EAC_CONTROL_TOKEN` 时，这三座桥的 `tools/call` 一律拒绝并给出明确文案，
而不是静默放行；`initialize`、`tools/list`、`ping` 与通知照常，便于 bot 发现并解释问题。

**本地单机的默认语义没有变。** `createControlClient()` 在未传 `required` 时仍然返回 DISENGAGED；
只有明确知道“这台电脑被服务端挂载给回合使用”的桥才声明 `required: true`。

**没有改的部分：** Cloud 电脑（Boat）的门禁在服务端进程内，不读 `EAC_CONTROL_*`；
共享/借出电脑走另一套 40 秒屏幕租约；浏览器门禁（ProfileControl）是第三套机制。

## 1. 先厘清：这里的“控制面”不是厂商云

`server/index.ts:2490` 的 `controlIntegration()` 现签一个本机地址：

```
http://127.0.0.1:${PORT}/api/internal/computer-control?botId=...
```

外加一个 capability token（除 “this computer” 外按回合签发）。桥子进程拿到的 `EAC_CONTROL_*`，
就是这对“地址 + 本轮凭证”。门禁服务端读的是进程内的 `ComputerControl`（`server/computer-control.ts`），
入口在 `server/index.ts:14605` 附近。

所以：**EAC_CONTROL_* 只是把服务端自己的门禁传给子进程的管道，不是外部依赖，也不是云服务。**
“有服务端挂载电脑”就一定有这对值；“没有值”意味着这次启动不是服务端发起的（手启、旧启动器、或将来漏传）。

## 2. control-client 的完整状态机

实现在 `server/control-client.ts`，可以按四步读完：

1. **构造。** `url = options.url ?? EAC_CONTROL_URL ?? ""`，token 同理；
   `configured = Boolean(url && token)`——两者都非空才算配置，只给一个等于没配。
2. **未配置。** `state()` 不发任何网络请求，直接返回 `DISENGAGED = { held:false, helpOpen:false }`。
   现在多了一个分支：若构造时传了 `required: true`，返回的是 `MISSING = { held:true, blockedReason:CONTROL_PLANE_MISSING }`。
3. **已配置。** `state(fresh, call)`：
   - `fresh` 为真，或带了 `call`（要告诉门禁“这次调用会打开什么应用/站点”），就绕过 750ms 缓存；
   - 带 `call` 时把 app/site 拼进查询串，让门禁能在第一次询问时用大白话问人。
4. **读答案。**
   - HTTP 非 2xx、JSON 解析失败、`held`/`helpOpen` 不是布尔 → `UNCONFIRMED`（`held:true`）；
   - 网络错误、超时（45 秒等待 + 10 秒余量）→ `UNCONFIRMED`；
   - 正常 → `held`/`helpOpen` 照抄；只有 `reason === "person"` 才标记“人持有”；
     `blockedReason` 必须是非空字符串才用作拒绝文案。

桥这一侧（`server/mcp-bridge.ts`）的拦截器只检查 `tools/call`：

- `held` 为真 → 用 `controlRefusal(state)` 拒绝，结果里带 `isError: true`；
- 没被持有，但这一帧从到达至放行已超过 `CONTROL_ACT_WITHIN_MS`（5 秒）→ 回 `CONTROL_WAITED`，要求重新截图再来；
- 其他帧（`initialize`、`tools/list`、通知、非 JSON）直接转发；`ping` 由桥本地回答。
- 拦截器串行化，保证异步检查不会打乱 MCP 协议流。

失败的语义要分清：`CONTROL_UNCONFIRMED` 是“暂时无法确认”，可以几秒后重试；
新增的 `CONTROL_PLANE_MISSING` 是“这台电脑根本没有门禁”，重试无意义，且不能换一个工具去操作同一台电脑。

## 3. 哪些模式真的需要控制面

| 模式 | 谁启动桥 | 控制面从哪来 | 缺 EAC_CONTROL_* 时的旧行为 | 需要门禁 |
| --- | --- | --- | --- | --- |
| 本机“这台电脑” | 服务端 → `local-computer-proxy` | `gatedLocalComputer()` 写入服务端现签的 pair（`server/local-computer.ts:29`） | 代理启动即 `exit 2`，根本起不来（`server/local-computer-proxy.ts:18-31`） | 是，已经在启动层 fail-closed |
| Local VM（本机容器） | 服务端 → `container-mcp` | `containerComputerMcp()` 写入 pair（`server/container-computer.ts:1166`） | **静默无门禁，直接转发** | 是 |
| VPS 容器 | 服务端 → `vps-container-mcp` | `mountBotVps()` 把 pair 合进 env（`server/index.ts:5865`、`server/vps-computer.ts:1251`） | **静默无门禁，直接转发** | 是 |
| Cloud 电脑（Boat） | 服务端 → `harness-mcp-proxy computer` | 服务端进程内 `computerCallGate()`（`server/index.ts:5701`），不读环境变量 | 不受影响 | 是，已由进程内门禁覆盖 |
| 共享 / 借出电脑 | 桌面 app ↔ `shared-computers` | session + 每电脑 secret，40 秒屏幕租约（`server/shared-computer-control.ts`） | 不受影响 | 另一套机制，不在本项范围 |
| 纯本地单机、不挂电脑 | 无 | 无 | 不构造 client | 不需要，保持 DISENGAGED |

逐条说明为什么这样判：

- **本机。** 连接描述只由 Electron 交给它启动的那一个服务端（见 `docs/computer-use-integration.md`），
  代理本身又校验 URL 必须是 loopback、token 必须非空。它早就是 fail-closed，只有“启动失败”这一种结果。
- **Local VM 与 VPS。** 两者都是“一个人可以看着/直接操作，另一个 AI 也在操作”的共享桌面：
  人可以通过预览或 VNC 接管，bot 则通过 MCP 点击。旧代码把 gate 写成了可选：
  `...(controlUrl && controlToken ? { gate: ... } : {})`，缺任意一个就完全不过滤，这正是 L09 的 fail-open。
- **Cloud 电脑。** 工具经由 harness 代理回到服务端，由 `computerCallGate()` 在内存里判断；
  即使没有 `EAC_CONTROL_*`，这条路径仍然有门禁。把它改成读环境变量反而会削弱现有保证。

## 4. 为什么可以安全 fail-closed，而本地单机不受影响

关键点：**不存在“合法的本地单机、挂载了电脑、却没有 pair”这条路径。**

- 想挂载本机，必须由 Electron 把连接描述交给服务端；服务端用 `controlIntegration()` 现签 pair。
- 想挂载 Local VM 或 VPS，必须由服务端调用 `containerComputerMcp()` / `mountBotVps()`；两者都写 pair。
- 不挂载电脑的纯本地单机，根本不会创建这三个桥，也就没有“缺 pair”的问题；`createControlClient` 的默认值仍是 DISENGAGED。

因此，缺 pair 只可能来自“不是服务端启动的桥”：手写命令调试、旧启动器、或将来某个调用点漏传。
这时拒绝一次调用，比让人和 AI 同时改同一块屏幕安全；而且拒绝文案会要求 bot 告诉人重启或修配置。

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `server/control-client.ts:33` | 新增 `CONTROL_PLANE_MISSING` 文案：说明没有门禁、本次未执行、不要重试、不要换工具绕开、请人重启或修配置 |
| `server/control-client.ts:55,66,109` | 新增 `MISSING` 状态与 `required` 选项；未配置且 required 时返回 held 而不是 DISENGAGED |
| `server/mcp-bridge.ts:117` | `BridgeOptions.gate` 从可选改为必填，并增加 `required?: boolean`；通用桥不再存在“没有 gate”的分支 |
| `server/mcp-bridge.ts:335-341,377` | 总是创建 control client；required 且未配置时向 stderr 打一行告警；总是把 gate 挂到拦截器上 |
| `server/container-mcp.ts:27` | Local VM 桥固定 `required: true`，缺 pair 时每次电脑调用被拒 |
| `server/vps-container-mcp.ts:32` | VPS 桥固定 `required: true` |
| `server/local-computer-proxy.ts:40` | 显式写 `required: true`（启动校验已经拒绝缺 pair，这里是契约声明） |
| `server/container-computer.ts:1166` | `containerComputerMcp()` 的 control 参数从可选改为必填，env 里总是带 pair，避免将来漏传 |
| `server/saved-steps/computer-client.ts:14` | 把新文案算作门禁拒绝，回放不会把它当成可重试的普通错误 |

新文案（给 bot 看，bot 再翻译给用户）：

> EACbot could not check who is using this computer because this computer has no control gate configured, so a person
> and an AI could act on the same screen at once. This call was NOT performed... Do not retry it and do not reach the
> same computer through another tool. Tell the person in plain words that this computer is missing its control gate and
> that EACbot has to be restarted, or its configuration fixed, before it can use it.

## 6. 备选方案与取舍

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 只写文档 | 承认 fail-open 是技术限制，不改代码 | 零行为变化、零回归风险 | 审计指出的静默放行仍在；任何手启或未来漏传都无人察觉 | 不采用 |
| B. 启动即退出 | 像 `local-computer-proxy` 一样，缺 pair 直接 `exit 2` | 最严格，绝不会出现无门禁进程 | 引擎只看到 MCP server 死掉，错误不透明；连 `tools/list` 都没有；调试和排障更难 | 不采用 |
| C. 全局默认 fail-closed | 把 `createControlClient` 的未配置分支直接改成拒绝 | 改动最小 | 违反“本地单机无控制面是正常的”，所有未来的本地用途都会被误伤；没有区分模式 | 不采用 |
| **D. 按模式声明 required（采用）** | 客户端加 `required` 选项；三座桥显式声明；缺 pair 时按调用拒绝并给文案 | 区分了模式；本地单机默认不变；错误可读，bot 能解释；`tools/list` 仍可用 | 多一个选项和一处约定；手启桥会被拒（这是期望） | **采用** |
| E. 加逃生开关 | 例如 `EAC_CONTROL_OPTIONAL=1` 允许无门禁运行 | 兼容手启调试 | 等于把 fail-closed 又变成可关，容易被误设，回到原点 | 不采用 |

方案 D 还配了一层编译期约束：`containerComputerMcp()` 的 control 参数改为必填，
以后任何新的 Local VM 挂载点如果忘了传 pair，`pnpm typecheck` 会直接报错。VPS 的 pair 目前由
`mountBotVps()` 在调用处合并；运行时的 required 仍然会兜底，后续可以再把它收进构造器。

## 7. 验证

环境：Windows，Node 24，pnpm 10.33。命令都在仓库根目录执行。

1. `pnpm typecheck` → 退出码 0（改动前后各一次；第二次包含构造器签名收紧）。
2. 聚焦测试：

```
pnpm exec vitest run server/control-client.test.ts server/mcp-bridge.test.ts \
  server/saved-steps/computer-client.test.ts server/container-mcp.test.ts server/vps-container-mcp.test.ts
```

结果：3 个文件通过、2 个跳过；84 passed、8 skipped。
跳过的是 `container-mcp.test.ts` 与 `vps-container-mcp.test.ts`——它们用 POSIX shell 造假 docker，
文件本身按 `process.platform === "win32"` 跳过；新增的拒绝用例会在 Linux CI 上执行。

3. 相邻路径：

```
pnpm exec vitest run server/local-computer-proxy.test.ts server/local-computer.test.ts \
  server/container-computer.test.ts server/saved-steps/replay.test.ts
```

结果：4 个文件通过；134 passed、1 skipped。

4. VPS 构造器：`pnpm exec vitest run server/vps-computer.test.ts` → 52 passed、2 skipped。
5. 收紧构造器后的复跑：

```
pnpm exec vitest run server/container-computer.test.ts server/control-client.test.ts \
  server/mcp-bridge.test.ts server/saved-steps/computer-client.test.ts
```

结果：4 个文件通过；173 passed。

6. 全部相关文件合并复跑（最终一次）：

```
pnpm exec vitest run server/control-client.test.ts server/mcp-bridge.test.ts \
  server/saved-steps/computer-client.test.ts server/container-computer.test.ts \
  server/local-computer-proxy.test.ts server/local-computer.test.ts \
  server/saved-steps/replay.test.ts server/container-mcp.test.ts server/vps-container-mcp.test.ts
```

结果：7 个文件通过、2 个跳过；218 passed、9 skipped。`pnpm lint` 同时通过。

7. Windows 上的真实桥冒烟（临时脚本，未入库）：用 `runMcpBridge` 直接起一个回显子进程，
   `gate: { url: "", token: "", required: true }`，输入 `tools/list` 与 `tools/call`。观察到的输出：
   - stderr：`Smoke: no control gate configured for this computer; every computer call will be refused until it`；
   - `tools/call` 收到 `isError: true` 和上面的完整文案；
   - `tools/list` 仍被转发给子进程并回显。

没有跑全量 `pnpm test`（包含 Electron、打包 server 等，耗时远超本次范围）；也没有真实 VPS/Cloud 实机验证。

## 8. 影响面与残余风险

- **行为变化只发生在“桥不是服务端启动”的场合。** 正常安装、正常挂载的路径全部由服务端现签 pair，行为不变。
- **手启调试会从“能用”变成“每次调用被拒”。** 这是有意为之：日志里有一行 `no control gate configured`，
  文案也明确要求不要绕路；调试时应通过服务端挂载，或显式提供一对 loopback 门禁地址和 token。
- **`tools/list` 仍会列出电脑工具。** bot 能看到工具但每次调用被拒，这是为了让它能向人解释；
  如果更希望“看不到工具”，可以改为启动即退出（方案 B），但错误会更难懂。
- **告警只在 stderr。** 目前不会在设置页显示“电脑门禁未配置”。后续可加一个状态卡，把这类启动错误暴露给人。
- **故障表现从“静默并发”变成“电脑不可用”。** 如果将来 `controlIntegration()` 被改坏、返回空 URL，
  现在会在桥里被拒。这是期望的安全方向，但发布说明应告知：电脑不可用时先看引擎日志里的门禁告警。
- **没有覆盖 Cloud Boat 与共享电脑。** 它们各自有进程内门禁/租约，和本项不是同一条代码路径；
  如果以后有人把 Boat 改成走外部桥，需要重新评估。

## 9. 与 04-cloud 的关系

04-cloud 的 C44 与 L09 描述都成立：未配置时 `configured=false` 且返回 DISENGAGED，不发请求；
没有 gate 就不拦截电脑调用。本文档记录的是“只在确实需要控制面的模式改为 fail-closed”的落地，
04 的表格保留为审计当时的快照，不回溯改写。
