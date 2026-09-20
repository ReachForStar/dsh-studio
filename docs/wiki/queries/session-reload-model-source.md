---
title: 会话重载校验报错：assistant/message 空 model 来源（2026-09-24）
type: query
tags: [session, validation, pi, migration, model-source]
created: 2026-09-24
updated: 2026-09-24
sources: []
status: active
---

# 会话重载校验报错：assistant/message 空 model 来源（2026-09-24）

> 现象：重开 pi 会话（及部分更旧会话）时报 `message must have model source`，页面像卡住。当前 pi 后端形态见 [pi 后端](../entities/pi-backend.md)。

## 问题

本地 `~/.dsh/sessions` 下多个 pi 会话（v3 直写）与更旧会话（v2）重开失败，报错来自 `packages/core/session/src/index.ts` 的 `assertMessageEventShape`：`assistant/message` 的 model 来源要求 `provider`/`model` 非空，但实际数据是 `source: {kind:'model', provider:'', model:''}`。

## 根因（三层，非迁移引入）

- **加载侧校验过严**：`assertMessageEventShape` 对 `assistant/message` 要求 `source.kind==='model'` **且** `hasProviderModel`（provider/model 非空）。后者来自上游 2026-09 收紧校验的 `fix: enforce message snapshot invariants` 提交，意图是让模型归属可统计。
- **写入侧记空**：pi 后端 `packages/core/pi-agent-loop/src/pi-event-translator.ts` 生成 `assistant/message` 时硬编码 `source:{provider:'',model:''}`——pi 明知模型却记空。
- **迁移忠实搬运**：v2→v3 迁移（`session-format-v2-to-v3`）不回填 provider/model，原样保留空值。旧 v2 日志本就带空 source，迁移不是引入者，只是搬运。

即：空 source 是 pi 后端与旧版本写入的，校验在上游收紧后把这类数据挡在了加载门外。

## 解法（两层）

1. **加载侧放宽**（`packages/core/session/src/index.ts`）：`assistant/message` 只保留 `kind==='model'` 这一承重校验，provider/model 允许为空，语义为「未知模型」（legacy / 未跟踪模型的后端）。`hasProviderModel` 仍用于 seed `request/header`（调用方必须指明模型，保持非空）。下游 `turn-usage` 对空 provider/model 本就优雅返回 `undefined`，无崩溃。
2. **写入侧记真实模型**（`packages/core/pi-agent-loop`）：把 `PiLoop.launch` 解析出的模型路由（`this.model` 或 `agentOptions.provider/model`）经 agent 传入 `PiEventTranslator`，`assistant/message` 写入真实 `provider`/`model`。路由未设（pi 自选默认模型）时仍记空，由放宽后的校验接受为「未知模型」。

## 验证

- 单测：session + pi-agent-loop 共 522 通过（含 2 个新回归：空 provider/model 的 model 来源应通过；带模型路由时 assistant source 写入真实 provider/model）。typecheck 通过。
- 真实数据：本地 48 个会话文件、5502 事件逐条跑 load 校验，**model-source 失败归零**。其余 6 处 `request/header` 报 `must omit header.system` 是绕过迁移的假阳性——v2 的 `header.system` 由迁移（`migration.ts` 剥离并提升为 `system/message`）处理；已迁移的 v3 伴生文件均 0 失败，印证迁移路径正常。

## 涉及模块

- `packages/core/session`（校验放宽）
- `packages/core/pi-agent-loop`（翻译器记模型：`pi-event-translator.ts` / `agent.ts` / `index.ts`）
- `packages/session/session-format-v2-to-v3`（确认迁移不回填、搬运空值）

## 复发预防

- 新 pi 会话（显式设模型路由时）写入真实 provider/model，不再产生空 source。
- 「空 provider/model = 未知模型」成为合法状态，legacy 数据可加载，无需回填或改数据。
- 若未来新增后端也记空 model source，放宽后的校验会接受（未知模型），不会再次阻塞加载；但统计/计价维度会归入「未知」，建议后端尽量记真实模型。
