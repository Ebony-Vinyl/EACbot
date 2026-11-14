# 第一批清洗独立复核（Reviewer）

- 仓库：D:\workspace\EACbot-clean-core
- 分支：codex/clean-core
- 基线：781c57e
- 复核快照：提交 b5ca7fd（fix(server)：默认关闭三项外连并改为显式配置），8 个文件，+102/-36
- 复核时间：2026-11-14 12:10–12:26（Asia/Shanghai）
- 复核人：Reviewer（未参与实现，独立读代码、独立跑命令）
- 环境：Node v24.19.0、pnpm 10.33.0；node_modules 已安装

任务清单列了 6 个文件，实际提交多出 server/index.ts（仅同步调用点）和 server/announcement-feed.ts（仅新增注释），两者都在本批“更新检查 / 问题上报 / 公告”范围内。复核期间共享工作树有并行编辑；本报告以提交 b5ca7fd 为准，其它任务的改动不计入结论（见文末“快照说明”）。

## 逐项结果

| 编号 | 检查项 | 结论 | 证据（文件:行 或 命令输出摘要） |
|---|---|---|---|
| 1 | 改动范围是否只涉及三处外连控制 | 通过 | git diff --stat 781c57e...b5ca7fd 只有 8 个文件（server/update-check.ts、server/routes/update-check.ts、server/update-check.test.ts、server/devs-report-send.ts、server/devs-report-send.test.ts、server/announcement-feed.test.ts、server/index.ts、server/announcement-feed.ts）；server/index.ts:2846 只把 bugReportEndpoint(process.env, CLOUD_HOME?.adminOrigin) 改为 bugReportEndpoint(process.env)；server/announcement-feed.ts:27 只新增“空 URL 即关闭”的注释；无 package.json、锁文件或依赖改动；git diff --check 无输出 |
| 2 | 未配置 EAC_UPDATE_CHECK_URL 时，更新检查是否完全不外连 | 通过 | server/update-check.ts:11-21 对未设置、空白、非法、带用户名密码的 URL 一律返回空串；server/update-check.ts:110 在 fetchRelease 之前直接返回 checked:false；真正的请求在 server/update-check.ts:114；路由从 process.env 取值见 server/routes/update-check.ts:26。运行时探针把全局 fetch 换成记录器，未配置路径的 off.calls 为 [] |
| 3 | 未配置 EAC_BUG_REPORT_URL 时，问题上报是否完全不外连 | 通过 | server/devs-report-send.ts:27-37 只认 EAC_BUG_REPORT_URL，未设置或非法即返回空串，不再从 Cloud Admin 地址兜底；server/devs-report-send.ts:79 在发送前用空端点直接拒绝；server/devs-report-send.ts:122-129 状态地址为空时返回空串，查询直接返回 null；server/index.ts:2846 只传 bugReportEndpoint(process.env)。探针结果：bug 为空串、status 为空串、send 返回 refused、ask 返回 null、off.calls 为 [] |
| 4 | 未配置 EAC_ANNOUNCEMENTS_URL 时，公告是否完全不外连 | 通过 | server/index.ts:12493 传入 process.env.EAC_ANNOUNCEMENTS_URL ?? ""；server/announcement-feed.ts:27 明确“空 url 即公告关闭”；server/announcement-feed.ts:53 的 poll 直接 return；server/announcement-feed.ts:117 的 schedule 直接 return，不创建定时器。探针结果：announcements 为 []、off.calls 为 [] |
| 5 | 显式配置后功能是否仍然可用 | 通过 | 三份测试全部覆盖配置后的正常路径；运行时探针同样验证：更新检查返回 available=true、latest=0.1.93；报告发送返回 {ok:true,id:'r1'}；状态地址为 https://cloud.example/api/bug-reports/status；公告返回 1 条；on.calls 恰好是三条显式配置的地址。没有删除功能，只改变了默认值 |
| 6 | 是否写死密钥、绝对路径或引入新外连 | 通过 | 对 8 个改动文件执行 rg，未命中 Windows 盘符绝对路径、/Users/、sk-/ghp_ 令牌或私钥标记；仅 server/index.ts:13394 含容器内路径 /home/cua/workspace 的提示文案，不是本机绝对路径；diff 删除了 api.github.com 默认地址和 Cloud/staging 兜底，没有新增外部目标；新增的配置只有 EAC_UPDATE_CHECK_URL。残留说明：server/devs-report-send.ts:12 仍保留 PRODUCTION_CLOUD_ORIGIN，但只被 server/headless/host-doctor.ts:294 的手动 doctor --host 时钟探测使用，不属于三个功能路径；STAGING_CLOUD_ORIGIN 已从 server 侧删除 |
| 7 | 测试是否被改弱（删断言、skip、expect 改 console.log） | 通过 | 断言计数（提交 781c57e -> b5ca7fd）：update-check.test.ts 29 -> 36 个 expect、6 -> 8 个 it；devs-report-send.test.ts 41 -> 47 个 expect、8 -> 10 个 it；announcement-feed.test.ts 6 -> 7 个 expect、2 -> 2 个 it。三个文件对 .skip、.todo、.only、console.log/console.warn/console.error 的扫描均无命中。新增“未配置不调用”断言：server/update-check.test.ts:78-84、server/devs-report-send.test.ts:59-66 与 120-128、server/announcement-feed.test.ts:63。旧断言只替换了已不存在的默认地址预期，没有删除有效覆盖 |
| 8 | 独立运行三个测试文件 | 通过 | 分别执行 pnpm exec vitest run server/update-check.test.ts、server/devs-report-send.test.ts、server/announcement-feed.test.ts：8/8、10/10、2/2 全部通过，三个进程 exit 0，耗时约 2.18s、2.27s、2.36s（12:22:50 开始，干净工作树 b5ca7fd）。另外补跑相邻的 server/routes/update-check.test.ts、server/routes/announcements.test.ts、server/announcements.test.ts：3 个文件 8/8 通过（12:25:06，同一工作树） |
| 9 | 独立运行项目类型检查 | 通过 | package.json:39 的 typecheck 为 tsc -b && tsc -p tsconfig.server.json；实际执行 pnpm typecheck，exit 0，约 74.9 秒（30.0s + 30.0s + 14.9s，干净工作树冷启动），没有超过 10 分钟，因此未改用 tsc -p tsconfig.server.json --noEmit 的降级命令 |

