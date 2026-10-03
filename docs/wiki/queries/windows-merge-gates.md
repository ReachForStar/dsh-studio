---
title: 本机（Windows）合并与门禁踩坑
type: query
tags: [merge, windows, pnpm, tsconfig, doc-gates, troubleshooting]
created: 2026-09-17
updated: 2026-09-26
sources: []
status: active
---

# 本机（Windows）合并与门禁踩坑

## 问题

在 Windows 上合并上游 3576 个文件后，`build`、文档门禁与若干测试出现一批「看似合并回归、实为环境或生成物」的失败。

## 根因与解法

| 现象 | 根因 | 解法 |
| --- | --- | --- |
| `build` 报 `TS2307: Cannot find module '@reachforstar/dsh-host-ssh-remotes/types'`（clean 之后必现） | fork 的 tsconfig 别名指向 `lib/types/types.d.ts`，而 `pnpm run clean` 删除了 `lib`；`packages/api/remotes` 未声明对 `packages/host/ssh-remotes` 的 project reference，`tsc -b` 不保证先构建它 | 在 `packages/api/remotes/tsconfig.host.json` 增加 `{ "path": "../../host/ssh-remotes" }`，别名维持 lib（project reference 输出）形态 |
| `src/` 下出现 `.js/.d.ts` 泄漏产物 | 曾把路径别名临时指向 `src/*.ts`，`tsc` 对非 `rootDir` 内文件就地输出 | 别名回退到 `lib`，删除 `src` 下产物；`pnpm run clean` 后再全量构建验证 |
| pdf license 测试 `tar: Cannot connect to C: resolve failed` | `pnpm pack --json` 返回**绝对**路径，Windows bsdtar 把盘符冒号当远程主机前缀 | 用 `basename(packed.filename)` 作为归档名、`dirname(...)` 作为 `cwd` |
| 大量测试 5s 超时（同一文件单独跑通过） | 本机在 7000+ 用例并发下负载饱和 | 隔离复跑分类；不视为回归（见「复发预防」） |
| `verify-md-links` 报 `.github/workflows/` 断链 | 早期批量替换把相对深度写成 8 级 | 统一修回 4 级（从 `.agents/notes/implemented/<kind>/` 出发） |
| `verify-archived-agent-notes` 报 seal 不匹配 | 归档笔记被链接替换脚本误改（归档是冻结区） | 还原为上游 blob，再 `--write` 重封 |
| `verify-translation-pairing` 报 out of sync | 生成器重写英文侧、或两侧同时改过内容 | 先补齐对侧（表体/说明同步），再 `verify-translation-pairing --write <pair>` 重录；一次 `--write` 只记录「已人工确认一致」的 pair |
| 生成器 `gen-doc-graphs` 抛 `missing service role classification: sshSftp` | `ctx.ssh` 改名后 `SERVICE_ROLES` 未同步 | 补 `key: 'sshSftp'`、`pkg: 'remote/ssh'` 分类（fork 包不在扫描 scope 内，用仓库路径作 owner 标签） |
| `verify-doc-budgets` 报 `docs/architecture.md` 超 2400 词 | fork 新增的 SSH/SFTP 路由表行把上游文件推过上限 | 行内压缩该行与 4 处冗余表述（不提高上限） |
| client bundle 构建报 `dynamic chunk "./client.pica.js" has no generated import expression`（`dsh-client-async-chunk-require`） | fork 的 Excalidraw 依赖树（ui-polish）含 ESM 依赖 pica，rolldown 对其输出 `__toESM(require("...").default, 1)` 互操作形态，插件正则只认裸 `require` 形态 | 扩展 `packages/client/tsdown.client.ts` 插件正则覆盖 `__toESM` 形态（上游树无此形态，行为不变）；两种形态都收敛为 `require.async(specifier)` |
| office 测试（jsdom 环境）zip 往返失败：解压键变成 `a.xml/0/` 之类、产物 4 倍大 | fflate 0.8.2 的 `fltn` 用 `val instanceof u8` 判定字节数组；jsdom 环境的 `TextEncoder` 输出属于另一个 realm，`instanceof` 失败，字节数组被当嵌套目录递归 | 合并时别把 fflate 固定死版本：保持 `^0.8.2`，pnpm 解析到 0.8.3（`fltn` 改用跨 realm 安全的 `ArrayBuffer.isView`） |
| `transform-corpus` 报 `UNEXPECTED BASELINE FAILURE`（上游已删除 `tool-present` 包） | 合并正确暂存了删除，但**未跟踪的构建产物 `lib/` 残留**；基线语料扫描到孤儿 `lib` 去 import | `pnpm run clean`（会清「已删除包的残留产物」）后重新构建 |
| `verify-repository-references` 报 wiki 页/日志里的 commit 哈希 | 上游新增门禁：文档只允许 release tag 或受维护的仓库链接，禁止 commit 哈希 | 改写为描述性表述（如「当时 fork master 的实现」）；新 wiki 页不要写 commit 哈希 |

