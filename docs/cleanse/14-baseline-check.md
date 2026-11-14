# 14 基线对照：server/index.test.ts 的两处失败

对照时间：2026-11-14
主仓库：D:\workspace\EACbot-clean-core，分支 codex/clean-core
基线 worktree：D:\workspace\eacbot-baseline-check，detached HEAD 781c57e

## 方法

在当前分支跑 pnpm exec vitest run server/index.test.ts，得到 319 passed / 2 failed / 6 skipped，耗时 398.5 秒。
随后在基线 worktree（781c57e）用测试名过滤跑同一批用例：pnpm exec vitest run server/index.test.ts -t "setup answers"，16.6 秒完成。
过滤只跳过不匹配的用例，被比较的两条用例在两个提交上都会执行。

## 结果

| 提交 | 总数 | 通过 | 失败 | 跳过 | 失败用例 |
|---|---|---|---|---|---|
| e6f4fd6（当前分支） | 327 | 319 | 2 | 6 | writes a new bot's setup answers ... （两条） |
| 781c57e（基线） | 327 | 0 | 2 | 325 | 同名两条，断言输出逐字相同 |

失败内容：期望招聘相关选项（Screen my new candidates、Draft a job post、Schedule my interviews、Find candidates on job sites、Remind me to follow up），实际得到通用选项（Research and digging into topics、Keeping an eye on things for me、Email, calendar and messages、Bookings, shopping and errands、Data, spreadsheets and reports）。

## 结论

这两处失败在基线 781c57e 上同样存在，内容一致，**不是本次 8 个提交引入的**。它们与欢迎语选项的生成逻辑有关，本次改动没有触碰该逻辑。

## 限制

基线对照只覆盖了这两条用例，不代表 server/index.test.ts 其余 319 条都已在基线上逐一比对；当前分支的 319 条通过结果是直接的。
