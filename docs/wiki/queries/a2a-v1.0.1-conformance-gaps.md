---
title: A2A v1.0.1 符合性缺口清单（已修）
type: query
tags: [a2a, 协议符合性, 门禁]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# A2A v1.0.1 符合性缺口清单（已修）

> 核对基准：A2A 规范 tag `v1.0.1`（`specification/a2a.proto` 与 `docs/specification.md`）。初查时代码为 `920c7f52d9`，行号会随后续改动漂移，按引用的代码片段定位。
> **状态：11 处偏离已全部修复**（2026-09-18，随 Agent Note [a2a-v1-0.1 符合修复](../../../.agents/notes/implemented/bug-fix/2026-09-18-a2a-v1-0-1-conformance.md) 落地）。本文保留缺口明细与修法作为修复记录；「未实现能力」仍有效。

## 结论

**方法面完整，协议符合性现已补齐。** v1.0.1 的 11 个 RPC 全部有应答，原 7 处 MUST 级偏离与 4 处细节偏离均已按规范修正；`A2A-Version` 头在客户端与服务端两侧落地。

## 已覆盖（勿重复核对）

| 项 | 证据 |
| --- | --- |
| 11 个 RPC 方法名与 v1.0.1 一致 | proto 的 11 个 `rpc` ↔ `packages/a2a/a2a/src/server.ts` 的 `switch (rpc.method)` |
| TaskState 9 个状态逐一对应（含 `TASK_STATE_UNSPECIFIED`） | `packages/a2a/a2a/src/schema.ts` ↔ proto `enum TaskState` |
| Part / Message / Task / Artifact / TaskStatusUpdateEvent / TaskArtifactUpdateEvent 字段齐 | `schema.ts` |
| 卡片必填字段齐（name/description/supportedInterfaces/version/capabilities/defaultInputModes/defaultOutputModes/skills） | `packages/a2a/a2a-host/src/card.ts` ↔ proto 的 `field_behavior = REQUIRED` |
| JSON-RPC 错误体（`data` 数组，每项带 `@type`，用 `google.rpc.ErrorInfo`） | `server.ts` 的 `a2aError()` ↔ §9.5 |
| SSE 首帧为 Task、终态关流；`/.well-known/agent-card.json`、`/health` | `server.ts` 的 `streamMessage()`/`subscribe()`/返回的 handler |
| `ListTasksResponse` 字段名、`nextPageToken` 空串语义、`historyLength` 语义 | `server.ts` 的 `ListTasks`/`GetTask` 分支 ↔ proto `ListTasksResponse` |
| 卡片只声明 JSONRPC 绑定且 `protocolVersion: '1.0'`（不带 patch 号） | `card.ts` ↔ §3.6 |

## MUST 级偏离（已修）

| # | 规范要求 | 修法（已落地） |
| --- | --- | --- |
| 1 | `capabilities.pushNotifications: false` ⇒ 四个推送配置方法 MUST 回 `PushNotificationNotSupportedError` **-32003**（§3.3.4） | 常量 `PUSH_NOTIFICATION_NOT_SUPPORTED = -32003`，四个方法改用它，reason 同名 |
| 2 | `capabilities.extendedAgentCard` 为 false/缺省 ⇒ `GetExtendedAgentCard` MUST 回 **-32004**（§3.3.4） | case 改为按卡片能力判定：未声明 `extendedAgentCard` 即抛 -32004；卡片声明后自动提供（服务端以卡片为准） |
| 3 | 向终态任务发消息 MUST 回 **-32004**（§3.1.1、§3.1.2） | `runMessage` 取到 `existing` 后终态即抛；`INPUT_REQUIRED`/`AUTH_REQUIRED` 可继续，不受影响 |
| 4 | 终态任务 `SubscribeToTask` MUST 回 **-32004**（§3.1.6） | 在 `openEventStream` 之前抛出，错误以 JSON-RPC 应答返回；客户端 `subscribeToTask` 同步读取该 JSON 拒绝 |
| 5 | 不可取消状态 `CancelTask` MUST 回 `TaskNotCancelableError` **-32002**（§3.1.5） | 常量 `TASK_NOT_CANCELABLE = -32002`，终态分支改抛错 |
| 6 | `A2A-Version` 头（§3.2.6、§3.6.1、§3.6.2）；`VersionNotSupportedError` 码经 §5.4 确认为 **-32009**（reason `FAILED_PRECONDITION`） | 客户端 `headers()`/`getCard` 带 `'A2A-Version': A2A_PROTOCOL_VERSION`；服务端校验：缺省/空按 0.3，仅接受 `Major.Minor` = 1.0（patch 忽略，支持 query 参数形式） |
| 7 | `contextId` 与 `taskId` 不匹配 MUST 拒绝（§3.4.1） | `runMessage` 比较 `message.contextId` 与 `existing.contextId`，不一致抛 `INVALID_PARAMS`（-32602） |

