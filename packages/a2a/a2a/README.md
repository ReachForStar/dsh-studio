---
description: "The A2A wire implementation and peer seam: A2A v1.0.1 JSON-RPC 2.0 over HTTP with SSE streaming, the server peers call, the client this deployment calls peers with, and the configured peer registry."
kind: "package-reference"
---

# @reachforstar/dsh-a2a

English | [中文](README.zh.md)

## Summary

`dsh-a2a` makes one harness deployment both an A2A server and an A2A client. It carries A2A v1.0.1 over JSON-RPC 2.0 (`POST /`) with server-sent events for streaming, serves `GET /.well-known/agent-card.json` and `GET /health`, and keeps an in-memory task store so queries, cancellation, and subscription answer for tasks this process created. The client half calls a peer the same way, and the `a2a` service turns configured peers into named calls, so an operator names a remote agent once instead of writing its URL at each call site. Only `node:http` is used: no SDK, no message broker, and no third-party runtime dependency.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a host composition that also mounts the tool package when a model should call peers. Peers are configuration, not model input: the model addresses a name, and the deployment decides which endpoint that name is.

### When to choose it

Choose it to hand one agent's work to another agent, or to let a peer drive a session in this deployment. It is not a message bus and not a durable queue: tasks live in memory for the life of the process, and the session log stays the only durable record of what an agent did. Delivery guarantees across restarts are the deployer's to build.

### Minimal configuration

Peers are optional; an empty mapping serves the server half alone.

```yaml
- name: '@reachforstar/dsh-a2a'
  config:
    peers:
      reviewer:
        url: 'http://127.0.0.1:9311/'
        apiKey: '${REVIEWER_A2A_KEY}'
```

| Field | Default | Meaning |
|---|---|---|
| `peers.<name>.url` | required | Endpoint called for that peer |
| `peers.<name>.apiKey` | unset | Sent as `X-Api-Key` on every call to that peer |
| `peers.<name>.cardPath` | `/.well-known/agent-card.json` | Path the agent card is read from |
| `peers.<name>.timeoutMs` | unset | Per-call budget, including a stream's idle intervals |

The `a2a` service exposes `list()`, `resolve(ref)`, `send(request)`, `card(ref)`, and `inspect(signal)`. A reference that names no configured peer is treated as an endpoint URL, so an operator can call an unconfigured agent deliberately.

## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/schema.ts`](src/schema.ts) | A2A wire types: parts, messages, tasks, artifacts, stream events, agent card |
| [`src/server.ts`](src/server.ts) | Request handler and listener, SSE streaming, auth, error codes |
| [`src/client.ts`](src/client.ts) | `A2AClient`: card, send, stream, query, cancel, subscribe |
| [`src/task-store.ts`](src/task-store.ts) | Bounded in-memory task store with terminal-task eviction |
| [`src/index.ts`](src/index.ts) | `A2AService`, the peer registry, and the `Config` schema |

### Export shape

The module exports `name` / `inject` / `apply` and **no default export**: the Loader's `unwrapExports` collapses a module that has one, which drops `inject` and `Config` at load ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Protocol surface

`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, and `GetExtendedAgentCard` are served; the four push-notification methods answer `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` instead of pretending. Messages addressed to terminal tasks and subscriptions to terminal tasks are refused with `-32004`, cancellation of a terminal task with `-32002`, and `GetExtendedAgentCard` answers `-32004` because the card declares no `extendedAgentCard`. Requests must carry `A2A-Version: 1.0` — an absent or empty header is 0.3 as the protocol assumes, and this server answers it with `-32009`. Bodies are capped at 1 MiB, and a configured `apiKey` rejects a request without a matching `X-Api-Key` with `-32000`. The agent card advertises the JSONRPC interface only.

### Task identity

A task's `contextId` is the session it runs in, so a peer that reuses an earlier `contextId` continues that session. A2A has no session concept beyond that, which is why the host endpoint treats callers as trusted and gates them with `apiKey`.

## Further Exploration

- [`packages/a2a/a2a-host`](../a2a-host/README.md) — the listener a profile mounts, with its session-backed executor and advertised agent card.
- [`packages/a2a/tool-a2a`](../tool-a2a/README.md) — the two model-facing tools over these peers.
- [A2A specification](https://a2a-protocol.org/) — the upstream protocol this implementation follows.

## Known Limitations and Deferred Work

- **JSONRPC only.** gRPC and HTTP+JSON bindings are not served, and the agent card says as much.
- **No push notifications.** The four configuration methods answer `-32003`; a caller needing push polls `GetTask` or holds a `SubscribeToTask` stream.
- **No extended agent card.** The card declares no `extendedAgentCard`, so `GetExtendedAgentCard` answers `-32004`.
- **Strict versioning.** Only `A2A-Version: 1.0` is served; an absent or empty header is 0.3 as the protocol assumes, and this server answers it with `-32009`.
- **Tasks are process-local.** The store keeps at most 500 tasks, evicting the oldest terminal ones, so a restart forgets them; durable history is the session log.
- **One retry on the client.** A stream cut before its first frame is retried once; later cuts surface as errors instead of resuming mid-stream.

### Dev Note

The [A2A endpoint and peers Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md) records the decision to hand-write the protocol over `node:http` instead of adopting the SDK, the session-mapping choice, and the Loader pitfall found while wiring the profile.
