---
title: 总线任务在 A2A 面查不到（a2a-bridge 实测）
type: query
tags: [a2a, kafka, 总线, bridge, 实测]
created: 2026-09-20
updated: 2026-09-20
sources: []
status: active
---

# 总线任务在 A2A 面查不到（a2a-bridge 实测）

## 问题

经 Kafka 总线（`a2a.task`）派给 bridge 网关的任务能正常执行、事件流也能收到终态，但随后用 `GetTask` 查同一个 taskId 得到 `-32001 Task not found`，`ListTasks` 里也没有这条任务。

## 复现（2026-09-20，本机）

1. bridge 三网关在线（`npm run start:cc` 等），Kafka 三 broker 在线（WSL docker）。
2. 用 **bridge 自己的 CLI** 投递总线任务：`node cli/dispatch.mjs --to claude-code --skill code-review --input "只回复两个字：桥通" --mode bus --wait` → 输出 `桥通` 与 `TASK_STATE_COMPLETED`。
3. 立刻 `curl -X POST http://127.0.0.1:9320/ -d '{"jsonrpc":"2.0","id":"g","method":"GetTask","params":{"id":"<上一步 taskId>"}}'` → `{"error":{"code":-32001,"message":"Task not found: <id>"}}`。
4. 同期 `ListTasks` 只列出**直连通道**建的任务（例如先前用 `SendStreamingMessage` 建的那条），总线任务不在其中。

## 结论

这条差异与 harness 侧实现无关：**bridge 自己的 CLI 走同一条总线也查不到**，而 bridge 的 `packages/cc-gateway/src/server.ts` 在消费者里确实调了 `server.attachTask(...)`（注释也写明「总线任务也落 A2A 任务表：GetTask/ListTasks 可见」）。现象与其设计意图不符，属 bridge 侧待查项（可能是任务表被重启清空、或该消费者实例与处理 HTTP 的实例不同）。

## 影响

- harness 侧 `dispatch({ mode: 'bus' })` 不依赖 `GetTask`：它靠 `a2a.event` 的终态事件收尾，因此**不受影响**（`dispatchOverBus` 不查任务表）。
- `mode: 'direct'` 的 `GetTask` 复核（`settled()`）在直连通道下有效；若对端查不到任务则回退到流内快照，不会把已完成的答案变成失败。
- 若要按 taskId 追总线任务的历史，目前只能看 `a2a.event`（可回放）或对端日志。

## 复发预防

对接 bridge 时，验证「任务可见性」必须分别覆盖两条通道：直连建的任务用 `GetTask` 复核，总线任务用事件流复核；不能假定两者共用任务表。

## 涉及模块 / 关联页面

- [A2A 栈](../entities/a2a-stack.md) · [星域多智能体协作](../entities/xingchen-multi-agent.md)
- bridge 侧：`packages/cc-gateway/src/server.ts`（`attachTask`）、`packages/shared/src/a2a.ts`（`TaskStore.ensureTask` / `GetTask`）
