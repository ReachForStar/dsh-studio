---
description: "The A2A host endpoint a profile mounts: an advertised agent card, an authenticated listener, and an executor that drives the harness session a peer names."
kind: "package-reference"
---

# @reachforstar/dsh-a2a-host

English | [中文](README.zh.md)

## Summary

`dsh-a2a-host` is the listener half a deployment mounts: it builds the agent card, binds an HTTP endpoint (loopback by default), authenticates callers when an `apiKey` is configured, and answers A2A requests by driving a harness session through `DshA2AExecutor`. A peer that sends a message with a `contextId` reaches the session of that id, so the peer resumes work where it left off rather than starting a new one. The endpoint is a separate listener, not a prefix of the browser server, because peers discover it by `origin + /.well-known/agent-card.json`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a profile that already mounts the session controller. The port, host, credentials, and the card's identity are configuration; the executor's behavior follows the session it drives.

### When to choose it

Choose it when this deployment should be reachable as an A2A agent. A deployment that only calls outward needs [`dsh-a2a`](../a2a/README.md) alone. Because the endpoint is trusted to name sessions, bind it to loopback or behind a gateway, and set `apiKey` whenever anything else can reach it.

### Minimal configuration

```yaml
- name: '@reachforstar/dsh-a2a-host'
  config:
    port: 9310
    apiKey: '${DSH_A2A_API_KEY}'
    card:
      name: 'dsh-studio'
      description: 'DeepSeek Harness agent sessions'
```

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Interface to bind |
| `port` | `9310` | Port; `0` takes an OS-assigned port and rewrites the card's interface URL |
| `apiKey` | unset | When set, requests must carry a matching `X-Api-Key` |
| `url` | derived from host and port | Endpoint the card advertises; set it when a proxy fronts the listener |
| `cwd` | unset | Working directory for sessions the endpoint drives |
| `agentPreset` | unset | Agent preset those sessions run with |
| `turnTimeoutMs` | 30 minutes | Budget for one A2A turn before the executor cancels it |
| `card` | built-in identity | Name, description, version, documentation URL, and skills on the agent card |

`apply` awaits the bind, so a deployment learns at boot that its advertised endpoint is the one it serves; a port already in use fails the composition instead of starting a listener nobody can reach.

## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `A2AHostService`: card, listener, lifetime, and `Config` |
| [`src/executor.ts`](src/executor.ts) | `DshA2AExecutor`: session follow, prompt, streaming, cancel, timeout |
| [`src/card.ts`](src/card.ts) | `buildAgentCard` and the default skill |

### Export shape

The module exports `name` / `inject` / `apply` and **no default export**: the Loader's `unwrapExports` collapses a module that has one, which drops `inject` and `Config` at load ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Turn mechanics

The executor mints a request id, subscribes to the session's event stream, and only then prompts it — the opening snapshot plus the frames that follow leave no gap, and a turn this prompt starts cannot be missed. It consumes frames after its own durable `user/message`, matching that event's `source.rpcId` to the request id it minted, so a concurrent turn driven by another client is neither attributed to this task nor swallowed by it. A turn ends at the durable `turn/end`; `onCancel` aborts the subscription and cancels the session's turn.

## Further Exploration

- [`packages/a2a/a2a`](../a2a/README.md) — the protocol, server, client, and peer registry this endpoint is built on.
- [`packages/api/session-controller`](../../api/session-controller/README.md) — the session API the executor drives.

## Known Limitations and Deferred Work

- **One endpoint per process.** The service binds a listener of its own; a second mount in the same process collides on the port unless `port: 0` is used.
- **No push notifications.** The host does not register webhook targets, so peers poll or subscribe as [`dsh-a2a`](../a2a/README.md) documents.
- **Sessions are named by the caller.** A trusted peer names any session id; there is no per-session authorization beyond the deployment-wide `apiKey`.
- **Text in, text out.** Only text parts are turned into prompts, and the reply is text; files and structured parts are not translated.

### Dev Note

The [A2A endpoint and peers Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md) records why the endpoint owns a listener instead of hanging off the browser server, and how `contextId` became the session id.
