---
title: 统计浮层（StatsFloat）
type: entity
tags: [web, ui, cost, stats, workspace, budget, timeline, process]
created: 2026-09-17
updated: 2026-11-09
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
| `useSessions(s => s.byId)` | 各会话行的 `projectionValues` 与 `updatedAt` | 宿主 `api/session-controller` 的列表投影列 |
| `useWorkspaces` | 工作区 → `sessionIds` | `ui-workspace` |
| `accumulateCost`/`costBreakdown` | 费率卡计价 | `ui-polish/src/client/cost.ts`（卡来自 settings 键 `modelPricing`） |
| `settings` 键 `monthlyBudget` | 月度预算上限 | `ui-polish/src/background-settings.ts` |
| `/stats/process` | 宿主进程与系统采样 | `ui-polish/src/process-stats.ts`（host 半注册路由） |

## 扩展口径（2026-11-09）

- **总 token 与花费**：折叠态与展开态都在总额之外单列总 token（`stats.tokensTotal`），会话数来自工作区 `sessionIds`。
- **月度预算**：展开态显示本月估算花费与 `monthlyBudget` 的对比。当前会话按本月结算的助手消息计价（无结算消息时回退到实时投影）；其余会话在其列表行 `updatedAt` 落在本月时，把整份投影计入本月。预算为 `null` 或 `0` 时没有比例，也不判定超支。
- **当前会话 token 时间线**：`stats-timeline.ts` 把已结算助手消息按时间分桶，桶宽取 5 分钟 / 1 小时 / 1 天中最细且总数不超过 `MAX_BUCKETS = 24` 的一档；最后一桶的右边界是当前时刻。
- **各会话 token 与成本**：`session-usage.ts` 每会话一行；只有多于一个会话贡献时才显示，单会话时保留按模型拆分。
- **运行状态读数**：卡片展开期间每 2 秒请求一次 `/stats/process`，显示宿主进程 CPU（上次采样以来的区间占用）、常驻内存、运行时长，以及机器 1 分钟负载、核数与内存。收起后立即停止；组件卸载时 abort，且 abort 后不再写入失败态。
- **设置行**：General 设置新增 `polish-budget` 行（`BudgetRow.tsx`），数值输入在失焦或回车时提交，负数与非有限值被忽略并恢复已提交值，空值清除预算。

## 双 store 的预算同步

一个 store handle 只能挂在一个作用域：设置行挂在 root 作用域的 `settings.general.item`，统计浮层挂在会话作用域的 `conversation.composer.dock`。因此 `client/index.ts` 创建 `budgetRowStore` 与 `budgetDockStore` 两个 handle，共享同一写入者：`monthlyBudget` 只有一处赋值，`syncBudget()` 同时写入设置行的单一 bound actions 和 dock 按 `sessionId` 记录的 bound actions 映射。`budgetDockBounds` 用 `Map<sessionId, actions>` 而非数组，避免多会话重挂载时重复写入。

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
