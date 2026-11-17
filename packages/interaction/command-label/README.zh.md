---
description: "给会话条目打标签的 /label 人工命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-label

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-command-label` 给会话最近一条助手消息附加短标签。标签是仅记日志的会话元数据：不进入模型表面，并因从持久化事件折叠而能在恢复后保留。标签用于对话记录的导航标记与后续界面能力。适用于希望在长会话中标记关键节点的部署。

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

在提供命令注册表与会话投影的组合中挂载本插件，然后在交互界面执行 `/label <名称>` 或 `/label clear`。

```yaml
- name: '@deepseek-ai/dsh-command-label'
```

该命令给最近一条助手消息打标签；`clear` 清除同一条目的标签。标签文本去空白后须为 1–80 字符。

```text
/label checkpoint-1
/label clear
```

该命令是人工命令：其输入与结果由命令生命周期记录。标签本身另记为一条仅日志的 `session/label` 事件。

<a id="understand-the-implementation"></a>
## 实现说明

命令追加一条 `session/label` 事件，携带目标条目序号与标签文本，或以 null 标签清除。一个仅宿主的投影把这些事件折叠成每个条目一个标签，因此恢复与 fork 继承会重放出相同标签状态。投影经会话投影注册表注册，不需要客户端视图。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-session`](../../core/session/README.zh.md) —— 事件日志与投影输入。
- [`dsh-commands`](../commands/README.zh.md) —— 命令注册表与执行生命周期。

<a id="model-experience"></a>
## 模型体验

### 会话标签

#### 模型看到什么

什么也没有。`session/label` 仅记日志，不携带可见操作，因此不进入派生历史、系统提示、工具 schema 或请求前缀。

#### Token 影响

零。该事件不增加模型可见 token，也不改变请求内容。

#### KV 缓存影响

无：对话的重构内容与缓存键不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 命令只能给最近一条助手消息打标签；给任意更早条目打标签尚未实现。
- 尚无客户端渲染消费标签投影。
- 标签按条目序号绑定；条目被表面替换改写时标签不移动。

<a id="dev-note"></a>
### 开发备注

标签绑定条目序号而非消息 id，使 fork 继承的前缀无需复制每条消息的元数据即可保留相同标签。
