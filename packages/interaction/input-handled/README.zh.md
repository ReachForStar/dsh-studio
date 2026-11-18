---
description: "在用户输入进入模型之前拦截的输入处理包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-input-handled

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-input-handled` 让扩展在用户输入进入模型之前拦截它。拦截器可返回 `continue`、带替换文本的 `transform`，或 `handled` 表示输入已就地处理、绝不追加到对话。该服务由会话提示路径查询；需与注册拦截器的扩展一起挂载。

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

挂载本插件，然后从扩展注册拦截器。

```yaml
- name: '@deepseek-ai/dsh-input-handled'
```

```ts ignore-check
ctx.inputHandling.register({
  intercept: (agent, text, signal) => {
    if (text === 'ping') return { action: 'handled' }
    if (text.startsWith('?quick ')) return { action: 'transform', text: `Answer briefly: ${text.slice(7)}` }
    return { action: 'continue' }
  },
})
```

拦截器按注册顺序执行；第一个非 `continue` 的决策生效。`handled` 输入被确认，但不创建对话消息。`transform` 决策替换提交文本。未挂载提供方的组合跳过拦截。

<a id="understand-the-implementation"></a>
## 实现说明

服务保存有序拦截器列表，逐个等待，直到某个返回 `continue` 以外的决策。会话提示控制器提取提交文本，在挂载服务时调用它，并在附件准入前应用决策：`handled` 返回接受但不入队，`transform` 替换文本部分。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-commands`](../commands/README.zh.md) —— 不进模型的人工命令，同类机制。
- [`dsh-session-controller`](../../api/session-controller/README.zh.md) —— 查询该服务的提示路径。

<a id="model-experience"></a>
## 模型体验

### 输入处理

#### 模型看到什么

只有决策结果：`continue` 输入原样到达，`transform` 输入以替换文本到达，`handled` 输入永不到达。拦截器源码与其他输入不进入请求。

#### Token 影响

`handled` 把输入完全移出对话；`transform` 把提交文本改为替换文本，请求携带替换内容而非原始输入。

#### KV 缓存影响

请求前缀与有效文本一致，如同普通提交：`continue` 不变，`transform` 改写，被丢弃的 `handled` 输入不改变前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 只拦截文本部分；图像与文件部分原样通过，`transform` 决策把整个提交替换为一个文本部分。
- 提示控制器每次提交传递一个新的 `AbortSignal`，因为请求本身不携带信号。
- `handled` 输入除控制器的普通确认外不产生持久记录，不作为消息记录。

<a id="dev-note"></a>
### 开发备注

决策词汇与命令面一致：`continue`、`transform`、`handled` 保持输入路径单一，同时让扩展拥有模型看不到的输入。
