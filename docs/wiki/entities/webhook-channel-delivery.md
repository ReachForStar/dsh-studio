---
title: webhook 活跃会话投递（WebhookMessageRequest）
type: entity
tags: [webhook, 通道运行时, 投递, 活跃会话]
created: 2026-11-12
updated: 2026-11-12
sources: []
status: active
---

# webhook 活跃会话投递（WebhookMessageRequest）

## 职责

`packages/api/webhook` 是把外部事件变成实际工作的规则运行时。原有动作只有「新建 Workspace 会话」；本页记录新增的第二个动作：把一条消息投递到**已经活跃的会话**，对应 qwen-code 通道运行时的「投递」角色。

## 关键文件

- `packages/api/webhook/src/types.ts`：`WebhookAction = WebhookSessionRequest | WebhookMessageRequest`。`WebhookMessageRequest` 要求 `sessionId`、`prompt`、`target`（`next-turn` | `next-step`）；`WebhookSessionRequest` 增加可选 `kind?: 'session'` 作为判别式。
- `packages/api/webhook/src/message.ts`：`deliverWebhookMessage`。校验请求 → `ctx.agents.get(sessionId)` → 组 `createUserMessage`（沿用 `webhook` 来源种类）→ `target === 'next-step' ? agent.steer : agent.followup`。
- `packages/api/webhook/src/index.ts`：`dispatch` 分支在 `request.kind === 'message'` 时走投递，否则走原有会话创建。

## 设计决策

- **不改核心**：投递到活跃会话不需要新的准入接缝——`Agent.followup()` 排队下一轮、`Agent.steer()` 向运行中的轮次插入引导都已是公开接口。
- **复用来源种类**：投递消息沿用既有 `webhook` 来源种类（provider / source / deliveryId / ruleId / form / summary），因此本条不需要新的持久化记录，模型的可见来源与新建会话时一致。
- **目标是活跃会话**：`agents.get()` 取不到 Agent 即报错，运行时会记录告警；需要同时处理离线会话的规则应改返回 `WebhookSessionRequest`。
- **不去重**：运行时不留交付 id 状态（既有契约），重复投递会重复追加；去重由规则自持。

## 通道运行时三角色的落点

| 角色 | 当前落点 | 状态 |
| --- | --- | --- |
| adapter（外部协议 → 归一事件） | 适配器包 + `VerifiedWebhookDelivery` | 已有（`webhook-github` 是唯一实现） |
| routing（选择目标会话） | 规则回调自行决定（返回哪个 `sessionId` 或新建） | 规则自持，未泛化为服务 |
| delivery（投递到会话） | `WebhookMessageRequest` → `followup` / `steer` | 本次实现 |

## 与 qwen-code 的差异

qwen 有 `sessionScope` 四档、`sessionRotation`、`messageRoutes` 前缀路由与 `groupHistoryLimit` 群聊回填；这些属于路由层的产品功能，本实现只提供投递原语与判别式，路由策略留给规则。`dispatchMode`（`steer` / `collect` / `followup`）与本实现的 `target` + 既有 Inbox 边界同构，但 `collect`（等当前轮结束后合并投递）没有对应实现。

## 验证

webhook 包 82 个测试全通过（`message.spec.ts` 5 个覆盖 followup/steer 分支、无活跃 Agent、请求校验、取消；`runtime.spec.ts` 增加 dispatch 到活跃会话的用例；`session.spec.ts` 增加 `kind` 校验），src 逐文件 100%（语句 151/151、分支 94/94、函数 26/26、行 141/141）；lint、`doc-sync` 43 项通过。

## 待确认

- 路由层（会话作用域、轮换、前缀路由）未实现，规则必须自己选目标。
- `collect` 语义（等当前轮结束再合并投递）未实现。
- 投递是即发即忘：运行时不等待目标轮次完成，也没有回执。
