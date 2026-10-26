---
title: 任务列表跨轮次消失与状态不回写（2026-10-27）
type: query
tags: [todo, 任务列表, 会话投影, turn/start, 生命周期, fork]
created: 2026-10-27
updated: 2026-10-27
sources: []
status: active
---

# 任务列表跨轮次消失与状态不回写（2026-10-27）

## 问题

用户反馈：任务完成之后列表一直在，但项目有时停在进行中/待处理，发下一条消息后整个列表消失。两个现象根因不同。

## 根因与修法

### 列表跨轮次消失

`todos` 投影在每次 `turn/start` 折成 `null`（`packages/todo/tool-todo/src/index.ts` 的 `apply` 里 `if (event.type === 'turn/start') return null`），依据上游决策 [todo-plan-clears-on-next-turn](../../../.agents/notes/archived/feature/2026-07-28-todo-plan-clears-on-next-turn.md)。用户发出下一条消息时新一轮 `turn/start` 立即把列表清空，表现为「整个不见了」。

修法：删除 `turn/start` 清空分支，列表跨轮次保留，直到模型下一次 `todo_write` 覆盖；`stateVersion` 2→3（折叠语义变化必须自增，见 session-projection 规则第 4 条）。测试 `projection.spec.ts` 的「下一轮清空」断言改为「跨轮次保留」。包 README 的会话投影段落同步更新。

### 状态停在旧值

状态只由模型调用 `todo_write` 全量重写才改变（`toTodoList` 强制整表替换）。模型只在开头写一次计划、完成后不回写，界面就一直停在旧状态。修法分两层：

- 保留跨轮次列表后，模型下一轮能看到未完成计划并继续推进，缓解了「每轮重新开始」导致的卡顿。
- 工具描述尾部追加纪律「轮次结束前调用一次 todo_write 回写当前状态」，提醒模型完成即回写。

## 边界

未做「自动按工具执行结果勾选完成」的机制：这需要新增模型可见的提示（`tools/post-execute` 的 `additionalContexts`）并新增 MessageSource kind，会触及持久化 schema 与变更记录流程，且勾选语义（哪个工具对应哪个条目）不可靠。当前以「列表不清空 + 描述纪律」解决可判定的生命周期缺陷，状态语义仍归模型所有。

## 验证

- `packages/todo/tool-todo/tests`：33 项通过（含改后的「跨轮次保留」断言）。
- typecheck 5 门全绿；改动文件 lint 清零。

## 涉及模块

- [`dsh-tool-todo`](../../../packages/todo/tool-todo/README.md)：`todo_write` 工具与 `todos` 投影。
- [session-projection](../../../packages/session/session-projection/README.md)：投影 `stateVersion` 与折叠语义。

## 复发预防

投影折叠语义变化必须同时自增 `stateVersion`，否则持久化的投影缓存行会以旧折叠结果被前向应用，产生与全量回放不一致的状态。跨轮次保留的 UI 状态，其「何时清空」应是显式的领域决策并写进页面，而不是借用轮次边界隐式清掉用户还在依赖的列表。
