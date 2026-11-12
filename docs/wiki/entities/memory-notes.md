---
title: memory-notes 记忆笔记包
type: entity
tags: [记忆, 上下文来源, 注入, MEMORY.md]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# memory-notes（记忆笔记包）

## 职责

读取写入在磁盘上的持久记忆笔记（`MEMORY.md`），在每一步 pre-step 注入模型可见表面：用户全局层 `<dsh home>/memory/MEMORY.md` 在前，项目层（最近的含根标记目录）在后，共享 `maxChars` 字符预算。来源为仅归因的 `user/message`（kind `memory-notes`），因此无需会话格式代际（`@persistenceAttribution` 约定，同 paper-reader 先例）。

## 关键文件

- `packages/context/memory-notes/src/index.ts`：`apply` 注册单一 `agent/pre-step` 监听，委托给导出的纯函数 `applyPreStepMemory`；含 `MessageSourceMap` 的 `memory-notes` kind 声明。
- `packages/context/memory-notes/src/files.ts`：`findProjectRoot`（向上查找根标记）、`discoverMemoryFiles`（用户层+项目层按序）、`loadMemoryFiles`（共享预算、截断标记 `\n…(truncated)`）、`boundMemoryContent`。
- `packages/context/memory-notes/src/config.ts`：`memoryFileNames`（默认 `['MEMORY.md']`）、`projectRootMarkers`（默认 `['.git']`）、`maxChars`（默认 20000）；`userMemoryDirectory()` 用 `dsh-home-paths` 解析。

## 设计决策

- **每次 pre-step 重读**：无投影状态、无 watcher；文件小所以读取廉价，天然覆盖编辑更新与删除（幂等：内容+来源相同则 no-op，变化则替换，消失则移除）。
- **折叠位置**：注入消息放在被认领批次之后（直接提示前置，运行时上下文后置），与 agent-instructions 一致。
- **`agent/pre-step` 接线薄**：核心逻辑抽为可直测的 `applyPreStepMemory(ctx, agent, decision, claimed, config, signal)`；瀑布派发需要插件 ctx 与 agent 载体同属一个 harness ctx（独立 Context 上注册监听无法收到 waterfall）。

## 与既有页面关系

- 复用 `agent/pre-step` 瀑布契约（`packages/context/agent-instructions` 同款机制）与 attribution-only source kind 模式。
- 与 qwen-code 记忆层的对照见 [qwen-code 能力对比](../queries/qwen-code-capability-comparison.md)：本包只做「写入文件的注入」，qwen 的自动提取/后台清理/预算折叠、`pinned/`、团队记忆均未实现。

## 验证

21 个测试（预步集成走真实 waterfall 派发、直调纯函数覆盖不依赖派发的分支）、src 逐文件 100% 语句/分支/函数/行、lint、聚合 typecheck、`doc-sync` 43 项通过。

## 待确认

- 是否进入官方 bundle 与默认 `maxChars` 预算。
- 是否需要提取工具、后台 subagent 与按条目预算（qwen 为 200 行 / 25000 UTF-16 单元、整条超预算跳过）。