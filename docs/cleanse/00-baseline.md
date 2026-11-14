# 00 清洗前基线：环境、构建与测试

采集日期：2026-11-14  
仓库：`D:\workspace\EACbot-clean-core`  
分支：`codex/clean-core`  
HEAD：`781c57e9a6fbf0f504704d358f4c82a1860490c2`（短哈希 `781c57e`）

**基线状态：BLOCKED（暂不可评估）。** 当前工作树缺少 `node_modules`，`typecheck`、`build`、完整测试和定向测试都在启动编译器或测试运行器之前失败。因此，下面的退出码 1 不能解释为源码类型错误或测试失败，目前也没有可比较的通过数、失败数。

**采集期间工作树发生并行变更（重要）。** 开始检查时 `git status` 是干净的；到 2026-11-14 12:09 复核时，以下文件已由本任务之外的编辑变成未提交状态：`server/announcement-feed.test.ts`、`server/devs-report-send.test.ts`、`server/devs-report-send.ts`、`server/routes/update-check.ts`、`server/update-check.test.ts`、`server/update-check.ts`。本任务没有编辑或回滚这些文件。由于当前执行都止于“找不到 tsc/vitest”，依赖可用性的结论不受文件内容变化影响；但本文件不是冻结源码的绿灯基线，后续比较前应先确定一个已提交或固定的快照。

> 证据口径：仓库事实在句末标注 `文件:行`；本机版本、命令退出码、耗时和目录存在性来自本次实际命令输出，已在下方原样附上。此类环境事实没有对应的仓库文件行号。

## 一、环境与仓库状态

| 项目 | 实际值 | 判断与证据 |
|---|---|---|
| Node.js | `v24.19.0` | 满足要求：`package.json:16-18` 要求 Node `>=24`；实际值来自 `node --version`。 |
| pnpm | `10.33.0` | 与项目钉住的版本一致：`package.json:19` 为 `pnpm@10.33.0`；实际值来自 `pnpm --version`。 |
| Git 工作树 | 开始时 clean；12:09 复核时 dirty | 开始时 `git status --short --branch` 只输出分支名；随后出现上面列出的并行修改，来源不属于本次基线操作。 |
| Git HEAD | `781c57e9a6fbf0f504704d358f4c82a1860490c2` | 与任务给出的基线 `781c57e` 一致；来自 `git rev-parse HEAD`。 |
| 构建产物 | `dist/`、`dist-server/`、`dist-companion/`、`.vite/` 均不存在 | 来自本次 `Test-Path`；当前也没有可复用的旧构建结果。 |

依赖目录检查结果是：根目录、`apps/docs`、`cloudflare/control-plane` 以及根 `node_modules/.pnpm` 全部不存在。`pnpm typecheck` 也直接提示：`WARN Local package.json exists, but node_modules missing, did you mean to install?`

## 二、Workspace 与真实脚本名

pnpm 只把三个包列入 workspace：根包 `.`、`apps/docs`、`cloudflare/control-plane`，证据是 `pnpm-workspace.yaml:4-7`。`cloudflare/composio-broker` 没有自己的 `package.json`，不在 workspace 列表中；它的测试入口由根脚本直接指定。

### 根包入口

| 目的 | 真实脚本名 | 实际命令 | 证据 |
|---|---|---|---|
| 类型检查 | `typecheck` | `tsc -b && tsc -p tsconfig.server.json` | `package.json:39` |
| 应用构建 | `build` | `tsc -b && tsc -p tsconfig.server.json && vite build` | `package.json:38` |
| 全量测试入口 | `test` | `vitest run && pnpm broker:test && pnpm test:electron && pnpm test:packaged-server` | `package.json:40` |
| Electron 测试 | `test:electron` | `node --test "electron/*.node-test.mjs"` | `package.json:41` |
| 打包服务冒烟 | `test:packaged-server` | `pnpm build:server && node scripts/smoke-packaged-server.mjs` | `package.json:80` |
| Broker 测试 | `broker:test` | `vitest run --config cloudflare/composio-broker/vitest.config.ts` | `package.json:83` |
| Control Plane 类型/检查 | `control-plane:check` | 进入 workspace 执行其 `check` | `package.json:86`、`cloudflare/control-plane/package.json:19` |
| Control Plane 测试 | `control-plane:test` | 进入 workspace 执行其 `test` | `package.json:87`、`cloudflare/control-plane/package.json:20` |

根 `typecheck` 覆盖两部分：根 `tsconfig.json` 的 `src` 与 `vite.config.ts`（`tsconfig.json:23`），以及 `server`、`companion`、`enterprise`、`connector`（`tsconfig.server.json:24-28`）。它没有包含 `apps/docs` 和 `cloudflare/control-plane` 的独立检查，所以检查整体仓库时不能只看根 `typecheck`。

根 `build` 也只执行根应用、服务端类型检查和 Vite 构建（`package.json:38`）。文档包与 Control Plane 是独立 workspace，需要单独构建或检查。

### Workspace 入口

