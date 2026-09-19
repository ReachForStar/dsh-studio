---
description: "面对模型的两个 A2A 工具：列出本部署可调用的对等端，以及向指定对等端发送一条消息（可选续接先前任务）。"
kind: "package-reference"
---

# @reachforstar/dsh-tool-a2a

[English](README.md) | 中文

## 概述

`dsh-tool-a2a` 就 [`dsh-a2a`](../a2a/README.zh.md) 配置好的对等端，给 agent 两个工具：`a2a_peers` 列出本部署能调用的对等端，`a2a_send` 向指定对等端发送一条文本消息并返回它的回复。续接参数让后续消息能回到同一个远端任务或上下文，于是短程往返不会重启对方 agent。对等端只来自配置——模型不能注册对等端，出站调用因此被限制在运维批准过的端点内。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它与 [`dsh-a2a`](../a2a/README.zh.md)、工具注册表一起挂载。工具自身没有额外配置：对等端列表就是 `a2a` 被配置成的样子。

### 何时选用

需要让 agent 把工作交给另一个 agent、或向它提问时选它。只对外提供 A2A 服务的部署需要 [`dsh-a2a-host`](../a2a-host/README.zh.md) 而不需要本包。希望模型不必接触 URL 时挂它：每个对等端名字的含义由部署决定。

### 最小配置

没有自己的配置；对等端属于 [`dsh-a2a`](../a2a/README.zh.md)。

```yaml
- name: '@reachforstar/dsh-tool-a2a'
```

### 每次调用的行为

`a2a_peers` 返回每个已配置对等端的名字、端点、其已发布卡片上的显示名，以及该对等端接受的 skill；卡片读不到的对等端会连错误一起列出，而不是让整个列表失败。`a2a_send` 接收对等端名字、文本消息，以及可选的 `skill`、`workspace`、`mode`、`wait`、`contextId` 与 `taskId`；它返回对方的回复文本，外加后续调用需要的标识。当对等端是 a2a-bridge 部署的某个 agent 时，调用按所选 skill 与通道派发，`skill` 缺省取该 agent 声明的第一个 skill。对等端失败时以「失败的工具结果 + 原因」呈现，模型可以据此纠正调用，而不是丢掉这一轮。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `name` / `inject` / `apply` 与两个工具定义 |

### 导出形状

模块导出 `name` / `inject` / `apply`，**没有 default 导出**：Loader 的 `unwrapExports` 会把带 default 的模块折叠成那个默认值，加载时丢掉 `inject`（[事故记录 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 对等端只来自配置

工具通过 `a2a` 服务读取对等端，工具调用本身不能新增。这是刻意的：让模型驱动的对等端注册，等于让一段提示就能把出站调用指向运维没批准过的端点。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/a2a/a2a`](../a2a/README.zh.md) —— 这些工具所调用的对等端注册表与客户端。
- [`packages/a2a/a2a-host`](../a2a-host/README.zh.md) —— 反过来让本部署可被调用的端点。
- [`docs/tool-catalog.zh.md`](../../../docs/tool-catalog.zh.md) —— 组合能暴露的每个工具的生成目录。

<a id="model-experience"></a>
## 模型体验

### 工具

#### 模型看到什么

两个工具定义，各自带描述与 JSON schema：`a2a_peers` 无参数，`a2a_send` 接收 `peer`、`message` 与可选的 `skill`、`workspace`、`mode`、`wait`、`contextId` / `taskId`。两份描述都说明调用做什么、结果意味着什么；对等端列表本身以工具输出到达模型，而不是提示文本。

#### Token 影响

每个挂载的工具都会在看得见它的每个请求里付出 schema 与描述的代价。结果受对方回复限制：`a2a_peers` 至多列出已配置的对等端，`a2a_send` 返回一条回复的文本。

#### KV Cache 影响

定义在组合存续期内是静态的，因此留在缓存前缀里；对等端名字与回复以消息形式到来，追加在前缀之后而不会让它失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **只有文本**：请求只带文本 part，回复也只按文本读取；文件与结构化 part 既不发送也不渲染。
- **不向模型流式输出**：`a2a_send` 等到对方这一轮结束，因此很长的远端轮次以单个结果到达模型，而不是增量。
- **一次调用一条消息**：续接靠显式的 `contextId` / `taskId`；没有模型可以一直持有的会话对象。
- **总线任务先返回后出答案**：`mode: "bus"` 把任务投到部署的 topic，任务被领取即返回，因此答案文本只是调用返回前事件流送达的部分；带 `wait: true` 才等终态事件。
- **调用不能注册对等端**：对等端必须先配置好，模型才能寻址；未配置的名字会让调用失败。

<a id="dev-note"></a>
### 开发备注

[A2A 端点与对等端 Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.zh.md) 记录了工具为何只从配置取对等端，以及失败为何以工具结果呈现。
