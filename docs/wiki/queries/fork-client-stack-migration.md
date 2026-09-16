---
title: fork 客户端栈迁移到上游框架（2026-09-03）
type: query
tags: [client, migration, slots, ui-polish, ui-ssh, tsconfig, doc-gates]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: superseded
---

# fork 客户端栈迁移到上游框架（2026-09-03）

> 本页是 2026-09-03 的 fork 自研客户端栈退役记录；其产品结论已并入 [合并上游决策](../decisions/2026-09-upstream-sync.md)，实现细节由本节保留。

## 问题

fork 曾自带一套客户端框架（`packages/client/runtime`：`ClientContext`、`createSnapshotStore`、自研会话转录模型 `ChatNode`、`ctx.conversationEvents`），与上游新的客户端栈（cordis `Context`、`dsh-client-store`、`ctx.uiConversation`、slot 注入的 `useSession/useWorkspaces`）不兼容。目标方案是彻底迁移（阶段 B），逐面板推进，最终退役自研 runtime。

## 根因与结论

- 上游 `ConversationSnapshot` 只有 `views`/`activeTargets`，**没有** fork 的 `chat.nodes` 树；但 ui-chat 的 `ChatSnapshot.legacy.nodes` 提供了同形状的 `ConversationNode[]`，可直接替代。
- 上游 `AssistantMessageNode` 原生带 `usage`、`requestConfig: { provider, model }`、`timing`、`messageId`、`time`/`turn`；`ToolResultNode` 带 `time`/`callTime`。fork 的「上游节点无 model id」前提不成立 → 为定价而生的 `model-index.ts`（`createModelIndex` + `ctx.uiConversation.events.register` + spec）整体删除，StatsFloat 改用 `useConversation(s => s.views.get('chat')?.legacy.nodes)` + 每节点 `requestConfig?.model`。
- fork 的 `settled-diffs.ts` 删除：无运行时消费者，且 diff 卡语义只在上游 host 端 tool-fs presentation 表达。
- 上游 `WorkspaceListState` 无等价物：三个面板（Git/Excalidraw/MutationDiff）改用 `api-workspace-controller` 的 `WorkspaceView`，数据经 slot 注入的 `useSession/useWorkspaces` 取得。

## 解法（已执行）

1. 9 个自研包改名 `@reachforstar/*`（保留 `dsh-` 前缀）：`dsh-ssh`、`dsh-ssh-local`、`dsh-tool-ssh`、`dsh-host-ssh-remotes`、`dsh-subagent-pi`、`dsh-tool-excalidraw`、`dsh-client-ui-polish`、`dsh-client-ui-ssh`、`dsh-client-runtime`。改 tsconfig 别名 + pnpm-lock，不依赖全仓 sed。
2. 面板迁移到上游槽位与 store：`ClientContext` → cordis `Context`；`createSnapshotStore` → `@deepseek-ai/dsh-client-store`（签名兼容：`init` + `.update(draft)`）；`ctx.slots` 增广来自 `@deepseek-ai/dsh-client-ui-renderer/client`。
3. 4 个 ui-polish 测试 spec 按上游夹具重写（`useSession` 现为 ui-session 的 `SessionSnapshotSelector`；assistant 夹具带 `requestConfig.model`，`ToolResultNode` 去掉 `callView/resultView`）。
4. 退役 `packages/client/runtime`：删包 + 依赖 + tsconfig 引用 + `dsh.client.inject` 条目 + `tsconfig.base.json` 别名 + lockfile；`index.ts` 的 inject 收敛为 `['slots','locale','settingsScope']`。

## 两条至今有效的 tsconfig 约定

- 跨包消费上游生成的 typert 客户端类型，别名指向 **lib 产物**：`@reachforstar/dsh-host-ssh-remotes/remote` → `packages/host/ssh-remotes/lib/typert.remote-client.d.ts`（由 host 面 tsdown 生成，client 面 tsc 在之后运行）。
- 消费方包若 import 另一个包的**声明产物**（如 `.../types` → `lib/types/types.d.ts`），必须在 `tsconfig.host.json` 中显式 `references` 该包，否则 `tsc -b` 不保证先构建它（详见[Windows 门禁踩坑](windows-merge-gates.md)）。

## 复发预防

- 迁移期间「host/client 双面 Context merge」冲突的测试文件（如 `apps/web/tests/*.e2e.ts`）在 `apps/web/tsconfig.json` 的 `exclude` 中，不进 typecheck；其正确性由 vitest 转译运行验证。
- 面板数据源若依赖「节点带模型/用量字段」，先查上游 `contract/records.ts` 的节点定义，不要再造索引层。

（原始逐日记录见 git 历史：合并上游前的 `doc/2026-09-03-dsh-studio-upstream-migration.md` 与 `doc/2026-09-04-doc-sync-fixes.md`。）
