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
- `packages/experimental/speculation/src/overlay.ts`：`OverlayFileSystem`（`FileSystem` 代理）：读取先探测 `<overlayRoot>/<相对路径>`，所有变更落到 overlay，按产出的路径集合 `commit` / `discard`。

## 设计决策

- **写入门槛默认关闭**：`allowWrites` 默认 `false`，任何推测写入都不执行；dsh 没有 qwen 的 `auto-edit`/`yolo` 审批枚举，改由显式配置表达「用户已同意无人值守编辑」。
- **越界即 boundary**：`overlayPath` 只映射仍位于 `workspaceRoot` 内的路径，`..` 或绝对外部路径直接 boundary，不做部分包含的近似判断。
- **未知工具保守**：MCP 与自定义工具一律 boundary；外部网络工具在固定集合中，配置无法放开。
- **纯函数门控 + 独立代理**：门控不执行 I/O；overlay 代理自建独立 Cordis 上下文注册服务，避免与企业 `ctx.fs` 冲突，运行方按需把代理交给推测会话。
- **提交按产出清单**：代理记录自己写过的 overlay 路径，`commit` 只把这些文件读回并写入工作区对应路径，`discard` 只删除这些文件，不会牵动 overlay 中的其他内容。

## 与 qwen-code 的差异

qwen 的门控含 shell 命令 AST 安全分类与审批模式枚举；dsh 目前不做 shell 分类（一律 boundary），写入许可改为显式配置。overlay 代理已实现（读优先 overlay、`commit` 提交、`discard` 丢弃）；提交时不做版本冲突检测，也没有界面。

## 验证

24 个测试（门控纯逻辑 13 个 + overlay 代理 11 个，后者用真实临时目录与 `dsh-fs-local`），src 逐文件 100%（语句 113/113、分支 64/64、函数 31/31、行 96/96）；`doc-sync` 43 项通过；本包不新增会话事件，无需持久化记录。

## 待确认

- 推测触发（从用户意图生成计划并驱动一次推测运行）仍未实现。
- 提交缺少版本冲突检测：`commit` 直接覆盖工作区文件。
- shell 只读分类是否需要移植。
