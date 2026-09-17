# Agent Note: Serve A2A over `node:http` and keep peers in configuration

Status: implemented

English | [中文](2026-09-17-a2a-endpoint-and-peers.zh.md)

## Problem

The fork needed to talk to other agents: accept work from a peer and hand work to one. The published `@a2a-js/sdk` brings a dependency tree, a protobuf/gRPC binding nothing here would use, and an Express-shaped server; a message broker would add an operational component for a harness that already has a durable session log. The protocol itself is a JSON-RPC 2.0 POST, an SSE stream, and an agent card — small enough to own, and the parts that matter here (task identity, streaming frames, cancellation) are exactly the parts a session-backed executor must map onto its own events.

## Decision

Three packages own the feature and no third-party runtime dependency is added — the server and client are `node:http` alone:

- `@reachforstar/dsh-a2a` holds the A2A v1.0.1 wire types, a request handler and listener, a client, a bounded in-memory task store, and the `a2a` service. It serves `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, and `GetExtendedAgentCard`; the four push-notification methods answer `-32004 UNSUPPORTED_OPERATION` rather than pretending. Bodies are capped at 1 MiB and a configured `apiKey` rejects requests without a matching `X-Api-Key`. The card advertises the JSONRPC interface only, because that is the binding this server implements.
- `@reachforstar/dsh-a2a-host` binds the endpoint a profile mounts, builds the advertised card, and drives sessions through `DshA2AExecutor`. It owns a listener of its own (loopback by default, port 9310) instead of hanging off the browser server: peers discover an agent by `origin + /.well-known/agent-card.json`, so a path prefix would force every peer to configure a nonstandard card path.
- `@reachforstar/dsh-tool-a2a` exposes `a2a_peers` and `a2a_send`. Peers are configuration only; a tool call cannot register one, which keeps outbound calls inside approved endpoints.

A task's `contextId` is the harness session id. `SessionId` is a branded string with no format rule of its own, so a peer that reuses a `contextId` resumes that session, and the deployment-wide `apiKey` is the trust boundary for an endpoint that lets a caller name sessions. A2A turns complete at the durable `turn/end` event rather than at an idle heuristic, and the executor consumes frames only after its own `user/message` — matched by `source.rpcId` against the request id it minted — so a concurrent turn driven by another client is neither misattributed nor swallowed.

## Alternatives considered

**Adopt the official SDK.** It would replace the wire types and the SSE framing with maintained code, at the cost of gRPC/protobuf dependencies this deployment does not serve, an Express server the harness has no other use for, and a mapping layer between its task model and session events that is the substance of this work anyway.

**Run a broker between agents.** Kafka or a queue adds an operational component and a delivery model the session log already provides for local work; it does not answer what a task *is* in harness terms.

**Mount the endpoint under the browser server's path prefix.** One listener is fewer moving parts, but peers that follow the spec's discovery path would each need a custom card path.

**Let the model register peers.** Convenient for ad-hoc calls, and a way for prompt content to point outbound traffic at an endpoint no operator approved.

## Consequences

The protocol surface is owned here: a future A2A revision is this code's to update, and the gRPC and HTTP+JSON bindings stay unserved and unclaimed in the card. Tasks live in memory (at most 500, evicting oldest terminal ones), so cross-restart history stays in the session log; push notifications are refused rather than emulated. Wiring the profile surfaced a load-time pitfall worth recording next to the packages: all three modules must export `name` / `inject` / `apply` and **no default export**, because the Loader's `unwrapExports` collapses a module that has one, silently dropping `inject` and the `Config` schema, which surfaces as `cannot get property "tools" without inject` and `Cannot read properties of undefined (reading 'peers')` at startup ([postmortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).
