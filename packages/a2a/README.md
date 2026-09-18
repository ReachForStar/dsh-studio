---
description: "Choose the A2A wire implementation, the host endpoint profile, and the model-facing peer tools."
kind: "package-group"
---

# a2a/ — agent-to-agent family

English | [中文](README.zh.md)

## Summary

The family makes one harness deployment both an A2A server and an A2A client: `a2a` carries the wire (A2A v1.0.1 over JSON-RPC 2.0 with SSE streaming) and the configured peer registry, `a2a-host` is the listener a profile mounts, and `tool-a2a` exposes peers to the model. All three are **product** packages. See the [A2A subsystem reference](../../docs/subsystems/a2a.md) for the generated service and event API.

## Table of Contents

- [Packages](#packages)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`a2a/`](a2a/README.md) | Implements the A2A wire (server, client, task store, agent card) and turns configured peers into named calls. | `ctx.a2a` |
| [`a2a-host/`](a2a-host/README.md) | Binds the advertised endpoint and drives the harness session a peer names through `DshA2AExecutor`. | `ctx.a2aHost` |
| [`tool-a2a/`](tool-a2a/README.md) | Gives the model `a2a_peers` (what this deployment can call) and `a2a_send` (one message to a named peer). | (registers two tools) |

A deployment that only calls outward mounts `a2a` alone; one that only answers peers mounts `a2a` + `a2a-host`. Peers come from configuration, never from the model.
