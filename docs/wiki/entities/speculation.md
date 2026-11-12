---
title: speculation 推测执行门控
type: entity
tags: [推测执行, 门控, overlay, 安全]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# speculation（推测执行门控）

## 职责

决定推测运行（用户输入前预执行）中每个工具调用的处置：只读工具 `allow`；文件写入在策略允许时 `redirect` 到 overlay 路径；其余一律 `boundary` 停止推测。纯逻辑模块，不触碰文件系统。

## 关键文件

- `packages/experimental/speculation/src/index.ts`：`Config`（`workspaceRoot` / `overlayRoot` / `allowWrites` / 工具与路径键覆盖）、`gateToolCall`、`gatePlan`、`overlayPath`、`rewriteArguments`、`resolvePolicy`、`BOUNDARY_TOOLS`。

## 设计决策

- **写入门槛默认关闭**：`allowWrites` 默认 `false`，任何推测写入都不执行；dsh 没有 qwen 的 `auto-edit`/`yolo` 审批枚举，改由显式配置表达「用户已同意无人值守编辑」。
- **越界即 boundary**：`overlayPath` 只映射仍位于 `workspaceRoot` 内的路径，`..` 或绝对外部路径直接 boundary，不做部分包含的近似判断。
- **未知工具保守**：MCP 与自定义工具一律 boundary；外部网络工具在固定集合中，配置无法放开。
- **纯函数**：门控不执行任何 I/O，运行方可在不启动作业的前提下测试自身安全策略。

## 与 qwen-code 的差异

qwen 的门控含 shell 命令 AST 安全分类与审批模式枚举；dsh 目前不做 shell 分类（一律 boundary），写入许可改为显式配置。overlay 文件系统代理与「接受即提交」尚未实现。

## 验证

13 个测试、src 逐文件 100%（语句 45/45、分支 42/42、函数、行）；`doc-sync` 43 项通过；本包不新增会话事件，无需持久化记录。

## 待确认

- overlay `FileSystem` 代理（读优先 overlay、接受后提交回工作区）与推测触发（从用户意图生成计划）仍未实现。
- shell 只读分类是否需要移植。
