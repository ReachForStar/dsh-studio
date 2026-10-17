---
title: 合并上游 upstream/master（2026-10-18）
type: query
tags: [upstream-sync, merge, snapshot, refresh, 判定口径]
created: 2026-10-18
updated: 2026-10-18
sources: []
status: active
---

# 合并上游 upstream/master（2026-10-18）

## 问题

把上游 `upstream/master` 在 `dsh-v0.2.1-rc.2` 的头提交（49 个新提交，含 0.2.1-rc.2 发布、DeepSeek Search/Fetch API、模型标签 1017、账号通知层叠）并入本地 `develop`，验证后快进 `master`，两个分支推送到 `me`（ReachForStar/dsh-studio）。合并基点是同日早些的 `dsh-v0.2.1-alpha.4`，属增量合并。

规模：冲突 20 个文件，合并结果相对合并前 fork HEAD（「暂时屏蔽桌面更新功能」提交）改动 703 个文件（+7712 / −1633）。

## 冲突取舍（沿用按来源逐文件策略）

| 类别 | 文件 | 取舍 |
| --- | --- | --- |
| 版本与 fork 元数据 | `browser-use`、`computer-use`、`web-app` 的 `package.json` | `version` 取上游 `0.2.1-rc.2`；fork 的 `icon`、`cordis.patch.yml`/`locale` 导出、`dsh.bundle.patch`、`@reachforstar/*` 依赖全部保留；上游新依赖 `dsh-client-ui-deepseek-model-label-1017` 并入 |
| fork 已删除 | `.github/workflows/ci.yml` | 维持删除（fork 放弃云端 CI，见 [2026-09 决策](../decisions/2026-09-upstream-sync.md)） |
| 生成物 | `docs/persistence-catalog.*`、`docs/capability-seams.i18n.yaml`、`historical-formats/README.*` | 取上游后重生成：`gen-persistence-catalog`、`gen-doc-graphs`、`verify-persistence-formats --write`（恢复 fork 的 v4 历史行 + v5 当前 writer，67 根/636 类型）、`verify-translation-pairing --write --all`（1061 对一致） |
| 系统提示词快照 | 9 个 `system-prompt.expected.md`（sdk ×4、office ×4、workspace-dependencies） | 先取 fork 侧解冲突，再经 `DSH_SNAPSHOT=refresh` 重生成：同时含上游新增的 personaPrefix 行、回退后的 read/subagent 文案，与 fork 的 SSH/SFTP 段 |

上游 `fix(prompts): restore compatible PTC guidance and SDK persona` 故意回退了 fork 在 `tool-fs/read.ts` 的提示词加长（「cat, sed, head, or tail」→「cat」），按「上游改动取上游侧」采纳回退，所有引用该文案的快照一并 refresh。

## 验证与红灯归因

本轮基线工作树不可用（符号链接下 typert-loader 找不到各包 `lib/` 构建产物），改用**代码证据判定**：合并结果相对 fork-HEAD，凡「夹具 + 因果源码都未变」的失败，回放是确定性函数，fork-HEAD 上必然同样红，即预存。

- typecheck（5 门禁）、build:artifacts（7 门禁）、test:docs（21 门禁）全部通过。
- `test:snapshot` 首跑 8 红：2 个合并引入（office-progressive-ptc 的上游新 SKILL 文案、web-search-endpoint-guidance 的上游新错误文案 + `thinking` 字段），经 refresh 重录 v5 夹具后转绿；6 个预存（image-compaction、compaction ×2 需 live record 补第 4 次模型调用；persistent-pwsh 的 pin 属 live 录制且本机缺 pwsh；corpus ×2 是 fork v5 重录欠账，[上轮已记录](upstream-merge-2026-10.md)）。
- `pnpm run test` 全量：6 红 / 45360 绿。workspace-changes ×2、http-proxy ×1 是 5 秒超时偶发（`--testTimeout=60000` 单跑 40/40 绿）；verify-packed-install ×3 的 spec 与被测源码相对 fork-HEAD 零差异，属本机 npm 不执行 lifecycle 脚本的确定性环境失败。无合并引入红灯。

## 顺手修复

`docs/wiki/log.md` 2026-10-16 条目里的裸 commit hash 触发 `verify-repository-references` 门禁（fork-HEAD 上即红，属 log 行笔误）；改写为提交主题引用后 21 文档门禁全绿。

## 与既有知识的关系

- 沿用 [2026-09 决策](../decisions/2026-09-upstream-sync.md) 的全量合并、按来源取舍策略与生成物重生成做法。
- 上轮（[2026-10-15](upstream-merge-2026-10.md)）的基线工作树判定口径本轮因构建产物缺失不可用，降级为「夹具 + 因果源码零差异 ⟹ 确定性回放必然同红」的代码证据判定，同样满足「不把预存缺陷算到合并头上」。
- 上轮记录的 31 项存量单测红本轮多数未复现（本轮仅 6 红），推测上游修复与本机状态变化所致；未逐项复核，不作为结论。

## 存疑或待跟进

- image-compaction、compaction-output-reserve、compaction-summary-headroom 三个场景需在有 `DEEPSEEK_API_KEY` 的环境 `test:snapshot:record` 重录（脚本轮次从 3 变 4）。
- persistent-pwsh-tool-turn 的 header pin 需 pwsh 环境重录后才能让 persistent-pwsh-padded-completion 转绿。
- corpus 的 `web/diff-context`、`acp/cancel` v4 借用清单欠账与上轮相同，仍未收尾。
