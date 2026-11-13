---
description: "从已完成历史回答会话侧问，不向主对话追加回合。"
kind: "package-reference"
---

# @deepseek-ai/dsh-btw

[English](README.md) | 中文

## 概述

当用户想就当前对话问一句、又不希望它进入主记录时使用本包。Session Header 提供「就此会话提问」；问题在会话的 fork 子会话中运行，继承已完成回合的上下文，并回报给调用方而不是父模型。回答显示在弹窗中，父对话不增加回合。Host 拥有认证路由与 fork 生命周期，浏览器拥有弹窗与菜单入口。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 Agent、子代理、Connection 与浏览器槽位注册的 bundle 中挂载。默认子代理提供方是 `fork`，需要组合中的 `dsh-subagent-fork-in-process` 注册。

```yaml
- name: '@deepseek-ai/dsh-btw'
  config:
    provider: fork
    maxQuestionChars: 4000
    timeoutMs: 120000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `fork` | 继承父会话已完成回合上下文的子代理提供方 |
| `maxQuestionChars` | `4000` | 接受的最长问题 |
| `timeoutMs` | `120000` | 单个问题的实际耗时上限 |

### 请求约定

`POST /api/btw.ask` 接收 `{ "sessionId": "…", "question": "…" }` 并返回 `{ "answer": "…" }`。请求体或问题不合法返回 `400`，会话不存在返回 `404`，子会话未完成返回 `502`，超时返回 `504`，提供方失败返回不透明的 `500`。每次结果之后都会释放子会话。

### 模型可见内容

父会话没有任何新增内容：fork 只为自己的请求继承历史，回答只通过路由返回。子会话本身是普通的目录会话，因此仍会出现在会话列表中。

<a id="model-experience"></a>
## 模型体验

### 侧问

#### 模型看到什么

父会话什么都看不到：`POST /api/btw.ask` 不会在那里增加提示词段、工具 schema、请求上下文值或用户消息。fork 子会话通过 `ctx.subagents.startActivation` 与 `delivery: 'caller'` 创建，用继承的已完成回合历史运行一次普通请求。

#### Token 影响

父会话没有 token 开销。子会话为继承历史上的一次普通请求付费。

#### KV 缓存影响

父会话的请求前缀不变；子会话请求属于单独的 Session，拥有自己的缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 回答只支持文本；图片与结构化输出不会回传。
- 每次提问都会创建一个 fork 子会话，多次提问会在工作区留下多个子会话条目。
- 弹窗不流式显示部分回答；子会话结束后一次性显示最终文本。
- 关闭弹窗不会取消 Host 已接受的问题。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

Host 路由通过 `ctx.subagents.startActivation` 以 `delivery: 'caller'` 为每个问题创建一个 fork 子会话，因此不会通知父模型。`provider` 必须指向 `inheritsParentContext` 为真的提供方，回答才能看到对话；`fork` 是默认值，也是这里验证过的唯一提供方。

</details>
