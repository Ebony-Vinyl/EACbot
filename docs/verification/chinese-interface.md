# 产品界面中文化

本次改动影响范围是桌面语言包、工作台与健康页面展示模块。

补齐原有中文目录缺失的 2386 项文案，并将工作台静态标签、辅助提示和拼接句子接入现有翻译系统。当前中英文目录各 10379 项，中文无缺失键。品牌、模型标识、路径、命令、协议状态与用户内容保留原值。状态标签在读取时翻译，避免切换语言后保留启动时的英文。

## 验证

- `pnpm i18n:check`：通过，中文覆盖 10379/10379，占位符与源文哈希有效。
- `pnpm exec vitest run src/next/workbench src/next/personal/feed.test.ts src/components/shell/NeutralWorkspace.test.ts src/lib/health-view.test.ts`：219 项通过。
- `pnpm typecheck`：前后端类型检查通过。
- 定向 `oxlint --deny-warnings` 与 `git diff --check`：通过。
- 隔离 Electron 使用合成数据及临时用户目录，确认健康页中文显示，输入“步数”仍发送 `metric: steps`，未向真实用户数据写入。

[中文健康页面](evidence/monochrome-workspace/health-chinese.png)。目录完整不等于逐个运行场景均验收；没有逐一调用所有服务商、运行全仓测试或正式打包。第三方返回的原始错误、命令输出及用户数据不做机器替换。
