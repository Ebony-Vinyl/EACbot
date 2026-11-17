# Herdr 参考图布局

本次改动影响范围是前端 Herdr 工作页、对话呈现和终端字号控制模块。

按用户提供的两张 Alma 截图调整：Herdr 模式收起外层工作空间导航，使用 260px 会话栏、EACbot / Herdr 切换、项目面包屑、紧凑的对话 / 终端切换、折叠工具步骤和固定底部输入框。Markdown 表格沿用现有安全渲染组件。会话搜索、折叠侧栏、设置入口和字号按钮实际可操作；切换视图不会重新启动会话，也保留未发送文字。

参考图中的附件上传与手机连接不在已有 Herdr 接口能力内，本次没有增加不可用的按钮。没有修改 Agent 启动、认证、恢复或消息协议。

## 验证

- `pnpm exec vitest run src/next/workbench/HerdrPage.test.ts src/next/workbench/TerminalSurface.test.ts src/components/shell/NeutralWorkspace.test.ts`：14 项通过。
- `pnpm exec tsc -b`：通过。
- 变更源码 oxlint、`git diff --check`：通过。
- 独立 Electron profile 与临时 core 数据目录，使用合成会话/消息渲染真实 App。检查外层导航和工作空间标题未重复出现、侧栏为 260px、5 条工具步骤和 Markdown 表格可见。
- 1260px 桌面与 390px 手机布局无页面横向溢出；分别截图检查浅色与深色。样例内容不来自用户会话，未发送真实 Agent 任务。

[桌面浅色](evidence/herdr-design/desktop-chat.png) · [桌面深色](evidence/herdr-design/desktop-dark.png) · [手机宽度](evidence/herdr-design/mobile-chat.png)

## 终端黑屏修正

xterm 的颜色解析器拒绝 `transparent` 并回退为黑色背景；改用显式
`#00000000`。Herdr 终端标题栏现在展示真实连接、重连、失败与退出状态，
仅在连接存活时允许接管，仅在失败或重连时允许重试。

隔离 Electron 渲染真实 TerminalSurface 并输入合成字节，确认背景计算值为
`rgba(0, 0, 0, 0)`，终端显示 `Codex terminal fixture: readable output`。
[浅色终端截图](evidence/herdr-design/terminal-light.png)。
TerminalSurface 与 HerdrPage 的 11 项测试通过，包含连接失败信息展示。
此验证不代表已结束的用户原生终端已恢复。

## 工具步骤展开过渡

工具步骤组与单条步骤保留原生 details，默认收起；高度、透明度与箭头使用
180ms ease-out CSS transition。键盘 focus-visible 与 prefers-reduced-motion
下立即切换。不增加动画库或展开状态管理。

隔离 Electron 检查双向过渡：关闭高度 30px，展开中约 199px，展开完成 224px；
收起中约 56px，结束回到 30px。展开中再次收起能正确反向并回到关闭状态。
`git diff --check` 通过。

## Codex 风格工具操作列表

采用无边框的紧凑操作行、左侧细线与读文件/搜索/命令图标，摘要优先展示
原生参数中的文件路径、搜索词或实际命令。未知工具保留原生名称，不猜执行结果。
默认收起和 180ms 双向过渡保留，点击每行可查看输入及结果。

原生调用和结果按 call_id 配对，一次调用只计一步；未匹配结果保留为明确的工具输出，
不按相邻顺序强行归并。4 项记录测试通过，包含乱序返回；core/前端类型检查、
相关源码 lint 与 diff 检查通过。隔离 Electron 确认默认关闭和三种摘要行，
[操作列表截图](evidence/herdr-design/tool-timeline.png)。

## 图片工具分类与终端输入

- 识别外层 exec 脚本里的 tools.view_image 调用，使用图片图标与“查看图片”摘要。
  文案不宣称成功，失败输出仍保留；含不同工具调用的脚本不归为纯图片调用。
- Herdr 页面打开终端时申请控制，依旧以服务端 canControl 授权为准；其他工作台
  的观察模式默认值不变。释放控制不会被重新自动申请。
- TerminalSurface 从不可输入变为可输入时重新 fit 并聚焦，尺寸同步不再被初始
  观察状态阻断。实际桌面的原生 Codex 输入区已位于终端底部。
- 44 项相关测试、前端类型检查、源码 lint、diff 检查通过。
- 隔离 Electron 真实 xterm 验证：观察状态不发送按键，获准后自动聚焦，字符 x
  到达连接；800×600 区域同步为 100×35。实际用户终端未发送测试字符或消息。
