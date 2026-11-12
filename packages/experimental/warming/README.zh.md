---
description: "为空闲会话重放请求前缀并追加保活提示，延长提示缓存。"
kind: "package-reference"
---

# @deepseek-ai/dsh-warming

[English](README.md) | 中文

## 概述

`dsh-warming` 让提供方的提示缓存在会话空闲期间不过期。轮次结束且已过配置的间隔后，它重放会话的派生历史、记录的工具声明与路由，再追加一条保活提示。由于该请求复现了对话的请求前缀，它刷新的是下一次真实请求会读取的缓存条目，而不是另建一个条目。保活请求不进入会话日志或派生历史，其回复被丢弃。保活失败只记录一条警告，并停止该会话的保活，直到下一次真实请求。销毁插件会清除定时器并中止进行中的保活请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在需要让空闲会话保持缓存的部署中挂载本插件。插件依赖 LLM 服务，且为显式选用：本包不属于 `dsh-base`，每条保活请求都会计费。

### 配置

- `enabled` — 是否允许为空闲会话保活。默认 `true`；挂载本包即启用。
- `interval` — 距最近一次请求后等待多久发送一条保活请求，单位毫秒，或 `'auto'`。默认 `'auto'`，解析为 4 分钟。
- `durationMs` — 距最近一次真实请求后保活可持续多久。默认 30 分钟。
- `prompt` — 模型可见的保活文本。默认 `This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK`。
- `maxOutputTokens` — 单条保活请求的输出 token 上限。默认 16。
- `timeoutMs` — 单条保活请求的端到端截止时间。默认 15000。

<a id="understand-the-implementation"></a>
## 理解实现

插件监听每个会话的 `session/event`。`request/header` 记录发生过一次真实请求路由，`step/start` 记录最近一次模型调用的发送时间。`turn/end` 按剩余间隔安排定时器；真实活动（`turn/start` 或 `step/start`）会取消定时器并中止进行中的保活请求。

定时器触发时，保活请求从会话本身重建：`session.requestHeader()` 提供最近一次真实请求的 provider/model/effort 路由与工具声明，`session.deriveMessages()` 提供当前派生历史，`session.toolHistory()` 提供工具更新投影。保活提示作为最后一条用户消息追加，不向会话追加任何事件。这与 `@deepseek-ai/dsh-compaction-basic` 复现缓存前缀的摘要调用采用同一套构造方式。

定时器仅在 `lastSendAt + interval < lastRequestAt + durationMs` 时触发，因此不会在窗口边缘发送无人读取的请求。每次成功保活后，下一次间隔从该次发送时间起算；窗口仍从最近一次真实请求起算。一次失败——准备请求被拒、截止时间耗尽，或提供方返回 `error`/`aborted` 结束原因——会设置该会话的停止标记并只产生一条警告；下一次真实请求会清除该标记。

<a id="further-exploration"></a>
## 进一步探索

- 带独立用途与来源标记的辅助单次请求：`@deepseek-ai/dsh-followup`。
- 本包复现缓存前缀所参照的辅助调用：`@deepseek-ai/dsh-compaction-basic`。
- 截止时间工具与定时器上限：`@deepseek-ai/dsh-timeout`。
- 本包参照的行为：opencode 的 `WarmingPlugin`。

<a id="model-experience"></a>
## 模型体验

### 保活请求

#### 模型看到什么

对话自身的历史：下一次真实请求会发送的系统提示、消息与工具声明，随后是配置的保活提示，作为又一条用户消息。不追加任何事件，因此对话本身不变，下一次真实请求也看不到这条提示。

#### Token 影响

主对话请求增加 0 token。每条保活请求重发当前历史与提示文本（默认是一句固定的话）；历史在缓存已热时由提供方提示缓存提供，因此只有提示文本与上限内的输出（`maxOutputTokens`）计为新 token。两者都不计入会话上下文窗口。

#### KV 缓存影响

保活请求复现最近一次真实请求已被提供方缓存的前缀——相同路由、工具声明、系统提示与消息——再追加提示文本。因此提供方的前缀匹配会延长该缓存条目的存活时间，而不是另建条目；下一次真实请求读取的正是这个条目。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- `interval: 'auto'` 固定为 4 分钟。没有 LLM 适配器报告提示缓存 TTL——`dsh-llm-pi-ai` 只暴露 `cacheRetention: 'none' | 'short' | 'long'`——因此无法套用“取 TTL 的 90%”规则；4 分钟低于提供方对短时缓存常用的 5 分钟存活时间。
- 无缓存未命中检测。opencode 在保活请求的缓存写入多于读取时停止保活；本包不读取用量计量。
- 保活从本进程观察到的第一个 `turn/end` 开始。没有新活动的已恢复会话不会被保活，压缩请求也不会重置窗口。
- 保活请求会重发当前历史，因此已接近该路由上下文上限的对话可能使保活失败；该失败只记录那一条警告并停止保活。
- 无客户端界面：保活只能通过提供方计费与那一条警告观察到。

<a id="dev-note"></a>
### 开发备注

路由与工具声明取自记录的 `request/header`，消息取自会话的派生历史，而非会话当前的模型选择：缓存条目属于最后写入它的那次请求。
