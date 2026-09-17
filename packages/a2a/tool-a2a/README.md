---
description: "The two model-facing A2A tools: list the peers this deployment can call, and send one message to a named peer with optional task continuation."
kind: "package-reference"
---

# @reachforstar/dsh-tool-a2a

English | [中文](README.zh.md)

## Summary

`dsh-tool-a2a` gives the agent two tools over the peers configured for [`dsh-a2a`](../a2a/README.md): `a2a_peers` lists what this deployment can call, and `a2a_send` sends one text message to a named peer, returning that peer's reply. Continuation arguments let a follow-up message resume the same remote task or context, so a short exchange does not restart the other agent. Peers come from configuration only — the model cannot register one, which keeps outbound calls inside the endpoints an operator approved.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside [`dsh-a2a`](../a2a/README.md) and the tools registry. The tools take no extra configuration: the peer list is whatever `a2a` was configured with.

### When to choose it

Choose it when the agent should hand work to another agent or ask one a question. A deployment that only serves A2A requests needs [`dsh-a2a-host`](../a2a-host/README.md) and not this package. Mount it when the model should not need a URL: the deployment decides what each peer name means.

### Minimal configuration

No configuration of its own; peers belong to [`dsh-a2a`](../a2a/README.md).

```yaml
- name: '@reachforstar/dsh-tool-a2a'
```

### What each call does

`a2a_peers` returns every configured peer with its name, endpoint, and the display name from its published card; a peer whose card cannot be read is reported with that error beside it rather than failing the listing. `a2a_send` takes a peer name, a text message, and optional `contextId` and `taskId` to continue earlier work; it answers with the peer's reply text plus the identifiers a follow-up needs. A peer that fails is reported as a failed tool result naming the reason, so the model can correct the call instead of losing the turn.

## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `name` / `inject` / `apply` and both tool definitions |

### Export shape

The module exports `name` / `inject` / `apply` and **no default export**: the Loader's `unwrapExports` collapses a module that has one, which drops `inject` at load ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Peers stay configuration

The tools read peers through the `a2a` service; nothing in a tool call can add one. That is deliberate: a model-driven peer registration would let a prompt point outbound calls at an endpoint no operator approved.

## Further Exploration

- [`packages/a2a/a2a`](../a2a/README.md) — the peer registry and client these tools call.
- [`packages/a2a/a2a-host`](../a2a-host/README.md) — the endpoint that makes this deployment callable in turn.
- [`docs/tool-catalog.md`](../../../docs/tool-catalog.md) — the generated catalog of every tool a composition can expose.

## Model Experience

### Tools

#### What the model sees

Two tool definitions, each with its own description and JSON schema: `a2a_peers` takes no arguments, and `a2a_send` takes `peer`, `message`, and optional `contextId` / `taskId`. Both descriptions state what the call does and what the result means; the peer list itself reaches the model as tool output, not as prompt text.

#### Token effect

Each mounted tool costs its schema and description in every request that sees it. Results are bounded by the peer's reply: `a2a_peers` lists at most the configured peers, and `a2a_send` returns one reply's text.

#### KV Cache effect

The definitions are static for the life of the composition, so they stay in the cached prefix; peer names and replies arrive as messages, which append after it without invalidating it.

## Known Limitations and Deferred Work

- **Text only.** Requests carry text parts and replies are read as text; files and structured parts are neither sent nor rendered.
- **No streaming to the model.** `a2a_send` waits for the peer's turn to finish, so a long remote turn reaches the model as one result rather than as increments.
- **One message per call.** Continuation is explicit through `contextId` / `taskId`; there is no conversation object the model can keep open.
- **No peer registration from a call.** A peer must be configured before the model can address it, and an unconfigured name fails the call.

### Dev Note

The [A2A endpoint and peers Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-a2a-endpoint-and-peers.md) records why the tools take peers from configuration only and how failures surface as tool results.
