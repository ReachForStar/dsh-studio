---
title: A2A v1.0.1 符合性缺口清单（待修）
type: query
tags: [a2a, 协议符合性, 待修, 门禁]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# A2A v1.0.1 符合性缺口清单（待修）

> 核对基准：A2A 规范 tag `v1.0.1`（`specification/a2a.proto` 与 `docs/specification.md`）。核对时代码为 `920c7f52d9`，行号会随后续改动漂移，按引用的代码片段定位。
> **状态：全部未修**。本文是下一个会话的修复工单，不是已完成记录。

## 结论

**方法面完整，协议符合性不完整。** v1.0.1 的 11 个 RPC 全部有应答，但其中 7 处 MUST 级行为与规范不符，另有 3 处细节与若干未实现能力。上次结论"已实现"仅指方法面与工程接线（`ctx.a2a`/`ctx.a2aHost`/工具）已落地。

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

## MUST 级偏离（必修）

| # | 规范要求 | 现状（`920c7f52d9`） | 修法 |
| --- | --- | --- | --- |
| 1 | `capabilities.pushNotifications: false` ⇒ 四个推送配置方法 MUST 回 `PushNotificationNotSupportedError` **-32003**（§3.3.4） | 四个 case 抛 `UNSUPPORTED_OPERATION` (-32004)：`throw a2aError(UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION', 'push notification configuration is not served')` | 新增常量 `PUSH_NOTIFICATION_NOT_SUPPORTED = -32003`，四个方法改用它；reason 用 `PUSH_NOTIFICATION_NOT_SUPPORTED` |
| 2 | `capabilities.extendedAgentCard` 为 false/缺省 ⇒ `GetExtendedAgentCard` MUST 回 **-32004**（§3.3.4） | 卡片只声明 `{ streaming: true, pushNotifications: false }`，却 `case 'GetExtendedAgentCard': sendResult(res, rpc.id, structuredClone(options.card))` | 二选一：卡片加 `extendedAgentCard: true`（简单，因扩展卡与公开卡同源），或该 case 回 -32004。选前者更省事但语义要诚实——扩展卡只是同一张卡的副本，宜**回 -32004** 并在 README 说明 |
| 3 | 向终态任务发消息（`SendMessage`/`SendStreamingMessage`）MUST 回 **-32004**（§3.1.1、§3.1.2） | `runMessage()`：`const existing = message.taskId === undefined ? undefined : store.get(message.taskId)`，不查状态即 `store.pushHistory` 并重跑该任务，覆盖其状态与历史 | 在 `runMessage` 取到 `existing` 后加 `if (isTerminal(existing.status.state)) throw a2aError(UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION', ...)`；注意 `TASK_STATE_INPUT_REQUIRED`/`AUTH_REQUIRED` 是**可继续**的中断态，不能一并拒绝 |
| 4 | 终态任务 `SubscribeToTask` MUST 回 **-32004**（§3.1.6） | `subscribe()` 中 `if (isTerminal(task.status.state)) { frames.send({ task: ... }); frames.close(); return }` | 改为在开 SSE 之前 `throw a2aError(UNSUPPORTED_OPERATION, ...)`——错误要在写响应头之前抛出，否则只能作为 SSE 帧送出（`streamMessage` 已有这个约束） |
| 5 | 不可取消状态 `CancelTask` MUST 回 `TaskNotCancelableError` **-32002**（§3.1.5） | `case 'CancelTask'`：`if (isTerminal(task.status.state)) { sendResult(res, rpc.id, structuredClone(task)); return }` | 新增 `TASK_NOT_CANCELABLE = -32002`，该分支改为抛错；reason 用 `TASK_NOT_CANCELABLE` |
| 6 | 客户端 MUST 发 `A2A-Version` 头；服务端 MUST 按请求版本处理、不支持时回 `VersionNotSupportedError`（§3.2.6、§3.6.1、§3.6.2） | `packages/a2a` 全仓无 `A2A-Version`（`grep -rn "A2A-Version" packages/a2a` 无结果）；`A2AClient.headers()` 只带 `X-Api-Key` | 客户端 `headers()` 加 `'A2A-Version': '1.0'`；服务端读该头（缺省/空值按规范视为 `0.3`），仅接受 `1.0`，否则回新的 `-32005`-之外的 `VersionNotSupportedError`——**该错误的 JSON-RPC 码需先查 §5.4 错误码映射表确认**，不要照抄其它码 |
| 7 | `contextId` 与 `taskId` 不匹配的消息 MUST 拒绝（§3.4.1） | `runMessage()` 只用 `taskId` 查任务，从不比较请求里的 `contextId` | `existing !== undefined && message.contextId !== undefined && message.contextId !== existing.contextId` 时抛 `INVALID_PARAMS`（`INVALID_ARGUMENT`）；同时确认"只给 taskId 时从任务推断 contextId"已满足（现状已满足） |

## 细节偏离（应修）

| # | 规范要求 | 现状 | 修法 |
| --- | --- | --- | --- |
| 8 | `ListTasks` MUST 按 status timestamp **降序**（§3.1.4） | `TaskStore.selected()` 返回 `[...this.tasks.values()]` 的插入序（最旧在前） | 在 `selected()` 末尾按 `task.status.timestamp` 降序排序；`count()` 复用同一函数，排序对它无影响 |
| 9 | `includeArtifacts: false` 时 `artifacts` 字段 MUST **整体省略**（§3.1.4） | `TaskStore.list()` 的 `.map(task => includeArtifacts ? task : { ...task, artifacts: [] })` | 改为解构丢弃：`const { artifacts, ...rest } = task; return rest`（注意类型：返回类型需放宽为 `Omit<A2ATask,'artifacts'> & { artifacts?: A2AArtifact[] }`） |
| 10 | 分页 MUST 为 cursor-based（§3.1.4） | `pageToken` 是 `offset.toString(36)`，服务端 `Number.parseInt(params.pageToken, 36)` | 换稳定游标：token 编码"上一页最后一行的 `(status.timestamp, id)`"，用它过滤后再取 `pageSize` 行；改动会碰到 `server.ts` 的 `ListTasks` 与 `task-store.ts` 的 `list/count` 签名，测试要同步 |
| 11 | `historyLength: 0` 时 `history` SHOULD 省略（§3.2.4，SHOULD 非 MUST） | `GetTask`：`result.history = historyLength <= 0 ? [] : task.history.slice(-historyLength)` | 与第 9 条同款解构丢弃；SELECT 级，可最后做 |

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
grep -rn "A2A-Version" packages/a2a                        # 现状：无结果
```

## 修复顺序建议

1. 先做 1、2、5（错误码常量与能力声明，纯增量，测试只需补断言）。
2. 再做 3、4、7（终态与上下文校验，会改现有用例预期：现有测试里"终态任务再发消息/订阅/取消"的用例要改成断言错误码）。
3. 然后 6（版本头，客户端 + 服务端两侧；先查 §5.4 确认 `VersionNotSupportedError` 的 JSON-RPC 码）。
4. 最后 8–11（列表排序、字段省略、游标分页）。
5. 每步随代码更新 `packages/a2a/a2a/README{,.zh}.md` 的 Known Limitations、`docs/subsystems/a2a.md`（生成物，跑 `pnpm run gen-cordis-catalog`）与本页状态。

## 关联

- 实现与决策：[A2A 端点与 peer（Agent Note）](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md)、子系统页 `docs/subsystems/a2a.md`
- 门禁债务登记：[fork 自研包的门禁红项清单](fork-gate-debt.md)
