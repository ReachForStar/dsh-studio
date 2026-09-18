# Agent Note: Bring the A2A endpoint to v1.0.1 MUST conformance

Status: implemented

English | [中文](2026-09-18-a2a-v1-0-1-conformance.zh.md)

## Problem

The A2A endpoint was judged complete at the method surface: all eleven v1.0.1 RPCs answer. A line-by-line review against the specification tag `v1.0.1` found the protocol itself was not conformed: seven MUST-level behaviors deviated, and the `A2A-Version` header did not exist on either side of the wire. The server re-ran work for messages addressed to terminal tasks, served an extended card it never declared, answered cancellations of finished tasks as success, mapped push-notification refusals to the wrong code, sorted `ListTasks` in insertion order with offset pagination, and kept `artifacts`/`history` fields present-but-empty where the protocol says to omit them.

## Decision

All seven MUST and four detail deviations are fixed in place in `@reachforstar/dsh-a2a` (plus the card in `@reachforstar/dsh-a2a-host`); no new dependency and no change to the served method set.

- **Error codes follow the spec's §5.4 mapping.** Push-notification configuration answers `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED`; canceling a task in a terminal state answers `-32002 TASK_NOT_CANCELABLE`; an unsupported protocol version answers `-32009` with reason `FAILED_PRECONDITION`. `GetExtendedAgentCard` answers `-32004` because the card declares no `extendedAgentCard` — the server honors the card, so a card that later declares the capability would serve it.
- **Terminal-state guards reject, and where the protocol streams, the rejection must beat the response headers.** `runMessage` refuses messages addressed to terminal tasks (completed/failed/canceled/rejected; input-required and auth-required stay continuable), which covers `SendMessage` and `SendStreamingMessage` at once. `SubscribeToTask` refuses a terminal task before opening the SSE stream, so the error travels as a JSON-RPC response; the client's `subscribeToTask` now reads such a JSON refusal instead of parsing it as an empty stream.
- **One constant owns the version.** `A2A_PROTOCOL_VERSION = '1.0'` in `schema.ts` feeds the client's `A2A-Version` header (every call, including the card read), the server's validation, and the card's interface version. An absent or empty header is 0.3 as the protocol assumes, and this server answers 0.3 with `-32009`; negotiation compares `Major.Minor`, so a patch suffix is ignored per §3.6.
- **`ListTasks` matches §3.1.4.** Rows sort by `status.timestamp` descending with the task id breaking ties; the page token is the base64url JSON of the last row's `(timestamp, id)`, so a token that no longer names a row ends pagination with an empty page and a malformed one is `-32602`. `includeArtifacts: false` omits the `artifacts` field entirely — the row type is `A2ATaskRow`, exported from the package. `GetTask` with `historyLength: 0` omits `history` (the spec's SHOULD, implemented as the field simply not being there).
- **Addressing is checked.** A message whose `contextId` disagrees with the task its `taskId` names is `-32602 INVALID_ARGUMENT`; a `taskId` alone still infers the task's context.

## Alternatives considered

**Declare `extendedAgentCard: true` and serve a copy of the public card.** It makes the call succeed, but the extended card is meant to carry more than the public one; serving a byte-identical copy under the capability is a false advertisement. The refusal plus a README note is the honest surface.

**Tolerate 0.3 requests with 1.0 semantics.** Fewer broken peers, but §3.6.2 makes the refusal mandatory for a version the interface does not serve, and answering an old version's request with new semantics is the version lie the header exists to prevent.

**Keep offset pagination for the in-memory store.** The table holds at most 500 tasks, so the cursor is cheap either way; the protocol's MUST is cursor-based, and the offset token was also unstable across task eviction.

**Leave `artifacts: []` for `includeArtifacts: false`.** Present-but-empty is easier to code; the spec says the field must be absent, and consumers can distinguish "no artifacts" from "not asked for" only when it is omitted.

## Consequences

Clients that never send `A2A-Version` — 0.3-era peers and hand-rolled calls without the header — are now refused with `-32009`; this deployment's own client always sends `1.0`, and the README records the requirement. Terminal-task behavior tests now assert the error codes instead of the old re-run/echo results, and `TaskStore.list` gained the cursor parameter with `A2ATaskRow` rows — an internal API consumed only by the request handler. The deferred surfaces are unchanged and stay declared in the README: gRPC and HTTP+JSON bindings, push delivery, the extension mechanism, card JWS signatures, media-type validation, and task persistence.
