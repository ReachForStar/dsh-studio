---
description: "面向模型的工具检索：按关键词搜索会话工具面，或按名称取回单个工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-search

[English](README.md) | 中文

## 概述

给模型一个找回不在视野里的工具 schema 的入口。`tool_search` 按关键词搜索调用方智能体可见的工具，或按精确名称取回一个，返回每个匹配项的名称、描述与参数 schema；模型随后直接通过常规执行器调用该工具。本包只注册一个工具，不添加策略、不改变可见性、不产生会话事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在工具面大于「值得常驻每次请求的 schema」的组合上挂载：启用工具延迟加载后，模型看到的是简短目录，需要未见过的工具时先调用 `tool_search`。

```yaml
- id: tool-search
  name: '@deepseek-ai/dsh-tool-search'
  config:
    maxResults: 8
    descriptionMaxLength: 240
```

`maxResults` 限制一次搜索的条数（最小 1，默认 8）；`descriptionMaxLength` 限制每条返回描述的长度（最小 40，默认 240）。两者在插件加载时校验，越界即激活失败。

### 查询行为

- `name` 在该工具对智能体可见时返回它，且优先于 `query`。
- `query` 按空白分词；每个词都必须出现在工具名称或描述中。
- 名称命中某个词的排在只有描述命中的之前。
- 两个参数都不给时返回空目录，其展示文本说明两种检索方式。

<a id="understand-the-implementation"></a>
## 理解实现

可见性来自 `ctx.tools.definitions(agent)`：检索读取的是执行器解析的同一分层注册表，因此限制或作用域内的同名影子对检索结果的影响与对可调用集合的影响一致。

## 延伸阅读

- [`dsh-tools`](../../core/tools/README.zh.md) — 注册表、可见性与执行
- [`dsh-llm`](../../llm/llm/README.zh.md) — 工具延迟加载

<a id="model-experience"></a>
## 模型体验

### 检索结果

#### 模型看到什么

每个匹配一项：`## <名称>` 标题、工具描述，以及 JSON 代码块形式的参数 schema。空搜索返回一句话，说明两种检索形式。

#### token 影响

每次搜索消耗一个工具结果；schema 只计入本次返回的工具，条数由 `maxResults` 限制。

#### KV 缓存影响

工具 schema 属于请求前缀。结果追加在其后，搜索不会重写早先请求已缓存的内容。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 只返回 schema，不代调用，也不决定何时把延迟工具交回即时工具面。
- 匹配基于子串。工具描述的语义检索不在范围内。
- 只按条数限流；单个超大 schema 仍可能主导一次结果。

<a id="dev-note"></a>
### 开发备注

本包存在的原因：延迟加载让模型拿到的是没有 schema 的目录，若没有检索面，模型只能猜名称。逐文件覆盖率保持 100%。
