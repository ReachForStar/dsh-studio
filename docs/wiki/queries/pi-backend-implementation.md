---
title: pi 后端实现历程与去重/持久化修复（2026-09-05）
type: query
tags: [pi, agent-loop, session, persistence, translator, tools]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# pi 后端实现历程与去重/持久化修复（2026-09-05）

> 当前形态与配置见 [pi 后端](../entities/pi-backend.md)；本页保留实现分期、两次根因排查与遗留风险。

## 四个阶段

| 阶段 | 内容 | 当时遗留 |
| --- | --- | --- |
| 1 会话按 backend 路由 | `AgentBackend = 'dsh' \| 'pi'`；`SessionHeader`/`CreateSessionOptions.meta` 增 `backend`；JSONL header 往返支持；`SetFactory` 单例改 `Map<backend, slot>` | `SESSION_FORMAT_VERSION` 未 bump；resume 仍需上层显式传 backend |
| 2 `pi-agent-loop` POC | `PiLoopAgent implements Agent`（`followup→prompt`、`steer→steer`、`cancel→abort`；`inject` 为 no-op，`inbox` 空转）；`PiLoop` 经 `setFactory(this,'pi')` 注册 | pi 事件未回写 dsh log；resume 重建空 pi 会话；模型/工具未共享 |
| 3 事件对齐 | `PiEventTranslator`：`turn_start→turn/start`、`message_end(user/custom/assistant)→user/message\|assistant/message`、`text_delta/thinking_delta` 累积成 stream、`toolCall→tool/call`、`tool_execution_end→tool/result`、`turn_end→turn/end` | step 粒度粗（一个 pi turn = 一个 dsh step）；非 content 数组的工具结果退化为空文本块 |
| 4 模型与工具共享 | `openPiSession` 接受 `provider`/`modelId`；`adaptDshTool`（dsh→pi，走 `ToolRuntime.execute` 保留 dsh 校验）、`adaptPiTool`（pi→dsh）；`dshSchemaToTypeBox` 镜像常见 JSON Schema 形状（object/string/number/integer/boolean/array/enum/const/oneOf/json/null + description/title/default） | 复杂 TypeBox 联合/修饰符按需补 |

## 缺陷一：发送消息双显（回显永不退役）

- 根因：前端 `Session.prompt` 的乐观回显要等 durable `user/message` 带 `source.rpcId` 才退役，而翻译器产出的 `user/message` 只有 `source: { kind: 'user' }`，没有 `rpcId`；刷新后回显（内存态）消失，看起来「刷新后只剩一条」。pi 每轮注入的 custom（AGENTS.md/hook）也被折成 `user/message`，加剧噪音。
- 解法：`PiEventTranslator.setPendingUserSource` 把 dsh 请求 source（含 `rpcId`）原样带到翻译后的 `user/message`；跳过 `role='custom'` 的注入消息（不进会话 surface/log）。

## 缺陷二：重启后 pi 会话丢失（从不写 JSONL）

- 根因：dsh 循环创建会话时经 `sessionPersistence.create` 建写句柄落盘，而 `PiLoop.createAgent` 只 prepare + enter 内存 session，pi 会话连同 header 从未写入 JSONL；`resume` 也只是新开一个 fresh pi 会话。
- 解法：`createAgent` 在存在 `sessionPersistence` 时 `create(header)` 并把句柄交给 agent；agent 侧 `setOnAppended` 在每次翻译后把快照事件按序单飞批量 append，`flushDurable` 在 dispose 前冲刷；`resume` 改为 `open(id,'write')` 读历史、补中断闭包，把已打开句柄与历史游标直接交给 agent（不再二次 create）。

## 验证与遗留风险

- 端到端（stub pi 事件）：`turn/start → step/start → user/message → assistant/message → step/end → turn/end`，`user/message` 恰 1 条；mock 测试 13 → 17 全过；typecheck/lint 干净。
- 遗留：flush 依赖优雅退出时的 dispose，进程被强杀会丢最后一批（运行中增量 flush 未做）；测试池中「create 后立即 dispose」会让 worker 异常退出（仅测试现象）；pi 模型可见上下文（AGENTS.md/hook 注入）若要进 dsh log，应改用专门的 context/injection 事件而非 `user/message`。

（原始逐日记录见 git 历史：合并上游前的 `doc/2026-09-05-pi-backend-{stage1..4,fix2}.md`。）
