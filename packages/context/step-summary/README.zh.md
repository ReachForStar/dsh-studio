---
description: "为每个步骤的工具批次生成一行模型摘要，仅记日志供展示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-step-summary

[English](README.md) | 中文

## 概述

`dsh-tool-summary` 为每个已完成步骤的工具批次写一行摘要。批次至少包含一次工具调用的 `step/end` 会启动一次辅助模型请求；接受的回复以最新覆盖的 `tool/batch-summary` 事件记入日志，永不进入模型可见表面。请求受渲染输入的字节上限、输出 token 上限和截止时间约束；批次为空或重复投递的步骤不产生请求。请求失败或被销毁时只记录警告，不改动对话。

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

在需要展示工具批次做了什么的会话中挂载本插件。插件依赖 LLM 服务并要求显式配置 `provider`/`model` 路由，辅助模型始终是被明确选择的。

### 配置

- `provider` / `model` — 辅助路由，必须成对提供。
- `maxOutputTokens` — 单次摘要请求的输出 token 上限，默认 64。
- `timeoutMs` — 端到端截止时间，默认 15000。
- `maxInputBytes` — 渲染后批次描述的 UTF-8 字节上限，默认 16384。
- `maxSummaryChars` — 接受摘要行的字符上限，默认 160。

本包不属于 `dsh-base`：摘要会让每个工具批次多花一次请求，因此由 profile 选择启用。

<a id="understand-the-implementation"></a>
## 理解实现

插件监听投递的会话事件，在内存中累积每个步骤的 `tool/call` 与 `tool/result` 条目，不读取历史事件，因此摘要路径不依赖日志扫描。`step/end` 到达时，它把批次渲染为每次调用一行加受限结果摘录，调用辅助路由，并追加含 turn、step、摘要与调用次数的 `tool/batch-summary` 事件。重复投递的 `step/end` 与重复调用 id 会被忽略，销毁插件会中止进行中的请求。

摘要是展示数据。以最新覆盖的日志事件记录它，客户端可以在恢复后重建同一行，而无需让它对模型可见。

<a id="further-exploration"></a>
## 进一步探索

- 带路由、截止时间与用量记录的辅助请求执行：`@deepseek-ai/dsh-session-title-llm`。
- 仅记日志的最新覆盖事件：`@deepseek-ai/dsh-session-title` 中的 `session/title`。
- 本事件的持久化记录：`docs/persistence-changes/2026-11-11-tool-summary.md`。

<a id="model-experience"></a>
## 模型体验

### 工具批次摘要

#### 模型看到什么

什么也没有。`tool/batch-summary` 仅记日志：不携带可见操作，不进入派生历史、系统提示、工具 schema 或请求前缀。辅助请求本身是带独立系统提示的单条消息调用。

#### Token 影响

主代理请求增加 0 token。辅助请求最多发送 `maxInputBytes` 的渲染批次文本，最多接收 `maxOutputTokens`；两者都不计入对话窗口。

#### KV 缓存影响

主请求没有影响：该事件不改变其重建内容或缓存键。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 无客户端渲染：事件已记入日志，但尚无内置 Web 卡片消费它。
- 不跨步骤合批：每个步骤的批次独立摘要。
- 无重试：辅助请求失败后该步骤没有摘要。
- 无脱敏：结果摘录按原样发送到辅助路由。

<a id="dev-note"></a>
### 开发备注

摘要是派生数据，因此插件从不改动对话状态；它只在批次完成后追加一个展示事件。
