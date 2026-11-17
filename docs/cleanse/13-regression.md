# 13 全量回归报告（未完成，按已完成进度交卷）

- 仓库：`D:\workspace\EACbot-clean-core`
- 分支：`codex/clean-core`
- 范围：`781c57e..HEAD`，共 8 个提交
- 当前 HEAD：`521754b`
- 运行方式：`pnpm vitest run`（仓库默认 Windows 单 worker 串行）
- 结论状态：**全量未跑完，基线对照未执行，不能判定新增失败数为 0。** 截至中断时已完成 4 个测试文件，观察到 7 个失败。

## 当前进度

全量运行按顺序完成了以下 4 个文件，之后仍在继续运行，因时间到被中断：

| 已完成文件 | 总数 | 通过 | 失败 | 跳过 | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `server/index.test.ts` | 327 | 319 | 2 | 6 | 413290ms |
| `server/drivers/codex.test.ts` | 268 | 264 | 3 | 1 | 266497ms |
| `server/routines.test.ts` | 199 | 198 | 1 | 0 | 6957ms |
| `server/config.test.ts` | 215 | 212 | 1 | 2 | 832ms |
| **已完成部分合计** | **1009** | **993** | **7** | **9** | — |

说明：这里的“通过”由“总数 − 失败 − 跳过”计算，尚未取得 Vitest 最终汇总行。全仓库尚未跑完，因此这不是全量总数。按仓库 `scripts/testing/vitest-shard-weights.json` 的 Windows 权重，全套串行约需 114 分钟，本次只完成了前四个文件。

## 失败清单

| 失败文件 / 用例 | 基线是否同样失败 | 是否本次引入 | 证据与判断 |
| --- | --- | --- | --- |
| `server/index.test.ts` — `writes a new bot's setup answers with its own engine on Haiku 5.5 without thinking, and keeps the fixed ones when that fails` | 未执行 | 未确认 | 当前分支实测失败，483ms。该用例覆盖 bot 创建、`/api/config` 与 setup 建议；本次改了 `server/config.ts`、`routes/bots-create.ts`、`routes/bot-patch.ts`，存在相关性，必须优先做基线对照。 |
| `server/index.test.ts` — `writes a new bot's setup answers again when it is renamed before anyone answers, and without the name for a picked one` | 未执行 | 未确认 | 当前分支实测失败，1320ms。同样经过 bot 创建/改名和 setup 建议路径，与本次 config、bots-create、bot-patch 改动可能有交集。 |
| `server/drivers/codex.test.ts` — `keeps a person's shell filters and adds the gate pattern as an exclude filter` | 未执行 | 未确认 | 当前分支实测失败，833ms。本次提交没有改 `server/drivers/`，但没有基线结果，不能据此排除环境或偶发因素。 |
| `server/drivers/codex.test.ts` — `keeps every variable an MCP mount writes out of the shell, and only those` | 未执行 | 未确认 | 当前分支实测失败，879ms。该文件同时报告了测试临时目录清理 `EPERM`，提示本机环境可能有残留文件或权限干扰。 |
| `server/drivers/codex.test.ts` — `passes the person's proxy settings to the proxy, which Codex would otherwise drop` | 未执行 | 未确认 | 当前分支实测失败，455ms。属于 Codex 驱动环境变量/代理路径，本次没有直接修改该模块。 |
| `server/routines.test.ts` — `turns a paused schedule back on with its next occurrence` | 未执行 | 未确认 | 当前分支实测失败，19ms。失败极快，且有定时调度的时间敏感性；本次没有改 `server/routines` 相关实现，倾向环境/偶发，但尚无基线证据。 |
| `server/config.test.ts` — `keeps a hosted tenant's control-plane secrets out of every child env, and only those` | 未执行 | 未确认 | 当前分支实测失败，7ms。该测试文件本次仅改了一处线程上限常量的导入与边界值，但 `server/config.ts` 确有本次改动，必须做基线复核后才能排除。 |

## 基线对照状态

已创建基线 worktree：

- 路径：`D:\workspace\eacbot-baseline-check`
- 提交：`781c57e`（detached HEAD）
- 依赖：已把主仓库 `node_modules` 以 Windows junction 方式链接到基线副本，避免重复安装。

**基线测试尚未执行**，因此表中所有“是否本次引入”均为“未确认”。不能依据当前 7 个失败直接判定本次提交引入了回归，也不能据此判定新增失败数为 0。

## 已观察到的风险与干扰

1. 运行期间同一仓库存在另一组 Vitest 进程（启动参数包含 `server/live-access.test.ts`、`server/cloud-home.test.ts`、`server/workspace-backup-http.test.ts` 等），会与本轮串行测试争抢 CPU、端口和临时目录，增加时间敏感用例的偶发失败概率。
2. `server/drivers/codex.test.ts` 报告临时目录 `omb-test-home-*` 清理失败（Windows `EPERM`），说明本机可能存在文件句柄未释放或权限残留；这属于环境证据，但不能自动解释全部失败。
3. 全量输出采用单 worker，前两个大文件各耗时约 4–7 分钟；在未完成全部文件前，不能给出全仓库的测试总数。
4. 收尾检查 `git status` 时发现工作区在本次测试期间被其他进程改动：`docs/cleanse/07-quota.md`、`08-evidence-audit.md`、`09-blindspots.md`、`A-summary.md`、`server/request-auth.e2e.test.ts`、`server/request-auth.test.ts`、`server/request-auth.ts`、`src/components/SettingsModal.groups.test.ts`、`src/components/SettingsModal.tsx` 均显示为已修改，且出现了未跟踪的 `docs/cleanse/12-review-batch2.md`。这些改动不是本次回归任务产生的。由于测试运行时源码可能已被替换，本轮失败结果不能严格归因于 `521754b` 这个固定提交。

## 交卷口径

- 总测试数：**未取得（全量未完成）**；已完成 4 个文件共 1009 例。
- 通过数：**已完成部分 993 例**。
- 失败数：**已完成部分 7 例**。
- 跳过数：**已完成部分 9 例**。
- 本次新增失败数：**未测定，不能报 0**。需要先在同一基线 `781c57e` 上复跑上述 7 个用例，再逐项比对。

后续最小收尾步骤：在 `D:\workspace\eacbot-baseline-check` 运行这 4 个文件（或只运行 7 个失败用例的完整文件），记录基线失败集合；若基线与当前失败集合一致，则本次新增失败为 0；若基线缺少其中某项，再针对该项检查本次 config、bot 创建/改名、请求鉴权和 limits 改动的因果关系。
