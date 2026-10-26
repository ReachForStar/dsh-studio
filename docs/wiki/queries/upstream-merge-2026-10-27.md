---
title: 合并上游 upstream/master（2026-10-27，rc.3 同步）
type: query
tags: [upstream-sync, merge, snapshot, 冲突取舍, pnpm-lock]
created: 2026-10-27
updated: 2026-10-27
sources: []
status: active
---

# 合并上游 upstream/master（2026-10-27，rc.3 同步）

## 问题

把上游 `upstream/master` 的合并提交（1539 个提交，含 `0.2.1-rc.3` 版本同步、工具执行器插件化、条件工具、模型选择迁到 Agent、会话持久化 schema v2 布局）并入 `develop`。合并基点为上一轮的合并结果，fork 侧同期 282 个提交。验证通过后快进 `master`，两个分支推送到 `me`（`git@github.com:ReachForStar/dsh-studio.git`），二者同点，落在同一合并提交上。

规模：**176 个冲突文件、441 处冲突块**，是本仓库历轮合并中最大的一次。冲突块数量集中在生成物：`docs/persistence-catalog.{md,zh.md}` 各 79 处、`docs/persistence-catalog.i18n.yaml` 39 处、`pnpm-lock.yaml` 17 处。

## 取舍（沿用按来源策略，生成物一律重生成）

| 类别 | 处理 |
| --- | --- |
| fork 已删除的云端 CI | `.github/workflows/ci.yml`、`scripts/ci-workflow.spec.ts`、`scripts/ci-compatible-selfhosted.spec.ts`、`scripts/tests/ci-master-platforms.spec.ts` 维持删除（`git rm`），引用它们的文档改指 `../.github/workflows/` 目录 |
| 升级后的生成物 | `docs/{capability-seams,event-producer-consumer,config-catalog,persistence-catalog}.*`、`docs/persistence-schema.json`、`docs/subsystems/core.*`、两份 `slot-catalog.ts`/`api-catalog.ts`、`THIRD_PARTY_NOTICES.md` 先取上游再跑生成脚本 |
| 版本号 | `browser-use`/`computer-use` 等 fork 包取上游 `0.2.1-rc.3`，同时保留 fork 的 `icon`、`files`、`dsh.bundle` |
| 宽度控件 | CSS 取 fork 的滑块版本（`.widthSlider`），不是上游的拖拽手柄 |
| 快照 | 全部按合并后代码用 `DSH_SNAPSHOT=refresh` 重录，不手工合并 |

`OPTIONAL_BUNDLES` 已从 `packages/boot/app-boot/src/profile.ts` 迁到新包 `packages/util/official-bundles/src/bundles.ts`。fork 的 `browser-use`/`computer-use` 登记随迁到该文件，并在 `plugin-manager.ts` 的 `EXTENSION_BUNDLES` 里补登记，使其仍排在插件页 Official 组首位。

## 合并引入的真实缺陷（均已修复）

1. **`tools.execute` 改为批量接口**：上游把单调用 `ToolExecutionInput` 换成 `ToolBatchInput`（`calls` 数组 + `ToolBatchResult`）。受影响的是 fork 自研代码：`pi-agent-loop` 的 `dsh-tool-adapter.ts`、以及 `tool-a2a`、`tool-ssh`、`xingchen` 三个包的测试辅助函数。
2. **`Agent` 新增 `model: Model` 成员**：`PiLoopAgent` 没有该字段导致 `implements Agent` 失败。改法是复用上游 `AgentModel`，并在 `PiLoop` 的 `[Service.init]` 里注册 `modelSelectionProjectionDefinition`，把 `stateOf(session)` 作为读取器传进 agent。
3. **`AgentRegistry` 新增 `sessionProjections` 注入**：所有只挂 `SessionStore` + `AgentRegistry` 的测试 setup 都要补 `SessionProjectionRegistry`。
4. **`tools.execute` 需要显式挂载 tool-executor**：新架构下不挂 `@deepseek-ai/dsh-tool-executor-native` 就抛 `ToolExecutorUnavailableError`。受影响包已在 `devDependencies` 补该依赖（仅测试用，不进 `dependencies`）。
5. **`exit_plan_mode` 变成条件工具**：上游按 `{ when: ... }` 注册，只在 plan mode 选中或已进入时对模型可见，因此 `snapshots/sdk/bash-tool/tool-schemas.expected.json` 里它消失属预期。
6. **合并丢失的 i18n 键**：`ui-conversation`（`width.slider`/`width.sliderValue`）、`ui-sidebar-documentpreview`（`edit`/`save` 等 8 个）、`ui-sidebar-files`（`delete.*` 11 个）、`ui-chat`（`message.peerAnswer`/`command.progress`）、`ui-plugin-manager`（`builtinBrowserUse*`/`cuaDriver*` 10 个）、`ui-agent-preset`（`presetPi*`/`presetXingchen*`）在上游新增的 de/es/fr/ja/pt/ru 字典里缺失。全部补齐并复核每个语言键集与 `en` 完全一致。
7. **`ui-chat` 的 `StatsPills.tsx` 取了旧版**：上游把 `DialogPill` 的 `ariaLabel` 换成 `text`（同时作无障碍名与 tooltip），残留旧版会让 usage pill 的无障碍名错位。取上游侧。
8. **`ui-sidebar-documentpreview` 的 `cx`/`Slider` 等 fork 组件在中文 README 缺失**：`ui-primitives` 的 `Slider` 行只有英文，补中文侧后两边一致。
9. **`packages/core/agent-loop/src/index.ts` 的 `SessionSeq` 变成未使用导入**：改 `applyConfiguredRoute` 合并后不再引用，删除。

