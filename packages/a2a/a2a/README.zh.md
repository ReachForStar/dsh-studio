---
description: "A2A 线协议实现与对等端接缝：A2A v1.0.1 的 JSON-RPC 2.0 over HTTP 与 SSE 流式、对等端调用的服务端、本部署调用对等端用的客户端，以及配置驱动的对等端注册表。"
kind: "package-reference"
---

# @reachforstar/dsh-a2a

[English](README.md) | 中文

## 概述

`dsh-a2a` 让一个 harness 部署同时成为 A2A 服务端与客户端。它用 JSON-RPC 2.0（`POST /`）承载 A2A v1.0.1，流式走 server-sent events，提供 `GET /.well-known/agent-card.json` 与 `GET /health`，并用一个小型内存任务表，让 `GetTask`、`ListTasks`、`CancelTask`、`SubscribeToTask` 能回答本进程创建过的任务。客户端一半以同样的方式调用对等端，`a2a` 服务把配置好的对等端变成按名字的调用，于是运维只需为一个远端 agent 起一次名字，而不必在每个调用点写 URL。只用 `node:http`：不引 SDK、不引消息中间件、不引 gRPC，也没有第三方运行时依赖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂进宿主组合；当模型需要调用对等端时，再一起挂工具包。对等端是配置而非模型输入：模型只给名字，由部署决定这个名字指向哪个端点。

### 何时选用

需要把某个 agent 的工作交给另一个 agent，或让对等端驱动本部署的某个会话时选它。它不是消息总线，也不是持久队列：任务只活在进程内存里，会话日志始终是 agent 行为的唯一持久记录。跨重启的投递保证由部署方自行构建。

### 最小配置

对等端可选；空映射时只提供服务端能力。

```yaml
- name: '@reachforstar/dsh-a2a'
  config:
    peers:
      reviewer:
        url: 'http://127.0.0.1:9311/'
        apiKey: '${REVIEWER_A2A_KEY}'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `peers.<name>.url` | 必填 | 调用该对等端的端点 |
| `peers.<name>.apiKey` | 无 | 对该对等端的每次调用都以 `X-Api-Key` 发出 |
| `peers.<name>.cardPath` | `/.well-known/agent-card.json` | 读取 agent card 的路径 |
| `peers.<name>.timeoutMs` | 无 | 单次调用预算，含流的空闲间隔 |

`a2a` 服务暴露 `list()`、`resolve(ref)`、`send(request)`、`card(ref)`、`inspect(signal)`。未命中配置的引用会被当作端点 URL，运维因此能刻意调用未配置的 agent。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/schema.ts`](src/schema.ts) | A2A 线协议类型：part、message、task、artifact、流事件、agent card |
| [`src/server.ts`](src/server.ts) | 请求处理器与监听、SSE 流式、鉴权、错误码 |
| [`src/client.ts`](src/client.ts) | `A2AClient`：取卡片、发送、流式、查询、取消、订阅 |
| [`src/task-store.ts`](src/task-store.ts) | 有上限的内存任务表，淘汰最旧的终态任务 |
| [`src/index.ts`](src/index.ts) | `A2AService`、对等端注册表、`Config` 模式 |

### 导出形状

模块导出 `name` / `inject` / `apply`，**没有 default 导出**：Loader 的 `unwrapExports` 会把带 default 的模块折叠成那个默认值，加载时丢掉 `inject` 与 `Config`（[事故记录 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 协议面

提供 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`SubscribeToTask` 与 `GetExtendedAgentCard`；四个推送通知方法回 `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED`，不假装支持。发往终态任务的消息、订阅终态任务分别以 `-32004` 拒绝，取消终态任务以 `-32002` 拒绝；卡片未声明 `extendedAgentCard`，`GetExtendedAgentCard` 回 `-32004`。请求必须带 `A2A-Version: 1.0`——缺省或空值按规范视为 0.3，本端以 `-32009` 拒绝。请求体上限 1 MiB；配置了 `apiKey` 时，缺少匹配 `X-Api-Key` 的请求以 `-32000` 拒绝。agent card 只声明 JSONRPC 接口。

### 任务标识

任务的 `contextId` 就是它所在会话，因此复用先前 `contextId` 的对等端会继续同一会话。A2A 自身没有更多会话概念，这正是宿主端点把调用方视为可信、并以 `apiKey` 设门槛的原因。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/a2a/a2a-host`](../a2a-host/README.zh.md) —— profile 挂载的监听器，含以会话为后端的执行器与对外宣称的 agent card。
- [`packages/a2a/tool-a2a`](../tool-a2a/README.zh.md) —— 面对模型、基于这些对等端的两个工具。
- [A2A 规范](https://a2a-protocol.org/) —— 本实现遵循的上游协议。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **只有 JSONRPC**：不提供 gRPC 与 HTTP+JSON 绑定，agent card 也如此声明。
- **没有推送通知**：四个配置方法返回 `-32003`；需要推送的调用方得轮询 `GetTask` 或挂住 `SubscribeToTask` 流。
- **没有扩展 agent card**：卡片未声明 `extendedAgentCard`，`GetExtendedAgentCard` 回 `-32004`。
- **严格版本**：只服务 `A2A-Version: 1.0`；缺省或空值按规范视为 0.3，本端以 `-32009` 拒绝。
- **任务只活在进程内**：任务表至多 500 条，淘汰最旧的终态任务，重启即忘；持久历史在会话日志。
- **客户端只重试一次**：首帧之前被切断的流重试一次，其后的切断直接以错误交给调用方，不做断点续流。

<a id="dev-note"></a>
### 开发备注

[A2A 端点与对等端 Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.zh.md) 记录了「用 `node:http` 手写协议而非采用 SDK」的决策、会话映射的取舍，以及接线 profile 时踩到的 Loader 坑。