## 细节偏离（已修）

| # | 规范要求 | 修法（已落地） |
| --- | --- | --- |
| 8 | `ListTasks` MUST 按 status timestamp **降序**（§3.1.4） | `TaskStore.selected()` 按 `status.timestamp` 降序，同戳按 id 兜底 |
| 9 | `includeArtifacts: false` 时 `artifacts` MUST **整体省略**（§3.1.4） | 解构丢弃；行类型 `A2ATaskRow = Omit<A2ATask,'artifacts'> & { artifacts?: A2AArtifact[] }`，包内导出 |
| 10 | 分页 MUST 为 cursor-based（§3.1.4） | token = 末页行 `(timestamp, id)` 的 base64url JSON；行已不在表中 → 空页；格式非法 → -32602；服务端以「多取一行」探测末页 |
| 11 | `historyLength: 0` 时 `history` SHOULD 省略（§3.2.4） | `GetTask` 直接 `delete` 该字段 |

## 未实现能力（规范允许，README 已如实声明，按需再定）

- **绑定**：只做 JSONRPC，gRPC 与 HTTP+JSON 未做。
- **推送通知**：webhook 投递整体未做（四个配置方法仅拒绝，不投递）。
- **扩展机制**：`capabilities.extensions`、`A2A-Extensions` 头、`ExtensionSupportRequiredError` 未做。
- **卡片 JWS 签名** `signatures`（proto 可选字段）未做。
- **媒体类型校验**：`ContentTypeNotSupportedError` (-32005) 从不产生；`schema.ts` 的 `textOf()` 只取 `text`，因此带 `raw`/`url` part 的消息会被静默当成空文本。要修就得在 `parseMessage()` 处校验 part 的 `mediaType` 是否落在 `defaultInputModes` 内。
- **任务存储**：进程内、上限 500、重启即失（规范不要求持久化；`packages/a2a/a2a/README.md` 的 Known Limitations 已写明）。
- **客户端**：无推送配置方法与 `GetExtendedAgentCard` 调用（`client.ts` 只有 getCard/send/stream/get/list/cancel/subscribe）。

## 复现与再核对

```bash
# 核对基准（本机需代理；直连 github 会被重置）
curl -sSL -x http://127.0.0.1:7890 https://raw.githubusercontent.com/a2aproject/A2A/v1.0.1/specification/a2a.proto -o /tmp/a2a-1.0.1.proto
curl -sSL -x http://127.0.0.1:7890 https://raw.githubusercontent.com/a2aproject/A2A/v1.0.1/docs/specification.md -o /tmp/a2a-spec-1.0.1.md

grep -n "^  rpc " /tmp/a2a-1.0.1.proto                      # 11 个方法
grep -n "TaskNotCancelableError\|PushNotificationNotSupportedError" /tmp/a2a-spec-1.0.1.md | head
grep -rn "A2A-Version" packages/a2a                        # 修复后：client/server 均有
```

## 关联

- 实现与决策：[A2A 端点与 peer（Agent Note）](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md)、[v1.0.1 符合修复（Agent Note）](../../../.agents/notes/implemented/bug-fix/2026-09-18-a2a-v1-0-1-conformance.md)、子系统页 `docs/subsystems/a2a.md`
- 门禁债务登记：[fork 自研包的门禁红项清单](fork-gate-debt.md)
