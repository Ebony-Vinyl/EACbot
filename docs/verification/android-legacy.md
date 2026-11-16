# Android 连接已有 EACbot 后端

## 范围与设计决定

本次改动影响范围是 Android 旧后端连接、会话存储与任务聊天输入模块。
用户选择接入旧开发后端和已有机器人。Android 直接适配现有设备配对、机器人、线程消息接口，保留任务中心入口。未把旧聊天转换为 core mission，也未修改后端路由或迁移原有数据。

按本机单用户交互使用设计。登录凭据沿用加密 SessionStore，旧后端使用独立存储名称。只在页面前台每两秒读取列表或当前线程最近 100 条消息；进入后台停止轮询。发送固定 threadId，失败重试沿用同一 sendId。认证 401 清除该后端登录，网络断线保留历史并显示重试提示。

## 实际验收

2026-11-16，Android 15 模拟器 EACbot_QA_API35，通过 Mobile MCP 操作 APK。
按用户明确要求连接本机真实开发后端，开发服务使用原有 ~/.eacbot 配置。此次真实调用是隔离 fake 验证之外的明确授权验收。

- 启动 `node --experimental-strip-types server/dev-server.ts`，地址 `http://127.0.0.1:8799`。
- `adb reverse tcp:8799 tcp:8799` 将模拟器回环地址转发到开发后端。
- 使用一次性设备配对码登录，读取已有 EACbot 机器人。
- 为该机器人新建 Android 验收会话，使用其原有 glm-5.3-flash 模型配置。
- APK 第一轮发送要求回复 `ANDROID_REAL_OK_1`，收到对应真实回复。
- 第一轮结束后继续发送，收到 `ANDROID_REAL_OK_2`。
- 强制结束并重启 APK 后无需重新配对，重新打开机器人可恢复两轮真实回复。
- 任务中心 Done 状态的输入框与发送按钮在原生控件树中均为 disabled。
- 移除模拟器端口转发出现连接错误，恢复转发后自动读回机器人列表。

构建命令（在 apps/android 中）

```sh
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
ANDROID_HOME=/Users/Zhuanz/Library/Android/sdk \
./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug
```

150 项 core 测试及 1 项 app 终态输入回归测试通过。

## 限制

这是调试签名 APK。已验收模拟器经 adb 转发连接本机开发服务；真实手机 Wi-Fi、公网 HTTPS 未验收。
旧后端入口目前覆盖机器人列表、当前会话最近 100 条消息和文本连续收发。附件、工具审批卡、历史分页与会话切换尚未适配，复杂卡片提示到桌面端查看。消息更新使用前台轮询，无后台推送。

开发后端仅监听本机回环地址，真机不能直接使用截图中的 127.0.0.1 地址。

最终 APK SHA-256

`d514f4a2e4e0de667d87eda84aaa0334d5dbbe073933bb656e3014a1cd273093`

APK 签名校验和 `git diff --check` 通过。截图保存在 [两轮收发](evidence/android-connection/real-backend-two-turns.png) 与 [终态输入](evidence/android-connection/completed-input-disabled.png)。
