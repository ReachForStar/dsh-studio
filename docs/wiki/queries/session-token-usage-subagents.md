---
title: 会话统计 Token 用量并入子会话与标题调用
type: query
tags: [ui-chat, ui-polish, stats, token, subagent, team, cost, session-title]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# 会话统计 Token 用量并入子会话与标题调用

## 问题

`conversation.composer.dock` 的 `usage` 胶囊只读当前会话的 `tokenUsage` 投影。`subagent` / `spawn_teammate` 派生的子代理在独立会话中记账，父会话投影不含这部分。独立模型调用（`session-title`）同样不计入任何会话统计。

上游讨论 #12960 的实测对账（0.2.2-rc.1，44 次子代理模型调用）：

| 数据源 | calls | uncached | cacheRead | output | 合计 |
| --- | --- | --- | --- | --- | --- |
| 会话统计面板 / 父会话第 104 次 agent-loop | 104 | 457,844 | 12,778,624 | 106,933 | 13,343,401 |
| 子代理会话 `ab6046ca…` | 44 | 363,469 | 3,706,624 | 65,612 | 4,135,705 |

面板三个分项与单个 `sessionId` 的投影精确相等，子代理另占约 31%。

## 根因

- `tokenUsage` 是单会话投影：父会话的 `assistant/message` 只累计自己的 LLM 调用，子代理在自己的 `sessionId` 中累计。
- 会话列表已带降级关系：`projectionsBySession[parent].values.subagentCatalog` 给直接子级，`byId[child].parentId` 与 `origin: 'subagent'` 给已列出的子行；小组件没有读这些行。
- ui-polish 统计浮层按工作区 `sessionIds` 聚合，而子代理通常不挂到工作区，范围同样停在父会话。
- 标题调用由共享执行器直接走 `ctx.llm`，只记录 `session/title-llm-request`，没有用量记录，`tokenUsage` 看不到。

## 解法

### ui-chat 胶囊

新增 `packages/client/ui-chat/src/client/chat/subagent-usage.ts` 的 `subagentUsage(list, rootId)`：

- 用父目录（`subagentCatalog`，跳过 `external`）与列表行的 `parentId` 两路建直连边，BFS 遍历所有层级。
- 已访问集合防止环与重复目录条目重复计费。
- 只累加子行 `projectionValues.tokenUsage` 中非零的活动；无用量行不计入 `sessions`。

`UsagePill` 改为：

- 合计父会话与全部子会话的分桶；胶囊读数、标题精确值、缓存命中与四个分桶行都用合计值。
- 子会话有活动时，在分桶行后增加 `其中子智能体（N 个）` 行，显示子会话仅自身的小计，明确它是合计的子集。
- 隐藏条件改为合计无活动，父会话零用量但子会话有活动时仍显示。

### ui-polish 统计浮层

`withSubagentSessions(sessionIds, rows, catalogs)` 先取工作区根，再沿同一组目录与 `parentId` 边展开全部子会话；外部子代理跳过，重复与环只保留一次。浮层的 token、花费、会话行、月度预算都改用展开后的范围，未挂到工作区的子会话也进入合计。

### 标题调用用量

- `session-title-llm` 新增日志事件 `session/title-llm-usage`，载荷为 `{ requestSeq, usage }`。
- 执行器在流结束时、以及终止结束原因失败时都写入该事件；用量与请求通过 `requestSeq` 关联，且独立于标题是否被接纳，被取代或失败的调用仍然计费。
- `tokenUsage` 投影把每条该事件直接加入合计；它没有轮次或步骤，不参与 `assistant/attempt` 的替换范围。
- 持久化确认记录：`docs/persistence-changes/2026-11-11-fork-paper-source-and-title-usage.md`（同时补记了此前未确认的 `paper-reader` 消息来源种类）。

## 涉及模块

- `packages/client/ui-chat/src/client/chat/StatsPills.tsx`、`subagent-usage.ts`、`locale.ts`。
- `packages/client/ui-polish/src/client/StatsFloat.tsx`、`session-usage.ts`。
- `packages/session/session-title-llm/src/index.ts`：用量事件与写入。
- `packages/llm/token-meter/src/usage-projection.ts`：用量折叠。
- 文档：两个包的 README、`docs/subsystems/session-title.md` 与持久化目录。

## 验证

- ui-chat 四个相关 spec：98 项通过；覆盖目录层级、外部子代理、零用量、环、普通父链接与无子级。
- ui-polish 两个 spec：39 项通过；`session-usage.ts` 与 `StatsFloat.tsx` 分支、语句、函数、行覆盖均为 100%。
- `session-title-llm`、`token-meter`、`session-title`、核心 session 与格式包：61 个文件、1,230 项通过；两个改动文件覆盖 100%。
- `pnpm run test:gui`：803 个文件、13,824 项通过（2 项跳过）。
- `pnpm run typecheck`：host compiler 与 client compiler 通过；host aggregate 被并行开发的 `packages/boot/agent-plugins` 与 `tool-search` 阻断。
- `verify-persistence-changes`：69 个根、28 条历史记录一致；新增记录与生成目录通过 `verify-formats` 类别检查。
- 文档：`verify-type-equiv` 仅剩并行开发留下的 `worktrees.md` 漂移；`verify-md-links` 仅剩并行开发的 `tool-search/README.zh.md` 锚点。

## 未覆盖

- 从未被投影过的会话（含子会话）不贡献数值；宿主需要在列表侧预热 `tokenUsage`。
- 外部子代理没有本地会话行，无法取得用量。
- 适配器不上报 `usage` 的标题调用仍然没有可记录的数字。

## 复发预防

新增任何「单会话」统计读数前，先确认它是否只覆盖当前 `sessionId`；涉及花费或 token 时，同时检查 `subagentCatalog` 与 `byId[].parentId` 两条父子来源。新增独立模型调用时，必须在调用侧记录用量事件并由 `tokenUsage` 折叠，不能依赖对话轮次内的 assistant 消息。
