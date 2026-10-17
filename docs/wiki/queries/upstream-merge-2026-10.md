---
title: 合并上游 upstream/master（2026-10-15）
type: query
tags: [upstream-sync, merge, session-format, 夹具, 判定口径]
created: 2026-10-15
updated: 2026-10-18
sources: []
status: active
---

# 合并上游 upstream/master（2026-10-15）

## 问题

把上游 `upstream/master` 在 2026-10-15 的头提交并入本地 `master`，保留 fork 自研功能，然后推送到 `me`（`git@github.com:ReachForStar/dsh-studio.git`）。本地上一次合并是同日的更早一轮（那次带入的上游改动已含 office 录制场景等内容），因此本轮是增量合并，而非全量追赶。合并本身零冲突残留，难点在**判定哪些测试红灯由合并引入**：fork 的 `master` 上本来就有一批红用例（无 CI 覆盖 harness 包，见 [fork 自研包的门禁红项清单](fork-gate-debt.md)），只凭「合并后红了」会把预存缺陷算到合并头上。

规模：冲突 50 个文件，合并结果相对合并前 HEAD 改动 3349 个文件（+133645 / −21895）；fork 独有提交 246 个，fork 私有包目录 18 个（`a2a*`、`xingchen`、`pi-agent-loop`、`subagent-pi`、`fs-sftp`/`ssh*`、`ui-polish`/`ui-ssh`/`ui-a2a-status`、`tool-excalidraw`、`session-format-v4-to-v5`），合并后逐一核对全部在位。

## 判定口径

用合并前的 HEAD 拉一份独立工作树 `/tmp/opencode/head-baseline`（分离头指针 + 各包 `node_modules` 符号链接），跑同一批失败文件作基线。分类：

- **合并引入**：基线绿、合并后红。逐项修复。
- **预存/环境**：基线同样红。记录现象与归属，不在本轮改动。
- **偶发**：并行跑（多个 vitest worker 争资源）时红、单跑绿。单跑复核后归入本机环境。

这条口径比「合并前 HEAD 是否也红」更严格：基线工作树必须能真正加载被测套件，否则该套件对本轮不可测（`packages/client/ui-settings-general` 的 shell 套件即因符号链接下的 tsconfig 路径解析出错而未测得，改用代码证据判定）。

## 修复：会话格式 v4 源准入（合并引入）

现象：v4 会话重放批量失败，`session-format-corpus.spec.ts` 59 例、`webworker-packer/tests/preview.spec.ts` 与 `webworker-runtime/tests/vfs-example-fixture.spec.ts` 各若干，报 `SessionFormatUnsupportedMigrationError` 与「未知必读事件」。

根因：两侧读取器的词汇来源不同——上游 v4 读取器用实时事件表判定源事件，fork 的 v4 源准入用冻结列表 `RELEASED_V4_EVENT_TYPES`（`packages/session/session-format-v4-to-v5/src/extension-identities.ts`）。上游在 v4 世代存续期间新增了第一方类型，冻结列表没有跟着长。同时 `src/facts.ts` 的 `catalogFact` 仍按「catalog version 只允许 1」拒绝上游 v3→v4 已放行的 `version: 2` + `mode: 'external'`。

| 缺口 | 证据 |
| --- | --- |
| `job/registered`、`job/settled` | 上游在 v4 代内新增（`git diff HEAD upstream/master -- packages/core/session/src/known-event-types.ts` 的两行 `+`）；HEAD 的夹具 0 处含之，合并工作区 53 个夹具文件含之 |
| `working-directory/change` | fork 自己的 v4 夹具里就有（6 个文件），HEAD 即被拒，属预存缺陷 |
| catalog `version: 2` + `mode: 'external'` | 上游 v3→v4 的 `catalogFact` 已放行，本包仍拒；归入同一轮修复 |

修法：词汇表补三类，`catalogFact` 采纳上游 v3→v4 的规则（version 允许 2、mode 允许 `external`、校验 `version === 2 ⟺ mode === 'external'`），双语 README 与 `README.i18n.yaml` 同步重记。结论按代际写进[会话格式代际](../concepts/session-format-generations.md)，格式细节写进[会话格式 v5 落地](session-format-v5-landing.md)。

