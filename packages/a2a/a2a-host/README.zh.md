---
description: "profile 挂载的 A2A 宿主端点：对外宣称的 agent card、带鉴权的监听器，以及驱动对等端点名会话的执行器。"
kind: "package-reference"
---

# @reachforstar/dsh-a2a-host

[English](README.md) | 中文

## 概述

`dsh-a2a-host` 是部署挂载的监听器一半：它构建 agent card、绑定 HTTP 端点（默认回环）、在配置了 `apiKey` 时校验调用方，并通过 `DshA2AExecutor` 驱动 harness 会话以回答 A2A 请求。带 `contextId` 发消息的对等端会命中该 id 的会话，于是它续上先前的工作而不是另开一个。端点自带独立监听器、不挂在浏览器服务的前缀下，因为对等端按 `origin + /.well-known/agent-card.json` 发现它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂进已经挂载会话控制器的 profile。端口、主机、凭据和卡片身份都是配置；执行器的行为随它驱动的会话而定。

### 何时选用

需要本部署作为 A2A agent 被访问时选它。只对外调用的部署单挂 [`dsh-a2a`](../a2a/README.zh.md) 即可。由于端点被信任去点名会话，应绑定回环或置于网关之后，并在任何其他方可达时设置 `apiKey`。

### 最小配置

```yaml
- name: '@reachforstar/dsh-a2a-host'
  config:
    port: 9310
    apiKey: '${DSH_A2A_API_KEY}'
    card:
      name: 'dsh-studio'
      description: 'DeepSeek Harness agent sessions'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `host` | `127.0.0.1` | 绑定网卡 |
| `port` | `9310` | 端口；`0` 由系统分配并回写卡片的接口 URL |
| `apiKey` | 无 | 设置后请求必须携带匹配的 `X-Api-Key` |
| `url` | 由主机与端口推导 | 卡片对外宣称的端点；有代理前置时显式设置 |
| `cwd` | 无 | 端点驱动会话的工作目录 |
| `agentPreset` | 无 | 这些会话使用的 agent preset |
| `turnTimeoutMs` | 30 分钟 | 单轮 A2A 的预算，超时由执行器取消 |
| `card` | 内置身份 | agent card 上的名称、描述、版本、文档地址与技能 |

`apply` 会等待绑定完成，因此部署在启动时就知道自己宣称的端点正是自己在服务的那个；端口被占用会让组合失败，而不是起一个谁都到不了的监听器。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `A2AHostService`：卡片、监听器、生命周期与 `Config` |
| [`src/executor.ts`](src/executor.ts) | `DshA2AExecutor`：会话跟随、提示、流式、取消、超时 |
| [`src/card.ts`](src/card.ts) | `buildAgentCard` 与默认技能 |

### 导出形状

模块导出 `name` / `inject` / `apply`，**没有 default 导出**：Loader 的 `unwrapExports` 会把带 default 的模块折叠成那个默认值，加载时丢掉 `inject` 与 `Config`（[事故记录 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 一轮的机制

执行器先铸一个请求 id、订阅会话事件流，然后才提示会话——开头的快照加上其后的帧不留缝隙，于是这次提示开启的那一轮不会被漏掉。它只消费自己那条持久 `user/message` 之后的帧，并用该事件的 `source.rpcId` 与所铸 id 比对，因此别的客户端并发驱动的轮次既不会被记到本任务头上，也不会被吞掉。一轮以持久事件 `turn/end` 结束；`onCancel` 会中止订阅并取消会话的当前轮。

<a id="further-exploration"></a>
## 进一步探索

- [`packages/a2a/a2a`](../a2a/README.zh.md) —— 本端点所基于的协议、服务端、客户端与对等端注册表。
- [`packages/api/session-controller`](../../api/session-controller/README.zh.md) —— 执行器驱动的会话 API。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **一个进程一个端点**：服务自带监听器，同进程内第二次挂载会在端口上冲突，除非用 `port: 0`。
- **没有推送通知**：宿主不注册 webhook 目标，对等端按 [`dsh-a2a`](../a2a/README.zh.md) 所述轮询或订阅。
- **会话由调用方点名**：可信对等端可以点名任意会话 id，除部署级 `apiKey` 外没有按会话的授权。
- **文本进文本出**：只有文本 part 会转成提示，回复也是文本；文件与结构化 part 不翻译。

<a id="dev-note"></a>
### 开发备注

[A2A 端点与对等端 Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.zh.md) 记录了端点为何自带监听器而不挂在浏览器服务上，以及 `contextId` 如何成为会话 id。
