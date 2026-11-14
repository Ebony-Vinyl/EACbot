# 后端隐患清理总览

日期：2026-11-14
仓库：D:\workspace\EACbot-clean-core
分支：codex/clean-core
基线：781c57e（origin/main 最新，无落后提交）

## 一、这次清理解决的隐患

1. 隐式外连：更新检查原本写死 api.github.com/repos/milind-soni/EACbot，问题上报会回退到 cloud.eacbot.com，公告源默认轮询。现在三者都默认关闭，分别由 EAC_UPDATE_CHECK_URL、EAC_BUG_REPORT_URL、EAC_ANNOUNCEMENTS_URL 显式开启。
2. 写死的配额：每 workspace 100 bot、每 bot 16 线程、附件 512MB、每天 50 张图、单次 128 工具、20 个 MCP server、房间每回合 3 条发言。现在都可在 config.json 的 limits 段调整，不配置时保持原值。
3. 过严的本机信任：本机浏览器打开界面必须登录，即使在只监听 127.0.0.1 的自托管实例上。现在本服务同源页面（含地址栏顶层导航）直接作为本地 owner；跨站、其他端口、file://、Origin: null、非回环 TCP 对端、任何代理头仍然拒绝。
4. MCP 凭据外泄：远程 MCP 允许 http:// 导致 Authorization 明文过网；stdio MCP 继承父进程 provider key；broker 探活失败后从宿主机带 header 直连。现在非回环强制 HTTPS，子进程启动前剥离凭据，带凭据的 server 在 broker 失败时不再直连。
5. webhook 注入：事件驱动的会话可以增删改 webhook 并自动生效；公网 http base 会把 secret 暴露在 URL 里；只读成员能读到事件体前 2000 字符。现在事件驱动会话对变更返回 403，公网强制 HTTPS，事件预览只给 owner/admin。
6. 技能自动生效：组织技能导入后会自动启用，托管端推送更新即可改变已装 bot 的 prompt。现在默认关闭，必须 owner 手动开启，且发布新版本保留用户原有开关状态。
7. 例行任务孤儿运行：删除或系统暂停 routine 后，正在运行和等待答复的 run 仍会继续用工具、发消息。现在会标记 cancelled 并中断对应 turn。
8. 过期译文：1187 条与英文源脱节的译文已删除，回落到英文，locale 校验恢复通过。
9. 界面上报：前端使用统计原本默认开启，会上报 edition、cloud plan、org_managed。现在默认关闭，需显式 opt-in。
10. Connected Apps 注册：Cloud home 启动即向厂商 broker 注册并长期重试。现在改为首次打开目录时触发，新增 EAC_CONNECTED_APPS_REGISTER 开关。
11. Local VM 固定密码：手动安装展示命令带 CHANGE_ME。现在改为占位符，空密码和固定密码会被拒绝。
12. 电脑桥门禁：Local VM 和 VPS 桥缺少 EAC_CONTROL_* 时静默放行，人和 AI 会同时操作同一台电脑。现在拒绝调用并给出明确原因，本地单机不挂电脑时不受影响。

## 二、验证结果

- pnpm typecheck：退出码 0。
- pnpm build：退出码 0，Vite 用时 21.5 秒。
- 服务启动：8899 端口隔离实例，日志确认 open-source edition、local requests: owner trust。
- 前端对接：用内置浏览器直接访问 http://127.0.0.1:8899，界面完整渲染（收件箱、任务中心、连接应用、欢迎流程、稍后设置），控制台错误数 0。
- 鉴权行为：同源页面 200 并返回 loopback/admin；跨站 Origin、仅 X-Real-IP、无 Origin 的地址栏外的请求全部拒绝。
- 各模块测试：外连三处、配额、鉴权、MCP、webhook、技能、例行任务均通过；发现的失败项都用基线 781c57e 对照确认是既有问题。

## 三、兼容性

- 所有新增配置都以原值作默认，不配置时行为与清理前一致。
- 前端没有改接口形状，历史源码构建出的界面可直接对接。
- enterprise/、EAC_LICENSE_KEY 与任何 entitlement 判断未改动。
- 未删除任何功能，只改变默认值与触发时机。

## 四、已知遗留

- server/index.test.ts 两处欢迎语选项失败、first-hour.e2e.test.ts 三处失败，均为基线既有问题。
- 09-blindspots 报告中仍有部分中低危项未处理，主要是需要产品决策的设计问题（如 webhook 变更审批、routine 授权双人确认）。
- 没有做 Electron 人工走查，也没有覆盖全部语言与全部平台的运行验证。

## 五、提交清单

详见 git log 781c57e..HEAD。审计与复核记录在 docs/cleanse/ 下。