## 修复：vfs-example 夹具代际（合并引入）

`packages/experimental/webworker-runtime/tests/fixtures/vfs-example` 的主会话当前代夹具，上游侧是 `session.v4.jsonl`（上游写入器为 v4），fork 写入器为 v5。按其测试（合并时采纳的上游版本：主会话提交「当前代」字节，历史代作前置）重录为 `session.v5.jsonl`，同步重录 `home/storages/session_projcache.json`，移除上游带入的 v4 文件。录制用一次性 vitest 脚本调该包的 `buildVfsExampleFiles()` 写出，脚本用完即删。

## 修复：corpus 策略规格的自洽（合并引入 + 预存）

`scripts/session-snapshot-corpus-policy.spec.ts` 三例红：一例由合并改动（上游把 `MAX_RETAINED_ROLES` 11→13 并把 Office 录制场景加进断言），两例是 fork 早先给 `adjacent` 加 v4 时留下的计数偏一（预期 3，实为 4）。三例一起修：`adjacent` 为 `[1,2,4]` 时「保留角色」计数按 8/9 构造，使接受例恰好 13、拒绝例 14 并命中既有报错文案；两例 `it.each` 的期望改为 `retainedRoles: 4, retainedScenarios: 4`。修后该文件 20 通过。

## 与既有知识的关系

- 沿用 [合并上游 upstream/master（2026-09）](../decisions/2026-09-upstream-sync.md) 的取舍策略（全量合并、按来源逐文件取舍），本轮新增的是判定口径与基线工作树的做法。
- 会话格式部分补进[会话格式代际](../concepts/session-format-generations.md)（词汇表来源差异）与[会话格式 v5 落地](session-format-v5-landing.md)（本轮修复清单）。
- 上游 API 改名引发的 fork 测试适配：`ctx.subagents.start` → `startActivation`（`packages/xingchen/xingchen/tests/xingchen.spec.ts`），subagent 子进程 cwd 经 `ctx.workingDirectory` 接缝解析、测试改为挂载 `mountWorkingDirectoryFixture`（`packages/subagent/subagent-pi/tests/*`）。

## 验证记录

- 首次全量：37 红 / 44465 绿；修完三类问题后全量：19 文件 31 红 / 44471 绿（`tmp/test-full-r3.log`）。
- 31 红逐项归因：29 项在基线工作树上同样红（`spill-local` 10、`ui-theme` 3、`worktree` 3、`ssh-helper/artifact` 2、`agent-preset/skills` 2、`ui-settings-general` 2、`session-query-spill-command`、`install-lefthook`、`xingchen/skills`、`native-command`（gio）、`skill-filesystem`、`bash-sandbox`、`agent-instructions`）；2 项是 5 秒超时类偶发（`binary-rpc.host.spec.ts`、`apps/desktop/tests/prepare-runtime-patches.spec.ts`），单跑均绿（2 文件 59 用例通过）。
- 修复涉及的定向验证：`session-format-corpus` 769/769；`session-format-v4-to-v5` + `session-format-catalog` + `session-format-v3-to-v4` 45 文件 804 用例；`webworker-runtime` + `webworker-packer` + 夹具布局 41 文件 1041 用例；`session-snapshot-corpus-policy.spec.ts` 20 用例。

## 存疑或待跟进

- `test:snapshot` 的仓库级 corpus 检查（`scripts/session-snapshot-corpus.corpus.ts`）在合并前后**同样红**：`web/diff-context` 的借用方清单仍指向 `session.v4.jsonl`（属主目录当前代已是 v5），`acp/cancel` 选了 v4 却没在 `snapshot.yml` 声明保留代。两条都属 fork 侧 v5 重录尚未收尾的存量（合并新增的 20 个上游场景也全是 v4 单代文件），本轮未处理。下一轮（[2026-10-18](upstream-merge-2026-10-18.md)）复核仍在。
- `packages/client/ui-settings-general/tests/shell.client.spec.ts` 的 `PRODUCT_SECTIONS` 少列 fork 自己注册的 `a2a-status` 段（合并前 HEAD 的 roster 就已含该段，属预存），其余存量红项见上方验证记录。
