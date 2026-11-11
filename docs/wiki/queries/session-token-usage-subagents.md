---
title: 会话统计 Token 用量并入子会话消耗
type: query
tags: [ui-chat, stats, token, subagent, team, cost]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# 会话统计 Token 用量并入子会话消耗

## 问题

`conversation.composer.dock` 的 `usage` 胶囊只读当前会话的 `tokenUsage` 投影。`subagent` / `spawn_teammate` 派生的子代理在独立会话中记账，父会话投影不含这部分。

上游讨论 #12960 的实测对账（0.2.2-rc.1，44 次子代理模型调用）：

| 数据源 | calls | uncached | cacheRead | output | 合计 |
| --- | --- | --- | --- | --- | --- |
| 会话统计面板 / 父会话第 104 次 agent-loop | 104 | 457,844 | 12,778,624 | 106,933 | 13,343,401 |
| 子代理会话 `ab6046ca…` | 44 | 363,469 | 3,706,624 | 65,612 | 4,135,705 |

面板三个分项与单个 `sessionId` 的投影精确相等，子代理另占约 31%。`session-title` 的少量调用也不在面板内，见「未覆盖」。

## 根因

- `tokenUsage` 是单会话投影，父会话的 `assistant/message` 只累计自己的 LLM 调用。
- 会话列表已带降级关系：`projectionsBySession[parent].values.subagentCatalog` 给直接子级，`byId[child].parentId` 与 `origin: 'subagent'` 给已列出的子行。
- 胶囊原先只读 `useProjection('tokenUsage')`，没有读列表里的子会话行，所以统计口径停在父子边界。

## 解法

新增 `packages/client/ui-chat/src/client/chat/subagent-usage.ts` 的 `subagentUsage(list, rootId)`：

- 用父目录（`subagentCatalog`，跳过 `external`）与列表行的 `parentId` 两路建直连边，BFS 遍历所有层级。
- 已访问集合防止环与重复目录条目重复计费。
- 只累加子行 `projectionValues.tokenUsage` 中非零的活动；无用量行不计入 `sessions`。

`UsagePill` 改为：

- 合计父会话与全部子会话的分桶；胶囊读数、标题精确值、缓存命中与四个分桶行都用合计值。
- 子会话有活动时，在分桶行后增加 `其中子智能体（N 个）` 行，显示子会话仅自身的小计，明确它是合计的子集。
- 隐藏条件改为合计无活动，父会话零用量但子会话有活动时仍显示。

## 涉及模块

- `packages/client/ui-chat/src/client/chat/StatsPills.tsx`：`UsagePill` 与 `StatPillProps` 新增 `useSessions`、`sessionId`。
- `packages/client/ui-chat/src/client/chat/subagent-usage.ts`：纯函数遍历与合计。
- `packages/client/ui-chat/src/client/locale.ts`：8 个语种新增 `stats.dialog.subagents`。
- 测试：`tests/subagent-usage.client.spec.ts`、`tests/chat-stats.client.spec.tsx`，其余直接构造 `StatPillProps` 的用例补空列表桩。

## 验证

- `pnpm vitest run` 覆盖 ui-chat 四个相关测试文件：98 项通过；新增目录层级、外部子代理、零用量、环、普通父链接与无子级六个分支。
- `pnpm run test:gui`：803 个文件、13,820 项通过（2 项跳过）。
- `pnpm run typecheck`：client compiler 与 client aggregate 通过；host aggregate 在本轮被 `packages/experimental/agent-plugins` 既有 TS6307 阻断，与本次改动无关。
- 新增文件在 `packages/client/ui-chat/src/client/chat/*` 覆盖豁免范围内，不触发逐文件 100% 门禁。

## 未覆盖

- `session-title` 等独立模型调用不写入会话日志，`tokenUsage` 投影看不到，仍需在调用侧补记账才能进入统计。
- ui-polish 的统计浮层按工作区 `sessionIds` 聚合，不展开子代理目录；未挂到工作区的子会话仍不计入该卡片。见 [统计浮层（StatsFloat）](../entities/stats-float.md)。
- 子会话用量取自行投影块；从未读取过投影且未被宿主列出的子会话可能没有 `tokenUsage`，需要宿主在列表侧预热。

## 复发预防

新增任何「单会话」统计读数前，先确认它是否只覆盖当前 `sessionId`；涉及花费或 token 时，同时检查 `subagentCatalog` 与 `byId[].parentId` 两条父子来源，避免再次把局部用量当成总量。
