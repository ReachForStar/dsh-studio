---
description: "把当前对话整理成新会话提示词草稿的 /handoff 人工命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-handoff

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-handoff` 把当前对话整理成一份自包含的新会话提示词。`/handoff <目标>` 命令读取会话的模型可见派生历史，用一次辅助模型请求写出承载相关上下文、决策、文件与下一步任务的提示词，并把该提示词作为命令结果返回。当前会话不被修改：不追加消息、不改写历史，辅助回复也不进入模型表面。适用于希望把工作迁到新会话又不丢失上下文的部署。

## 目录

- [使用方法](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方法

在已提供命令注册表与 LLM 适配器的组合中挂载本插件，然后在交互界面执行 `/handoff <新会话目标>`。该命令是人工命令：其输入与结果记入会话日志，结果由发起命令的界面直接渲染，不成为模型消息。

### 配置辅助路由

同时配置 `provider` 与 `model` 时，命令使用该显式路由；否则回退到会话当前模型选择。只配置其一时，插件加载即拒绝。

```yaml
- name: '@deepseek-ai/dsh-handoff'
  config:
    provider: deepseek
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 缺省 | 辅助 provider 路由；必须与 `model` 成对 |
| `model` | 缺省 | 辅助模型 id；必须与 `provider` 成对 |
| `maxOutputTokens` | `2048` | 单次辅助请求的输出 token 上限 |
| `timeoutMs` | `30000` | 辅助请求的端到端截止时间 |
| `maxHistoryMessages` | `40` | 发送的最近派生消息条数 |

目标为空时返回用法提示，输入保留在输入框。

<a id="understand-the-implementation"></a>
## 实现说明

命令处理器校验目标、解析路由并发起辅助请求。请求重放会话的派生历史，截断到最近 `maxHistoryMessages` 条，并把目标作为一条用户消息追加。请求经普通 LLM 服务以 `purpose: 'handoff'` 流式发送，文本块收集为返回的提示词。该请求不作为会话历史记录；命令生命周期事件承载输入与结果。

命令通过 `ctx.commands.register()` 注册，使用稳定的品牌化 definition id。它是全局命令，任何已组合的命令适配器都可派发。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-commands`](../../interaction/commands/README.zh.md) —— 命令注册表与执行生命周期。
- [`dsh-llm`](../../llm/llm/README.zh.md) —— 辅助请求路径与 `purpose`。
- [`dsh-followup`](../followup/README.zh.md) —— 另一类辅助请求，产出展示数据而非用户提示词。

<a id="model-experience"></a>
## 模型体验

### 交接提示词草稿

#### 模型看到什么

配置的辅助模型看到会话的派生历史（截断到最近 `maxHistoryMessages` 条），加上一条携带目标的用户消息，以及一条只要求输出提示词文本的固定系统指令。当前会话的模型看不到该请求：不向对话追加消息，草稿也不进入派生历史。

#### Token 影响

主对话请求的 token 不变。辅助请求发送截断后的历史与目标，接收至多 `maxOutputTokens`；两者都不计入对话窗口。

#### KV 缓存影响

对主请求无影响：命令既不改变对话的重构内容，也不改变其缓存键。辅助请求有独立前缀，不参与对话缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 提示词是草稿：用户需将其粘贴到新会话。自动创建带种子的会话尚未实现。
- 派生历史按消息条数截断，不按字节预算，因此单条极大消息仍可能主导请求。
- 辅助请求没有独立的持久化用量记录；其成本经 LLM 服务的普通 token 统计可见。

<a id="dev-note"></a>
### 开发备注

该命令是人工命令，其输入与结果由命令生命周期记录，而辅助请求不进入对话表面。
