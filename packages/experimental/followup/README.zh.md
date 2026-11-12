---
description: "每个完成的轮次后为用户给出下一步动作建议，仅记日志供展示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-followup

[English](README.md) | 中文

## 概述

`dsh-followup` 在轮次完成后为用户提出具体的下一步动作。带有请求或回复文本的 `turn/end` 会启动一次辅助模型请求；解析出的行动行以最新覆盖的 `followup/suggestions` 事件记入日志，永不进入模型可见表面。请求受渲染输入字节数、输出 token 上限、建议条数、单条字符数与截止时间约束。请求失败或被销毁只记录警告，不改动对话。

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

在客户端需要展示后续动作的位置挂载本插件。插件依赖 LLM 服务并需要显式配置 `provider`/`model` 路由。

### 配置

- `provider` / `model` — 辅助路由，必须成对提供。
- `maxOutputTokens` — 输出 token 上限，默认 256。
- `timeoutMs` — 端到端截止时间，默认 15000。
- `maxInputBytes` — 对话摘录的 UTF-8 字节上限，默认 8192。
- `maxSuggestions` — 单个轮次接受的建议条数，默认 3。
- `maxSuggestionChars` — 单条建议字符上限，默认 120。

本包不属于 `dsh-base`：每个轮次多花一次请求。

<a id="understand-the-implementation"></a>
## 理解实现

插件从投递的事件中累积当前轮次的用户请求文本与最近的助手回复，以收到的 `turn/start` 为归属；不读取历史事件。`turn/end` 到达时，它渲染摘录、调用辅助路由、把纯文本行解析为至多 `maxSuggestions` 条动作，并追加带轮次号的 `followup/suggestions` 事件。重复投递的 `turn/end` 被忽略，销毁插件会中止进行中的请求。

<a id="further-exploration"></a>
## 进一步探索

- 仅记日志的最新覆盖事件：`@deepseek-ai/dsh-session-title` 中的 `session/title`。
- 辅助请求执行：`@deepseek-ai/dsh-session-title-llm`。
- 本事件的持久化记录：`docs/persistence-changes/2026-11-11-followup.md`。

<a id="model-experience"></a>
## 模型体验

### 后续建议

#### 模型看到什么

什么也没有。`followup/suggestions` 仅记日志：不携带可见操作，不进入派生历史、系统提示、工具 schema 或请求前缀。辅助请求是带独立系统提示的单条消息调用。

#### Token 影响

主代理请求增加 0 token。辅助请求最多发送 `maxInputBytes` 的摘录文本，最多接收 `maxOutputTokens`；两者都不计入对话窗口。

#### KV 缓存影响

主请求没有影响：该事件不改变其重建内容或缓存键。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 无客户端渲染：事件已记入日志，但尚无内置 Web 卡片消费它。
- 无推测执行：不会在用户输入前预先执行预测动作。
- 不与更早轮次去重：每个轮次的建议相互独立。
- 无脱敏：请求与回复摘录按原样发送到辅助路由。

<a id="dev-note"></a>
### 开发备注

建议是派生数据，因此插件只在轮次关闭后追加一个展示事件。
