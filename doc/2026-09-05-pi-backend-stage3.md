# 2026-09-05 pi 后端接入（阶段 3）：事件对齐

## 任务目标

让 pi 驱动会话的 turn/step/message/tool 事件进入 dsh 的 `SessionEventMap`，使 dsh 的 subagent/plan/projection/UI 能像读 dsh 会话一样读 pi 会话。

## 干了什么

- 新增 `src/pi-event-translator.ts` — `PiEventTranslator`：
  - 订阅 pi `AgentSession` 事件流，翻译成 dsh `Session.append` 事件。
  - `turn_start`→`turn/start`；`message_end(user/custom)`→`user/message`；`message_end(assistant)`→`assistant/message`（含 usage/stream）；`message_update` 的 `text_delta`/`thinking_delta` 用 `AssistantStreamAccumulator` 累积成 stream；assistant 里的 `toolCall`→`tool/call`；`tool_execution_end`→`tool/result`（`sourceEventSeqs` 指向对应 `tool/call`）；`turn_end`→`turn/end`。
  - step 边界取粗粒度：一个 pi turn 映射成一个 dsh step（多步模型调用的事件仍按序记录，仅 step 切分后置）。
  - pi `custom` 上下文消息（项目 AGENTS.md / skill 内容）记录为 `source.kind: 'plugin'` 的 `user/message`。
- `src/agent.ts`：`PiAgentSessionLike` 增加 `subscribe`；`PiLoopAgent` 构造时新建 `PiEventTranslator` 并订阅 pi 事件流。
- `src/index.ts`：导出 `PiEventTranslator`。

## 验证结果

- 单测 `translator.spec.ts`：文本单轮 → `turn/start, step/start, user/message, assistant/message, step/end, turn/end`；工具轮 → 额外 `tool/call, tool/result`。2 tests 通过。
- `agent.spec.ts`（mock）4 tests 通过；全量 `pi-agent-loop` 6 tests 通过。
- 真实 e2e `pi-loop.e2e.ts`：`PiLoop` 驱动 pi（AMAX 网关）跑 `ls`，断言 dsh session log 含 `turn/start/user/message/assistant/message/step/end/turn/end`。通过。
- `oxlint`、`tsc -b`、pre-push 全量 typecheck 均通过。

## 改了什么（相对历史）

- 提交 `627b73cce8`，7 files changed，+458，推送到 fork master。

## 已知问题与风险

- **step 粗糙**：一个 pi turn 映射成一个 dsh step；pi 的多步（多模型调用）turn 不会切分成多个 step。够 subagent/plan/projection 消费，但不是精确的 step 语义。
- **tool/result 内容归一化粗**：非 `content` 数组的 pi 工具结果退化为空文本块，lossless 工具卡片留到阶段 4。
- stream 累积只覆盖 text/thinking delta，不含 toolcall delta 的精确记录。

## 后续演进方向

- 阶段 4：共享模型（pi 会话走 dsh 的 `ctx.llm`/`agentOptions` 路由）与工具（dsh 工具注册成 pi customTools，pi 工具进 `ctx.tools`）。