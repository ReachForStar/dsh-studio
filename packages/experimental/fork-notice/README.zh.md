---
description: "告诉分叉会话的模型：哪些后台工作属于原对话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-notice

[English](README.md) | 中文

## 概述

`dsh-fork-notice` 在分叉会话的第一步向模型说明归属边界。分叉会继承原对话的历史，包括原对话对后台子代理、后台 shell、定时任务与后续动作的承诺；没有提示时，分叉的模型容易等待这些工作、重复它们，或把结果当成本会话的成果。插件在第一步追加一条带来源的用户消息，覆盖上述后台工作与共享的文件、分支和服务，因此它与其他用户输入一样进入日志，也不会影响非分叉会话。只处理普通分叉：子代理子会话与非种子会话不受影响。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

任何可能分叉会话的组合都可以挂载本插件。它没有配置项，只依赖 agent loop 的 `agent/pre-step` 事件。

```yaml
- name: '@deepseek-ai/dsh-fork-notice'
```

<a id="understand-the-implementation"></a>
## 理解实现

监听器从会话头识别分叉子会话：`isSeeded` 为真且 `origin` 不是 `subagent`。它只在子会话的第一轮第一步动作，每个存活会话一次，并把提示追加到该步骤的消息列表。消息因此经普通准入路径进入日志；进程重启后的续跑不会重复，因为第一步已经过去。

<a id="dev-note"></a>
### 开发备注

提示是普通用户消息，因此重放与续跑不需要额外状态：子会话日志本身就记录了提示已投递。

<a id="model-experience"></a>
## 模型体验

### 分叉归属提示

#### 模型看到什么

分叉第一步的一条用户消息，以 `<fork-notice>` 包裹。它说明继承的未完成后台工作属于原会话，文件、分支与服务由双方共享。

#### Token 影响

每个分叉会话约 140 个 token，只在首个请求出现，后续步骤不再重复。

#### KV Cache 影响

提示落在继承前缀之后，因此继承历史的缓存前缀不变，只有新的请求尾部不同。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 在第一步之后续跑的分叉不会收到提示；提示只按结构性标记判断，不区分「从分叉再分叉」的血缘。
