## 背景

自托管部署里有三类行为由写死的默认值决定，用户既看不到也改不了：启动后主动向固定外部地址发请求；七项容量上限写死在代码里；本机浏览器第一次打开界面会被要求登录，尽管服务只监听 127.0.0.1。此外前端有三处在没有后端依据的情况下拦住用户，另有一个默认开启的使用统计上报。

这个 PR 把这些改成默认不打扰、需要时显式开启，不删除任何功能。

## 改动

外连默认关闭（b5ca7fd）
- 更新检查不再写死 api.github.com/repos/milind-soni/EACbot，改由 EAC_UPDATE_CHECK_URL 指定；未配置、地址非法或带凭据时不发请求，返回 checked: false。
- @devs 问题上报不再回退到 cloud.eacbot.com，只认 EAC_BUG_REPORT_URL。
- 公告源在 EAC_ANNOUNCEMENTS_URL 为空时不轮询、不建定时器。

配额可配置（7cac874）
config.json 新增 limits 段，七项上限保留原值作为默认：每 workspace 100 个 bot、每 bot 16 个并发线程、附件 512MB、每天 50 张图、单次请求 128 个工具、20 个 MCP server、房间每回合 3 条发言。未配置时行为与改动前完全相同。

本机同源免登录（201a728、b04970d）
loopback 请求只有在同时满足四个条件时才以本地 owner 身份放行：没有 X-Forwarded-* / Forwarded / X-Real-IP 任一头（哪怕值为空）、TCP 对端是回环地址、Host 是回环、Origin 证明来自本服务同源页面。跨站、其他端口、file://、Origin: null、地址栏导航、非回环 peer 一律继续拒绝。

前端（ee8a553、b64165d、e8bb257、0cc0837）
- 首次运行不再强制创建 Chief，可稍后设置，且不会把跳过误记成已见过 Chief。
- 桌面端恢复 Settings 里的 People 与 Activity，People 限 owner/admin 且非 Cloud home。
- 使用统计改为默认关闭，需要显式 opt-in；关闭时不加载 posthog、不发请求、不排队。
- 未配置更新源时显示未检查更新，不再显示已是最新。

文档（a412d99）
docs/self-hosting.md 补上三个变量默认关闭与启用方式，并按新的同源信任边界更新安全说明。

## 验证

- pnpm typecheck（tsc -b && tsc -p tsconfig.server.json）：退出码 0。
- 外连三处：未配置时把全局 fetch 换成记录器，off.calls 为空；显式配置后三条路径均恢复。
- 配额：不配置时七项断言等于原值；配置后可放大；非法值被拒；saveConfig 到 loadConfig 往返立即生效。
- 鉴权：request-auth.test.ts 与 request-auth.e2e.test.ts 共 71 条通过，覆盖空代理头、仅 X-Real-IP、非回环 peer 配伪造 Host、正常同源放行四种场景。
- 前端：onboarding、SettingsModal、analytics、usage-snapshot、server-update 相关测试通过。
- 尚未覆盖：没有做完整 Electron 人工走查；server/index.test.ts 有两处欢迎语选项失败，正在用基线对照确认是否为既有问题。

## 兼容性

- 所有新增配置项都有原值作为默认，升级后行为不变。
- 三项外连关闭后，需要这些能力的部署显式设置对应环境变量即可恢复。
- 未改动 enterprise/、许可校验与任何 entitlement 判断。

## 没有做的事

- 没有删除或绕过 enterprise/ 与 EAC_LICENSE_KEY 的功能授权。
- 没有改动模型 provider 白名单（自建环境本来就没有全局白名单）。
- 没有改地区限制（代码里没有按国家或地区拦截功能的逻辑）。
