---
title: 工具检索（dsh-tool-search）
type: entity
tags: [工具面, 延迟加载, 上下文成本, 实验包]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# 工具检索（dsh-tool-search）

## 职责

给模型一个找回不在视野里的工具 schema 的入口。`tool_search` 按关键词搜索调用方智能体可见的工具，或按精确名称取回一个，返回名称、描述与参数 schema；模型随后直接调用该工具。落点 `packages/experimental/tool-search/`，`inject: ['tools']`。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `searchTools`（关键词与精确名匹配、排序、截断）、`renderCatalog`（Markdown 结果块）、`createToolSearchTool`（工具定义与参数/输出 schema）、`apply`（注册到 `ctx.tools`） |

## 上下游与接缝

- 可见性来自 `ctx.tools.definitions(exec.agent)`：与执行器解析同一个分层注册表，限制与作用域同名影子对检索结果的影响与对可调用集合一致。
- 工具 schema 用 `projectToolSchema(definition, true)` 投影，避免直接把注册期定义暴露出去。
- `Config`：`maxResults`（最小 1，默认 8）、`descriptionMaxLength`（最小 40，默认 240），越界在加载时报错。

## 边界

- 只返回 schema，不代调用；是否把延迟工具交回即时工具面由 `deferLoading` 与 profile 配置决定。
- 匹配是子串匹配，不是语义检索。
- 只按条数限流，单个超大 schema 仍可能主导一次结果。
- 无匹配时返回一句说明，不报错。

## 与 qwen-code 的关系

对应 qwen-code `packages/core/src/tools/tool-search.ts` 与其 `tools.eager` / `tools.toolSearch.threshold` 设计。取舍与后续项见 [qwen-code 可融入清单](../queries/qwen-code-capability-comparison.md)。

## 待确认

- 是否在官方 bundle 默认挂载，以及默认 `maxResults` 是否应按 profile 调整。
- 逐项上下文成本分解（qwen 的 `/context detail` 与 `idle cost`）尚未实现；现有 `contextBreakdown` 仍只有 system/tools/message 三分类。