## 附加发现（非阻断，不改变本批结论）

| 编号 | 发现 | 结论 | 证据与影响 |
|---|---|---|---|
| A1 | 未配置更新源时，界面会把“没有检查”显示成“已是最新” | 存疑（非阻断） | server/update-check.ts:85,110 返回 checked:false；但前端 ServerUpdateCheck 接口没有该字段（src/lib/server-update.ts:5-13），serverCheckPhase 对 available:false 返回 up-to-date（src/lib/server-update.ts:21-24），serverUpdateRow 显示 “You're up to date”（src/lib/server-update.ts:52-53、src/locales/en.json:8307）。自托管服务器未设置 EAC_UPDATE_CHECK_URL 时，用户会看到一句不真实的“已是最新” |
| A2 | 内部审计文档仍描述已被删除的 Cloud 兜底 | 存疑（非阻断） | docs/cleanse/01-backend-egress.md:31 仍写“EAC_BUG_REPORT_URL，或 Cloud home 的 EAC_CLOUD_ADMIN_URL”；最终代码 server/devs-report-send.ts:27-37 只认 EAC_BUG_REPORT_URL。同一文档 :81 也仍说报告状态发往 Admin URL。该文档不是本次提交内容，但会误导下一批审计 |
| A3 | 用户侧文档没有说明如何重新启用 | 存疑（非阻断） | 在 docs、README.md、DEV.md 中检索 EAC_UPDATE_CHECK_URL 与 EAC_BUG_REPORT_URL，除 docs/cleanse 内部审计外没有面向自托管用户的说明。升级后默认关闭更新检查/上报的用户，无法从现有文档知道要设置哪个变量 |
| A4 | doctor --host 仍会 HEAD 生产 Cloud | 范围外残留 | server/headless/host-doctor.ts:294 对 https://cloud.eacbot.com 发 HEAD，用于时钟偏差探测；仅在手动执行 eacbot doctor --host 时触发（server/headless/commands.ts:70），不在三个功能路径，也不是自动启动。如果团队把“任何外部地址”按全仓库理解，这一处应列入下一批 |

## 结论

这一批可以进入下一批。7 项复核要求全部通过：改动范围可控；更新检查、问题上报、公告在未配置时都没有外部请求（运行时探针的 off.calls 为 []）；显式配置后三条功能都恢复；没有新增密钥、绝对路径或外连；测试断言数量增加且没有 skip/only/console.log 替换；三个测试文件分别 8/8、10/10、2/2 通过；完整 typecheck exit 0。

没有发现必须修复才能进入下一批的阻断项。合并或发布前建议处理以下非阻断项：第一，让前端识别 checked:false，避免把“未检查”显示成“已是最新”；第二，同步 docs/cleanse/01-backend-egress.md 的 Cloud 兜底描述，并在自托管文档写清 EAC_UPDATE_CHECK_URL、EAC_BUG_REPORT_URL 的启用方式；第三，如果目标是全仓库默认零外连，把 doctor --host 的 cloud.eacbot.com HEAD 探测列入下一批。

## 快照说明

本报告验证的是提交 b5ca7fd 的内容（分支 codex/clean-core，基线 781c57e）。复核过程中该提交曾以 27018ef 存在，随后被 amend 为 b5ca7fd；两者差异只有 server/update-check.ts 的 url 改为可选并用 ?? "" 兜底共 2 行，不改变“缺省即关闭”的语义。最终三测试、相邻路由测试和完整 typecheck 都在临时干净工作树 D:\workspace\eacbot-review-b5ca7fd 上重跑，node_modules 通过 junction 复用，没有联网安装新依赖。共享工作树同时存在其它任务的服务端和前端改动，不属于本批，未纳入结论。本次复核只读代码、运行测试和类型检查、写入本报告，没有修改源码，没有 push；临时工作树在复核结束后删除。