## 本机失败分类（已逐项归因）

| 失败 | 归因 | 证据 |
| --- | --- | --- |
| 大量 5s 超时（同一文件单跑通过） | 本机在 7000+ 用例并发下饱和 | 隔离复跑全通过 |
| `http-proxy` 的 `NO_PROXY='*'` 用例 | 默认 5s 期限短于本机子进程启动 | `--testTimeout=30000` 下 9/9 通过 |
| `subprocess-local` 的 native-windows / windows-inspector | 同上（默认期限偏紧） | `--testTimeout=60000` 下 17/17 通过 |
| `apps/desktop` macos-signature | 同上（负载抖动） | 隔离跑 12/12 通过（该文件在 Windows 上自跳过平台专属断言） |
| `shell/pwsh-local` 与 `shell/tool-pwsh` 的 4 个超时/中止用例 | **本机 pwsh 冷启动比用例期限慢**：本机实测 `pwsh` 启动 249–297ms，而用例在 50–100ms 就中止/超时；中止落在进程启动前，`subprocess-local` 的 `signal?.throwIfAborted()` 抛 `AbortError`/`TimeoutReason`，而非归类为 `aborted`/`timedOut` | 该包 `src/index.ts` 与 `tests/executor.spec.ts` 与上游 `master` **逐字节相同**（`git hash-object` 对比），故非合并引入 |
| `apps/desktop` 的 `upload-with-credentials` 两个 `isolates the upload* child` 用例（单跑稳定失败） | 与上游 `master` 逐字节相同；子进程 release 验证在 `stage=run-node; line=108` 失败，属本机 Windows 凭据/DPAPI 环境与上游用例预期的差异 | 不作合并回归处理（同「上游自身缺陷/环境差异」类） |
| `workspace-changes` 的 `git.spec.ts` 两个用例（超时消息文案 + 5s 超时） | 与上游逐字节相同；Node 的超时中止消息为 `The operation was aborted due to timeout`，用例期望旧文案 `timed out after 1ms`；另有一例 5s 期限偏紧 | 同上，环境/上游差异，不改 fork 代码 |
| `ui-theme` 的 `corner-shape-styles` 报 fork 文件里 full-round 圆角未配 `corner-shape: round` | 上游新增门禁扫描全仓 `*.module.css`；fork 自有的 `Slider.module.css`（thumb 50%）与 `StatsFloat.module.css`（.chip 999px）未配对 | 在两处 full-round 圆角旁补 `corner-shape: round;`（与 fork 既有配对写法一致） |

## 2026-09-26 合并轮新增分类

| 失败 | 归因 | 证据与处置 |
| --- | --- | --- |
| `apps/desktop` 的 `installed-update-network` 与 `packages/util/native-command` 的 `file-applications-windows`（各 1 例）| 子进程 `powershell.exe` 在 `System.Management.Automation.AmsiUtils.AmsiScanBuffer` 抛 `AccessViolationException`（AMSI 扫描崩溃），高负载下才触发 | 两个文件单独复跑全绿；`git hash-object` 与上游一致，属本机 AMSI/负载问题，不改用例 |
| `packages/deliverables/workspace-changes` 的 `plugin.spec.ts` 两例 5s 超时 | 每个用例真起 `git` 子进程，本机负载下超期 | `--testTimeout=30000` 下全绿；与上游逐字节相同 |
| `packages/deliverables/workspace-changes` 的 `git.spec.ts`「reports timeouts and external aborts」 | `timeoutMs: 1` 时中止落在进程启动前，底层抛 Node 的 `The operation was aborted due to timeout`，`src/git.ts:73` 的 `timed out after 1ms` 分支未命中 | 与上游逐字节相同，属上游用例自身的时限竞态，不在合并轮改动 |
| `scripts/build-exe-for-python-sdk.spec.ts` 两例 | 构建脚本按「含空格的参数加引号」渲染命令行，本机 Node 路径 `…\Author Software\nvm\.nodejs\node.exe` 含空格，用例却按裸路径拼接断言 | 用例改为按同一条渲染规则先算出可打印路径（该 spec 顶部 `printedExecPath`），4 处断言共用 |
| 79 个失败文件的分组复跑 | 全量并发下的负载噪声占多数 | 12 个文件一组串行复跑（`pnpm exec vitest run --fileParallelism=false <files>`），79 → 6 个文件；注意 `packages/boot/app-boot/tests/linked-resolution-matrix.spec.ts` 单文件 4800 用例耗时约 950s，全量串行不可行 |
| `verify-no-unknown-casts` 把 77 处 fork 断言判为新增 | 合并带进来的基线只列上游断言，fork 自有包（ui-polish、subagent-pi、xingchen、a2a、`deploy/a2a/gateway`、v4-to-v5 镜像）从未登记 | 用当前树扫描结果整体重写基线（553→591 文件、1448→1525 条，恰好只增 77 条、未删上游任何条目）；注意 `--prune` 在有新增违规时拒写，无法从零引导 |

