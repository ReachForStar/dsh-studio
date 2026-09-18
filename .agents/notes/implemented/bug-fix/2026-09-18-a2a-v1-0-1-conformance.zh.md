# Agent Note：把 A2A 端点修到 v1.0.1 MUST 符合

Status: implemented

[English](2026-09-18-a2a-v1-0-1-conformance.md) | 中文

## 问题

A2A 端点此前按「方法面完整」验收：v1.0.1 的 11 个 RPC 全部有应答。逐条对照规范 tag `v1.0.1` 后发现协议本身并不符合：7 处 MUST 级行为偏离，且 `A2A-Version` 头在链路的两侧都不存在。服务端会对发往终态任务的消息重新执行工作、提供自己从未声明的扩展卡片、把对已结束任务的取消应答为成功、把推送通知的拒绝映射到错误码、`ListTasks` 按插入序排序并用 offset 分页、以及在协议要求整体省略的字段上返回「存在但为空」。

## 决策

7 处 MUST 与 4 处细节偏离在 `@reachforstar/dsh-a2a`（外加 `@reachforstar/dsh-a2a-host` 的卡片）内原地修复；不加新依赖，不改变服务的方法集合。

- **错误码按规范 §5.4 映射。** 推送通知配置回 `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED`；取消终态任务回 `-32002 TASK_NOT_CANCELABLE`；不支持的协议版本回 `-32009`，reason 为 `FAILED_PRECONDITION`。`GetExtendedAgentCard` 因卡片未声明 `extendedAgentCard` 回 `-32004`——服务端以卡片为准，日后卡片声明了该能力即会提供服务。
- **终态校验是拒绝，且凡是流式方法，拒绝必须抢在响应头之前。** `runMessage` 拒绝发往终态任务（completed/failed/canceled/rejected；input-required 与 auth-required 仍可继续）的消息，一处覆盖 `SendMessage` 与 `SendStreamingMessage`。`SubscribeToTask` 在打开 SSE 流之前拒绝终态任务，错误以 JSON-RPC 应答形式返回；客户端 `subscribeToTask` 现在读取这种 JSON 拒绝，而不是把它解析成空流。
- **一个常量拥有版本。** `schema.ts` 的 `A2A_PROTOCOL_VERSION = '1.0'` 同时供客户端的 `A2A-Version` 头（每次调用，含读卡片）、服务端校验与卡片的接口版本。缺省或空头按规范视为 0.3，本端对 0.3 回 `-32009`；协商只比 `Major.Minor`，patch 后缀按 §3.6 忽略。
- **`ListTasks` 对齐 §3.1.4。** 行按 `status.timestamp` 降序，时间戳相同按任务 id 兜底；页 token 是末页行 `(timestamp, id)` 的 base64url JSON——token 不再指向任何行时以空页结束分页，格式非法的 token 回 `-32602`。`includeArtifacts: false` 整体省略 `artifacts` 字段——行类型为包内导出的 `A2ATaskRow`。`GetTask` 在 `historyLength: 0` 时省略 `history`（规范是 SHOULD，实现为字段直接不存在）。
- **寻址做校验。** `contextId` 与 `taskId` 所指任务不一致的消息回 `-32602 INVALID_ARGUMENT`；只给 `taskId` 时仍从任务推断 context。

## 备选方案

**声明 `extendedAgentCard: true` 并回一张公开卡的副本。** 调用能成功，但扩展卡本应比公开卡携带更多信息；以该能力之名回一份逐字节相同的副本是虚假声明。拒绝加 README 说明才是诚实的表面。

**用 1.0 语义宽容 0.3 请求。** 坏的 peer 更少，但 §3.6.2 对接口不支持的版本要求必须拒绝，且用新语义应答旧版本的请求正是这个头要防止的版本谎言。

**进程内存储保留 offset 分页。** 任务表至多 500 条，游标两种实现都便宜；但协议的 MUST 是 cursor-based，且 offset token 在任务被淘汰后也不稳定。

**`includeArtifacts: false` 时保留 `artifacts: []`。** 存在但为空更好写；但规范要求字段缺席，只有省略时消费方才能区分「没有工件」与「未索要」。

## 后果

从不发 `A2A-Version` 的客户端——0.3 时代的 peer 与没带头的手工调用——现在会被 `-32009` 拒绝；本部署自己的客户端永远发 `1.0`，README 记录了该要求。终态行为测试改为断言错误码，取代旧的「重新执行/回显」预期；`TaskStore.list` 增加游标参数并返回 `A2ATaskRow` 行——这是只有请求处理器消费的内部 API。延期面不变，仍在 README 声明：gRPC 与 HTTP+JSON 绑定、推送投递、扩展机制、卡片 JWS 签名、媒体类型校验、任务持久化。