| 包 | 类型检查脚本 | 构建/测试脚本 | 证据 |
|---|---|---|---|
| `@eacbot/docs` | `types:check`，不是 `typecheck` | `build`、`dev`、`start` | `apps/docs/package.json:9-12` |
| `@eacbot/control-plane` | `check`，内部先运行 `types` 再执行 `tsc` | `test`、`types:check`、`dry-run` | `cloudflare/control-plane/package.json:19-23` |

### 测试发现范围

Vite/Vitest 的测试范围包含 `evals`、`server`、`electron`、`src`、`shared`、`companion`、`enterprise`、`connector` 和 `scripts`（`vite.config.ts:34-44`）。测试环境是 Node，并加载两个 setup 文件（`vite.config.ts:55-60`）。因此本任务关心的 `update-check`、`announcements`、`enterprise`、`config` 测试都应由这个 Vitest 配置发现。

## 三、依赖状态

| 路径 | 是否存在 | 对本基线的影响 |
|---|---:|---|
| `node_modules` | 否 | 根包无法找到 `tsc`、`vitest`、`vite` 等本地可执行文件。 |
| `apps/docs/node_modules` | 否 | 文档包尚无独立依赖，`types:check`/`build` 不能执行。 |
| `cloudflare/control-plane/node_modules` | 否 | Control Plane 尚无独立依赖，`check`/`test` 不能执行。 |
| `node_modules/.pnpm` | 否 | 没有 pnpm 的本地虚拟依赖树。 |

本次只检查并报告，没有运行 `pnpm install`，也没有联网。项目允许 Electron 和 esbuild 运行安装脚本，配置见 `pnpm-workspace.yaml:15-21`；这只说明安装后会执行哪些构建脚本，不代表当前已经安装。

## 四、实际执行结果

### 4.1 `pnpm typecheck`

- 退出码：`1`
- 耗时：`918.1 ms`
- 实际阶段：未进入 TypeScript 编译
- 错误数：无法取得，因为 `tsc` 没有启动

```text
> eacbot@0.2.0-preview.1 typecheck D:\workspace\EACbot-clean-core
> tsc -b && tsc -p tsconfig.server.json

'tsc' is not recognized as an internal or external command,
operable program or batch file.
 ELIFECYCLE  Command failed with exit code 1.
 WARN  Local package.json exists, but node_modules missing, did you mean to install?
```

结论：`typecheck` 未通过，但不是源码类型检查失败。入口命令的定义见 `package.json:39`，当前缺少本地 `typescript` 可执行文件。

### 4.2 `pnpm build`

- 退出码：`1`
- 耗时：`1,087.9 ms`
- 实际阶段：未进入 TypeScript 编译和 Vite 构建

```text
> eacbot@0.2.0-preview.1 build D:\workspace\EACbot-clean-core
> tsc -b && tsc -p tsconfig.server.json && vite build

'tsc' is not recognized as an internal or external command,
operable program or batch file.
 ELIFECYCLE  Command failed with exit code 1.
 WARN  Local package.json exists, but node_modules missing, did you mean to install?
```

结论：构建入口存在（`package.json:38`），但当前无法构建。

### 4.3 根 `pnpm test`

- 退出码：`1`
- 耗时：`1,131.1 ms`
- 实际阶段：Vitest 第一段就失败，后续 broker、Electron、packaged-server 均未开始

```text
> eacbot@0.2.0-preview.1 test D:\workspace\EACbot-clean-core
> vitest run && pnpm broker:test && pnpm test:electron && pnpm test:packaged-server

'vitest' is not recognized as an internal or external command,
operable program or batch file.
 ELIFECYCLE  Test failed. See above for more details.
```

结论：完整测试链未通过，不能据此判断任何测试用例失败。完整链条的四段定义见 `package.json:40`。

### 4.4 定向测试

执行了以下 9 个文件：

```text
server/update-check.test.ts
server/routes/update-check.test.ts
server/announcements.test.ts
server/routes/announcements.test.ts
server/enterprise.test.ts
enterprise/server/workspace-access.test.ts
enterprise/server/register.test.ts
enterprise/server/license.test.ts
server/config.test.ts
```

- 退出码：`1`
- 耗时：`1,100.1 ms`
- 通过数：无法取得
- 失败数：无法取得

```text
'vitest' is not recognized as an internal or external command,
operable program or batch file.
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found
```

结论：定向测试同样未执行。这个结果与根 `pnpm test` 的阻断点相同：缺少本地 `vitest`，不是测试断言失败。

## 五、定向测试清单

下表的“测试声明数”是在工作树仍与 HEAD `781c57e` 一致时，对源码中 `it(`、`test(` 或 `it.each` 起始行的静态计数，只用于说明待跑规模；参数化测试在运行时可能展开为更多用例，不能当作通过/失败数。由于采集期间发生了并行修改，当前工作树的声明数可能已经变化，正式验收前应重新清点。