## 如何判定「合并回归 vs 环境差异」

对每个可疑失败先做一步归零：`git hash-object <file>` 与 `git rev-parse upstream/master:<file>` 对比。若失败文件与上游一致，则该失败必为环境/延迟差异（或上游自身缺陷），不应当作合并错误去改 fork 代码；否则才逐行审阅冲突解。

## 复发预防

- 判断「合并回归 vs 本机抖动」：把失败文件**单独**跑一遍（`pnpm vitest run <path>`），本机负载类失败单跑即绿；仍失败才立案。
- 依赖版本合并时保持原有范围（如 `^0.8.2`），别顺手钉死具体版本：新上游依赖可能已经升到修了 bug 的小版本（fflate 0.8.3 修了跨 realm 判定）。
- 上游删除包后，合并暂存删除只覆盖**跟踪文件**；未跟踪的构建产物（`lib/`）会残留并被扫描类测试（transform-corpus）捡到，`pnpm run clean` 会清掉。
- 改动 `ctx` 服务键、生成器分类、双语配对记录后，一次跑齐：`pnpm run typecheck` → `gen-doc-graphs --check` → `pnpm run test:docs`。
- `docs/wiki/` 已在 `scripts/translation-pairing.manifest.json` 中排除；新增 wiki 页不需要英文对侧。
- Windows 上 `tar`、`pnpm pack`、`tsc -b` 的路径/产物行为与 POSIX 不同，涉及归档或别名时先在本机复现一次再改测试。
- 限并发要写全 `--fileParallelism=false`；裸写 `--fileParallelism` 会触发 pathe 启动崩溃（`input.replace is not a function`），进程无结果。全量跑仍用默认并发，取证靠分组串行复跑。
- 分组复跑前先剔除已单独验证为绿的失败文件（例如负载类超时），否则等于再跑一遍全量。

## 2026-10-03 测试红项的根因与修法

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| `computer-use-cua-driver-mcp` 的 4 条组合/生命周期用例失败（`driver.ndjson` 不存在、`providerName` 未定义） | `checkDriver` 在 Windows 上用 `shell: true` 却不转义命令：`C:\Program Files\...`、`...\Author Software\nvm\...` 这类带空格的路径被 shell 从第一个空格切开，`--version` 实际没跑起来，于是判为「未安装」；provider 在未安装时直接返回，不占位也不起子进程。本机 node 恰好在带空格的目录下，必然命中 | `checkDriver` 走 shell 时给命令加引号（`shell: true` 要保留，npm 安装的 `.cmd` 垫片只有 shell 能解析）；新增 `tests/installer.spec.ts`，用带空格的临时目录加 `.cmd` 垫片复现该路径 |
| `lifecycle.spec.ts` 的「保留占位直到子进程收尾」失败（`configurations[1]` 是 undefined） | 用例只 mock 了 MCP 客户端，没 mock `checkDriver`，而它配置的 `/configured/driver` 在宿主上并不存在，provider 因此提前返回；先前能过只是因为宿主 PATH 里恰好装了 `cua-driver` | 在 `lifecycle.spec.ts` 里把 `checkDriver` 固定为「已安装」：该文件管的是占位与释放顺序，驱动是否在宿主 PATH 属另一类用例 |
| `packages/a2a/a2a` 的两条用例失败（首帧前断连重试、流没有任务时报错） | 客户端新增了截断判定——流没有以终态帧收尾就报 `stream ended without a terminal frame`；两条用例的假服务器分别以「消息帧」和「空流」收尾，于走到各自断言前就抛了客户端错误 | 假服务器改为以终态 `statusUpdate` 收尾：「重试」用例仍验证重试一次；「没有任务」用例只回终态状态、不给任务帧，仍走 `stream ended without a task` 分支 |