## 生成物重生成顺序

```sh
pnpm run gen-persistence-catalog        # 会话目录 + persistence-schema.json + known-event-types.ts
pnpm run verify-persistence-formats --write
pnpm run gen-cordis-api                 # api-catalog.ts 与各子系统页的 cordis-surface 区
pnpm run gen-client-catalog             # slot-catalog.ts
pnpm run gen-tool-catalog
pnpm run gen-config-catalog
pnpm run gen-doc-graphs
pnpm run verify-translation-pairing --write <每个改过侧的文件>
```

`docs/persistence-changes/historical-formats/v4.schema.json` 是特例：它由 fork 用旧布局（schema 内联在 root/type 上）生成，而上游把持久化 schema 升级到 v2 布局（顶层 `nodes` 表 + 摘要前缀键）。用一次性脚本 `CanonicalSchema` → `encodePersistenceSnapshot` 重编码后才通过 `verify-persistence-formats`（63378 行压缩到 1036 行）。

## 验证结果

- `pnpm run typecheck`：5 个门禁全过。
- `pnpm run build:artifacts`：8 个门禁全过；`pnpm run build:check`：2 个门禁全过。
- `pnpm run test:docs`：21 个门禁全过（含 `verify-translation-pairing` 1147 对、`verify-md-links` 2336 文件、`verify-doc-budgets` 7 份）。
- 定向单测：`agent-loop`/`tools`/`app-boot`/`session-controller`/`official-bundles` 7381 条、`compaction-basic`/`client-modules`/`ui-conversation`/`ui-chat`/`plan-mode` 2248 条，全绿。
- Web 快照：41 个冲突相关用例 `DSH_SNAPSHOT=refresh` 重录后 replay 全绿（除下述两条预存项）。
- SDK/session 快照：`bash-tool`、`dynamic-tool-updates`、`tool-error-details`、`office-render-tools`（含 ptc）、`subagent-no-message-tool` replay 全绿。

## 分支与推送

合并先在 `develop` 验证，通过后快进 `master`（`git merge develop --ff-only`，无冲突），两分支均推送 `me`：`me/develop` 与 `me/master` 同指同一合并提交，本地与远端零差异。推送前的 typecheck 门禁（5 门）由 pre-push 钩子在两个分支上各复跑一次，均过。

## 预存问题（不是本次合并引入）

- `snapshots/web/fresh-round-trip/session.v5.jsonl` 的 `approval:policy` 仍是旧文案「Approval policy: ask」，fork HEAD 即如此；该 fixture 只能由 `DSH_SNAPSHOT=record`（需真实密钥）生成，`refresh` 不覆盖，因此 `apps/web/tests/default-workspace.e2e.ts` 的持久化回放用例在合并前后同样红。
- `apps/web/tests/turn-tail-actions.e2e.ts` 的 WebKit 触摸用例需要 Playwright WebKit 二进制，本机未安装。
- `pnpm run lint` 有 88 条既有红项（`tool-excalidraw`、`a2a`、`xingchen`、`CuaDriverInstall` 等 fork 自研文件），本次改动过的文件均无红项。

## 与既有知识的关系

- 沿用 [2026-09 合并决策](../decisions/2026-09-upstream-sync.md) 的「按来源取舍 + 生成物重生成」策略，本轮规模与冲突数创纪录（176 文件 / 441 块）。
- 补充该决策未覆盖的新情形：**上游把单调用接口改成批量接口**（`tools.execute`）、**给核心接口加必需成员**（`Agent.model`、`AgentRegistry` 注入）时，fork 自研包与其测试必须同步适配，否则 `typecheck` 直接失败——这是比快照差异更早、更可靠的信号。
- 生成物布局升级（持久化 schema v1→v2）不能靠脚本自然产出，需一次性重编码历史归档；已记入下方待跟进。
- fork 的宽度滑块设计（[会话内容宽度轴](../concepts/conversation-width-axis.md)）本轮再次被上游的拖拽手柄覆盖，CSS 已按 fork 侧恢复。

## 存疑或待跟进

- `docs/persistence-changes/historical-formats/v4.schema.json` 的重编码脚本是一次性的，未入库；若上游再次改布局，需要重新实现。可考虑把「历史归档布局升级」做成 `persistence-formats.ts` 的一个子命令。
- `pnpm run lint` 的 88 条既有红项未在本轮处理；`packages/core/pi-agent-loop/src/agent.ts` 的 `snapshotEvents` 已弃用未迁移，属技术债。
- Web 全量 e2e（208 个用例）单轮超过 20 分钟，本轮只跑了冲突相关子集；未覆盖的用例若因合并产生差异，需在具备 WebKit 与密钥的环境补跑。