| 清洗域 | 测试文件与证据 | 测试声明数 |
|---|---|---:|
| update-check | `server/update-check.test.ts:9`、`server/routes/update-check.test.ts:31` | 6 + 3 = 9 |
| announcements | `server/announcements.test.ts:16`、`server/routes/announcements.test.ts:58` | 2 + 3 = 5 |
| enterprise | `server/enterprise.test.ts:25`、`enterprise/server/workspace-access.test.ts:120`、`enterprise/server/register.test.ts:27`、`enterprise/server/license.test.ts:21` | 13 + 19 + 3 + 7 = 42 |
| config | `server/config.test.ts:55` 至 `server/config.test.ts:2358` 的多组 `describe` | 174 |
| **合计** | 9 个测试文件 | **230 个静态声明** |

这里选用的是四个清洗域的直接测试。若按 `config` 字样做宽泛文件名搜索，还会命中 `server/decider/decider-config.test.ts`、`server/plugins/config-host.test.ts`、`shared/plugins/config.test.ts` 等文件；它们各属于后续具体模块，暂不与本轮基线混在一起。

## 六、当前不可用项

| 项目 | 状态 | 原因 |
|---|---|---|
| TypeScript 类型检查 | 不可用 | 没有 `node_modules`，本地 `tsc` 不存在；`pnpm typecheck` 已实测失败。 |
| 根应用与服务端构建 | 不可用 | 同一原因，`tsc` 在执行 `vite build` 前就失败；`pnpm build` 已实测失败。 |
| Vitest 全量测试 | 不可用 | 本地 `vitest` 不存在；`pnpm test` 已实测失败。 |
| 指定 9 文件定向测试 | 不可用 | 本地 `vitest` 不存在；已实测失败。 |
| 通过数/失败数/覆盖率 | 无结果 | 测试运行器未启动，任何数字都会是假数据。 |
| 编译器错误数 | 无结果 | 编译器未启动，不能报源码错误数。 |
| 正常构建/测试耗时 | 无结果 | 上面的耗时只覆盖 pnpm 启动与“找不到命令”的失败路径，不能作为项目真实耗时。 |
| `apps/docs` 检查与构建 | 未执行 | workspace 依赖目录不存在；脚本定义仍存在。 |
| `cloudflare/control-plane` 检查与测试 | 未执行 | workspace 依赖目录不存在；脚本定义仍存在。 |
| Electron、Broker、packaged-server 测试 | 未执行 | 根测试链在第一个 `vitest run` 处已经终止。 |

## 七、恢复基线后的建议验收顺序

### 依赖恢复方案（二选一）

1. **联网、严格按锁文件安装：** `pnpm install --frozen-lockfile`
   - 优点：依赖版本与 `pnpm-lock.yaml` 完全一致，最适合作为可重复基线。
   - 代价：需要联网并下载整套依赖；按本机约定，联网命令要使用提权方式执行。
2. **使用已有 pnpm store 离线安装：** `pnpm install --offline --frozen-lockfile`
   - 优点：不访问网络，不会受临时网络故障影响。
   - 代价：本机 store 必须已经包含全部 tarball，否则会立即报缺包；本次没有检查 store 完整性。
3. **暂不安装，只保留当前 BLOCKED 基线：**
   - 优点：工作区零依赖改动，仍可做静态审计。
   - 代价：无法完成类型检查、构建、测试和任何“清洗后没有回归”的验收。

### 每轮清洗后的快速门禁

依赖恢复后，先用短链路定位本轮改动，成本较低：

```powershell
pnpm typecheck
pnpm exec vitest run server/update-check.test.ts server/routes/update-check.test.ts server/announcements.test.ts server/routes/announcements.test.ts server/enterprise.test.ts enterprise/server/workspace-access.test.ts enterprise/server/register.test.ts enterprise/server/license.test.ts server/config.test.ts
```

优点是耗时短、直接覆盖 update-check、announcements、enterprise、config；缺点是覆盖不到 Electron、Broker、打包服务和两个独立 workspace。

### 开 PR 前的完整门禁

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @eacbot/docs types:check
pnpm docs:build
pnpm --filter @eacbot/control-plane test
```

Control Plane 的类型检查有两个入口：

1. 使用官方组合脚本 `pnpm control-plane:check`。优点是完整复现项目定义；缺点是它会先运行 `wrangler types`，可能重写生成文件。
2. 分两步执行 `pnpm --filter @eacbot/control-plane types:check`，再执行 `pnpm --filter @eacbot/control-plane exec tsc -p tsconfig.json`。优点是不生成类型文件；代价是命令更长，且与官方组合脚本的调用路径不完全相同。

完整门禁覆盖广，但 `pnpm test` 会继续运行 Broker、Electron 和 packaged-server，其中 packaged-server 还会先构建服务端；耗时和外部工具要求都明显高于快速门禁。

## 八、下一次基线采集的判定

依赖安装完成后，必须在一个已提交或明确指定的快照上重新执行本文件的四组命令，并把结果补成“可评估基线”。只有当 `tsc` 和 `vitest` 真正启动后，才能记录类型错误数、测试通过/失败数、真实耗时以及失败用例清单。当前结论仅能作为“依赖未安装”的起点，不能作为后续清洗的绿灯基线。

本次没有修改源码、没有运行安装或联网命令、没有创建提交，也没有 push。
