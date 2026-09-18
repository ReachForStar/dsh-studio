---
description: "A2A 协议实现、监听端 profile 与面向模型的 peer 工具的选择指南。"
kind: "package-group"
---

# a2a/ — agent-to-agent 家族

[English](README.md) | 中文

## 摘要

本家族让一个 harness 部署同时充当 A2A 服务端与客户端：`a2a` 承载协议（A2A v1.0.1，JSON-RPC 2.0 + SSE 流式）与已配置的 peer 注册表，`a2a-host` 是 profile 挂载的监听端，`tool-a2a` 把 peer 暴露给模型。三者都是**产品**包。生成的服务与事件 API 见 [A2A 子系统参考](../../docs/subsystems/a2a.zh.md)。

## 目录

- [包](#packages)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`a2a/`](a2a/README.zh.md) | 实现 A2A 协议（服务端、客户端、任务存储、agent card），并把已配置的 peer 变成具名调用。 | `ctx.a2a` |
| [`a2a-host/`](a2a-host/README.zh.md) | 绑定对外宣告的端点，并通过 `DshA2AExecutor` 驱动 peer 指名的 harness 会话。 | `ctx.a2aHost` |
| [`tool-a2a/`](tool-a2a/README.zh.md) | 给模型 `a2a_peers`（本部署可调用的对象）与 `a2a_send`（向具名 peer 发一条消息）。 | （注册两个工具） |

只向外调用的部署单独挂 `a2a`；只应答 peer 的部署挂 `a2a` + `a2a-host`。peer 来自配置，绝不来自模型。
