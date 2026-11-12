---
title: step-summary 工具批次摘要
type: entity
tags: [摘要, 快模型, 会话事件, 展示数据]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# step-summary（工具批次摘要包）

## 职责

为每个已完成步骤的工具批次生成一行摘要：`step/end` 且批次至少含一次工具调用时发起一次辅助模型请求，接受的回复以最新覆盖的 `tool/batch-summary` 事件记入日志，仅用于展示，永不进入模型可见表面。

## 关键文件

- `packages/experimental/step-summary/src/index.ts`：事件声明、Config、`collectToolBatch` / `renderBatchInput` / `normalizeSummary` / `requestSummary`、`apply`。
- 持久化记录：`docs/persistence-changes/2026-11-11-tool-summary.md`（同一记录覆盖了 memory-notes 的 `memory-notes` 来源种类与本次 `tool-summary` 来源种类、`tool/batch-summary` 事件根）。

## 设计决策

- **增量累积，不读历史**：`session.snapshotEvents()` 等同步历史读取已弃用（Agent Note 2026-09-09），插件在 `session/event` 投递中累积 `tool/call` 与 `tool/result`，`step/end` 时消费并清理；恢复后只需新到达的事件即可继续工作。
- **最新覆盖事件而非模型输入**：摘要属于展示数据，写成 log-only 事件，客户端可在恢复后重建同一行。
- **幂等与并发**：`inFlight` 集合按 `turn:step` 去重，重复投递的 `step/end` 不会二次请求；重复 `callId` 只保留首次记录。
- **失败不打断**：辅助请求失败或超时只 `ctx.logger.warn`，不写事件、不改动对话。
- **包名避开 `tool-` 前缀**：`gen-tool-catalog` 把 `tool-*` 视为工具包并要求进入 `TOOL_PACKAGES`，本包无工具定义，故命名 `step-summary`（事件名仍为 `tool/batch-summary`）。

## 验证

17 个测试、src 逐文件 100%（语句 110/110、分支、函数、行）；`doc-sync` 43 项通过；持久化记录 `ok: true`（70 个根匹配 29 条历史记录）。

## 待确认

- Web 客户端卡片尚未消费该事件。
- 是否需要重试、结果脱敏与跨步骤合批。
