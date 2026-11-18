---
description: "把选择的虚拟模型按每次请求解析为物理模型的虚拟模型路由包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-virtual-model

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-agent-virtual-model` 注册可选的虚拟模型，把每次请求路由到物理 provider/model。用户选择仍记录为虚拟路由；每个请求头记录实际应答的物理模型。路由器可返回状态，状态作为仅日志事件持久化并按会话分支折叠。适用于希望用一个可选路由按任务、成本或对话阶段拆分到多个模型的部署。

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

在提供会话投影的组合中挂载本插件，然后注册虚拟模型。

```yaml
- name: '@deepseek-ai/dsh-agent-virtual-model'
```

```ts ignore-check
ctx.virtualModels.register({
  provider: 'router',
  id: 'auto',
  name: 'Auto',
  route: (request) => {
    const sticky = request.reason === 'retry' ? request.failed : request.previous
    if (request.reason !== 'user' && sticky) return { selection: sticky }
    return { selection: { provider: 'deepseek', model: 'deepseek-chat' } }
  },
})
```

通过普通模型选择器选择 `router/auto` 会记录该路由；每次请求都经 `route()` 解析。请求携带 `reason`（`user`、`continuation`、`retry`、`direct`）、最近一次成功的物理选择、重试时的失败选择、已存状态与请求消息。

路由器返回物理 `selection`，并可返回新 `state`。返回 `undefined` 或收到的状态则保持已存状态。

<a id="understand-the-implementation"></a>
## 实现说明

服务按 `provider/id` 维护注册表。每次请求时，`AgentModel` 询问其注入的解析器；未注册的选择原样通过。已注册的选择调用路由器，并把返回的状态经仅日志的 `virtual-model/state` 事件持久化。`virtualModelState` 投影折叠这些事件，使恢复与 fork 继承还原分支状态。

工具解析与系统提示使用解析后的物理选择；模型选择器与模型切换提示仍使用记录的虚拟选择。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-agent`](../agent/README.zh.md) —— 模型选择与路由解析器契约。
- [`dsh-session-projection`](../../session/session-projection/README.zh.md) —— 存储路由状态的投影注册表。

<a id="model-experience"></a>
## 模型体验

### 虚拟模型路由

#### 模型看到什么

路由器为本次请求选择的 `provider` 与 `model`，如同用户直接选择。虚拟路由名、路由函数与已存路由状态都不进入请求。

#### Token 影响

与普通模型请求一致：路由每次请求选择一个物理模型，不新增提示段落或工具 schema。

#### KV 缓存影响

路由按请求改变物理模型，缓存键随所选物理模型变化，与手动切换模型相同；保持上一物理模型的粘性路由器可保留前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 内置循环把一轮的首步记为 `user`，其余记为 `continuation`；尚未区分带失败选择的重试。
- 路由状态按会话分支，不在会话间共享。
- 虚拟路由不出现在客户端模型选择器；客户端需显式添加。
- 路由器抛错会使请求失败；未实现回退到记录的选择。

<a id="dev-note"></a>
### 开发备注

解析器只在挂载服务时注入 `AgentModel`，未挂载的组合保持原有同步行为。
