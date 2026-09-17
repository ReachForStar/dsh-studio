---
title: 统计浮层（StatsFloat）
type: entity
tags: [web, ui, cost, stats, workspace]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# 统计浮层（StatsFloat）

## 职责

`packages/client/ui-polish/src/client/StatsFloat.tsx`：`conversation.composer.dock` 项，以 `position: fixed` 钉在视口右上角，折叠态显示一条摘要、点击展开完整读数。

## 口径（2026-09-17 起）

- **会话计时**（轮/步/LLM 时长/工具时长/TTFT）：当前会话，来自 `sessionStats` 投影（无该投影时回退为窗口内节点折叠 `windowStats`）。
- **token 与花费：当前工作区全部会话**。工作区经 `useWorkspaces` 由当前会话反查；每个会话的 token 取其**会话列表行**携带的 `tokenUsage` 投影值（宿主为列表会话投影，含未打开的），当前会话改用实时投影。
- **花费按会话计价**：本客户端持有已结算消息的会话按每条消息的模型与结算时间逐条计费（分时/按长度分档模型各自取档）；其余会话按分桶总量以费率卡 `default` 估算——线上 `tokenUsage` 投影只带分桶总量，没有模型归属，因此按模型拆分行仅在单会话参与时显示。

## 关键数据源

| 来源 | 内容 | 位置 |
| --- | --- | --- |
| `useProjection('tokenUsage')` | 当前会话实时分桶 | `packages/llm/token-meter/src/usage-projection.ts`（`wire` 视图） |
| `useSessions(s => s.byId)` | 各会话行的 `projectionValues` | 宿主 `api/session-controller` 的列表投影列 |
| `useWorkspaces` | 工作区 → `sessionIds` | `ui-workspace` |
| `accumulateCost`/`costBreakdown` | 费率卡计价 | `ui-polish/src/client/cost.ts`（卡来自 settings 键 `modelPricing`） |

## 待确认

- 从未被投影过的会话（从未打开）不贡献数值，工作区总量可能少算；是否要在列表侧为全部会话预投影由宿主决定。

## 关联页面

- 宽度轴见 [会话内容宽度轴](../concepts/conversation-width-axis.md)。
- 决策与后果见 Agent Note `.agents/notes/implemented/feature/2026-09-17-workspace-scoped-stats-card.md`。

## 视觉分层（2026-09-17 改版）

- 收起态是一枚胶囊：总额为主，后跟 token 三段（`输入 100 / 输出 5 / 缓存 90`）；没有花费时胶囊以第一段 token 取代空位，若连用量都没有则回退到第一组文字统计。
- 展开态四层：标题行（`当前工作区` + 会话数 + 收起提示）→ 总额主视觉（24px，tu­bular-nums）→ 输入/缓存/输出占比条 + 图例（各带精确金额）→ token chips → 按模型行（名称 + 占比条 + 小计）→ 计时/命中率等最安静的一行。
- 占比条与模型占比条是装饰（`aria-hidden`），精确数字始终以文本呈现，因此配色不承载信息；三档用同一品牌色的 100% / 55% / 30% 混合，避免引入新色值。
- 卡片可键盘操作（`role="button"` + `tabIndex` + `aria-expanded` + `focus-visible` 描边），Enter/空格切换展开。
- 数据口径未变：仍是「当前工作区全部会话」的 token 与花费聚合。

## 相关

- [文档面板的编辑与保存](document-panel-editing.md) 同属本轮 fork 改动。
