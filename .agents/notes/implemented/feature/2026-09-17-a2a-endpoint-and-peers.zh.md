# Agent Note：用 `node:http` 提供 A2A，并把对等端留在配置里

Status: implemented

[English](2026-09-17-a2a-endpoint-and-peers.md) | 中文

## 问题

fork 需要与其他 agent 通信：既接受对等端派来的工作，也把工作交给对等端。官方的 `@a2a-js/sdk` 会带来一整棵依赖、这里根本不会用到的 protobuf/gRPC 绑定，以及 Express 形状的服务端；消息中间件则会为一个已经有持久会话日志的 harness 再添一个运行组件。协议本身就是一个 JSON-RPC 2.0 POST、一条 SSE 流和一张 agent card——小到足以自己拥有，而这里真正要紧的部分（任务标识、流式帧、取消）恰恰是以会话为后端的执行器必须映射到自己事件上的部分。

## 决策

三个包承载该能力，且不引入任何第三方运行时依赖——服务端与客户端只用 `node:http`：

- `@reachforstar/dsh-a2a` 承载 A2A v1.0.1 的线协议类型、请求处理器与监听器、客户端、有上限的内存任务表，以及 `a2a` 服务。它提供 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`SubscribeToTask`、`GetExtendedAgentCard`；四个推送通知方法明确回 `-32004 UNSUPPORTED_OPERATION`，而不是假装支持。请求体上限 1 MiB，配置了 `apiKey` 时缺少匹配 `X-Api-Key` 的请求会被拒绝。卡片只声明 JSONRPC 接口，因为这就是本服务端实现的绑定。
- `@reachforstar/dsh-a2a-host` 绑定 profile 挂载的端点、构建对外宣称的卡片，并通过 `DshA2AExecutor` 驱动会话。它自带监听器（默认回环、端口 9310）而不挂在浏览器服务上：对等端按 `origin + /.well-known/agent-card.json` 发现 agent，用路径前缀会迫使每个对等端都配置一条非标准卡片路径。
- `@reachforstar/dsh-tool-a2a` 暴露 `a2a_peers` 与 `a2a_send`。对等端只来自配置，工具调用不能注册，出站调用因此被限制在获批端点内。

任务的 `contextId` 就是 harness 会话 id。`SessionId` 只是带 brand 的字符串、自身没有格式约束，因此复用 `contextId` 的对等端会续上该会话，而允许调用方点名会话的端点以部署级 `apiKey` 作信任边界。A2A 的一轮以持久事件 `turn/end` 收尾，而不是靠空闲启发式判断；执行器只消费自己那条 `user/message` 之后的帧——用 `source.rpcId` 与它铸出的请求 id 比对——因此别的客户端并发驱动的轮次既不会被记错，也不会被吞掉。

## 备选方案

**采用官方 SDK。** 它能用维护中的代码替掉线协议类型与 SSE 分帧，代价是引入本部署并不提供服务的 gRPC/protobuf 依赖、harness 别处用不上的 Express 服务端，以及一层「它的任务模型 ↔ 会话事件」的映射——而这层映射恰恰就是这项工作的实质。

**在 agent 之间跑一个中间件。** Kafka 或队列会添一个运行组件和一套投递模型，而本地工作的投递模型会话日志已经提供；它也不回答「任务在 harness 语义里是什么」。

**把端点挂在浏览器服务的路径前缀下。** 少一个监听器，但遵循规范发现路径的对等端都得各自配置卡片路径。

**让模型注册对等端。** 临时调用方便，也给了提示内容把出站流量指向运维没批准过的端点的可能。

## 后果

协议面从此由这里拥有：未来 A2A 改版要由这份代码跟进，而 gRPC 与 HTTP+JSON 绑定保持不提供、卡片上也不声明。任务活在内存里（至多 500 条，淘汰最旧的终态任务），跨重启历史留在会话日志；推送通知被明确拒绝而不是被模拟。接线 profile 时暴露出一个值得记在包旁边的加载期坑：三个模块都必须导出 `name` / `inject` / `apply`，且**不能有 default 导出**，因为 Loader 的 `unwrapExports` 会把带 default 的模块折叠成那个默认值，静默丢掉 `inject` 与 `Config` 模式，启动时表现为 `cannot get property "tools" without inject` 与 `Cannot read properties of undefined (reading 'peers')`（[事故记录 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。
