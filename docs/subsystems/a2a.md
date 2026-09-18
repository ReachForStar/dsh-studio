# A2A (agent-to-agent)

English | [中文](a2a.zh.md)

A2A lets one harness deployment act as an agent another deployment can call, and lets this deployment call peers the same way. The wire is A2A v1.0.1 over JSON-RPC 2.0 with server-sent events for streaming, implemented on `node:http` alone: no SDK and no broker. Three packages split the roles — [dsh-a2a](../../packages/a2a/a2a) owns the wire and the peer registry (`ctx.a2a`), [dsh-a2a-host](../../packages/a2a/a2a-host) is the listener a profile mounts (`ctx.a2aHost`), and [dsh-tool-a2a](../../packages/a2a/tool-a2a) gives the model the two tools that call peers.

Source: [`packages/a2a/a2a/src/index.ts`](../../packages/a2a/a2a/src/index.ts)

## Peers are configuration, not model input

A peer is a name configured on `dsh-a2a` (URL, optional `apiKey` sent as `X-Api-Key`, optional `cardPath`, optional per-call `timeoutMs`). `ctx.a2a.resolve(ref)` turns that name into a call target; a reference naming no configured peer is treated as an endpoint URL, so an operator can call an unconfigured agent deliberately while the model never invents one. `a2a_peers` lists the names this deployment can call, and `a2a_send` sends one text message, optionally continuing an earlier task or context instead of starting a new exchange.

## Server half

`ctx.a2aHost` binds its own listener (loopback by default) and answers `POST /` with `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, and `GetExtendedAgentCard`; the four push-notification methods answer `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` rather than pretending. Messages addressed to terminal tasks and subscriptions to terminal tasks are refused with `-32004`, cancellation of a terminal task with `-32002`, and `GetExtendedAgentCard` answers `-32004` because the card declares no `extendedAgentCard`. Calls must carry `A2A-Version: 1.0`; an absent or empty header is 0.3 as the protocol assumes, and the server answers it with `-32009`. `GET /.well-known/agent-card.json` serves the advertised card and `GET /health` the liveness answer. A separate listener, not a prefix of the browser server, because peers discover it by `origin + /.well-known/agent-card.json`. Bodies are capped at 1 MiB, and a configured `apiKey` rejects a call without a matching `X-Api-Key` with `-32000`.

## Task and session identity

A task's `contextId` is the harness session it runs in, so a peer that sends a message with an earlier `contextId` resumes that session instead of starting a new one. A2A itself has no session concept beyond that identity, which is why the endpoint treats callers as trusted and gates them with `apiKey`: reaching it means naming a session in this deployment.

## Durability

Tasks live in a bounded in-memory store for the life of the process, with terminal tasks evicted; queries, cancellation, and subscription answer only for tasks this process created. Cross-restart delivery is the deployer's to build, and the session log stays the only durable record of what an agent did.

## Configuration

```yaml
- name: '@reachforstar/dsh-a2a'
  config:
    peers:
      reviewer:
        url: 'http://127.0.0.1:9311/'
        apiKey: '${REVIEWER_A2A_KEY}'
- name: '@reachforstar/dsh-a2a-host'
  config:
    port: 9310
    apiKey: '${DSH_A2A_API_KEY}'
    card:
      name: 'dsh-studio'
      description: 'DeepSeek Harness agent sessions'
```

Peer `url` is required; the rest default to unset (`cardPath` falls back to `/.well-known/agent-card.json`). The host endpoint's port, bind host, `apiKey`, and the card's identity are configuration, so a deployment that only calls outward mounts `dsh-a2a` without `dsh-a2a-host`.

## Related

- Package references: [dsh-a2a](../../packages/a2a/a2a/README.md), [dsh-a2a-host](../../packages/a2a/a2a-host/README.md), [dsh-tool-a2a](../../packages/a2a/tool-a2a/README.md)
- Group overview: [packages/a2a](../../packages/a2a/README.md)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxa2a--a2aservice"></a>

### `ctx.a2a` — `A2AService`

Peer registry and one-call vocabulary over the A2A client.

A reference is resolved against the configured peers first and treated as an endpoint URL otherwise, so a model or operator can address an agent this deployment never configured. Names are resolved per call rather than cached: a peer's endpoint and credentials are configuration, and a stale client would keep calling an endpoint the deployment has since changed.

```ts cordis-catalog
/**
 * Every configured peer name, in configuration order.
 * @returns the configured peer names.
 */
list(): string[]

/**
 * Resolve one peer reference to its configuration.
 * @param ref - a configured peer name, or an endpoint URL.
 * @returns the peer configuration to call.
 * @throws Error when the reference names no configured peer and is not a URL.
 */
resolve(ref: A2APeerRef): A2APeerConfig

/**
 * Send one text message to a peer and read its answer.
 * @param request - the peer, the message text, and any continuation.
 * @returns the peer's answer and the addressing that continues it.
 * @throws Error when the peer is unknown or the call fails.
 */
async send(request: A2ASendRequest): Promise<A2APeerReply>

/**
 * Read one peer's card.
 * @param ref - a configured peer name, or an endpoint URL.
 * @param signal - cancellation owned by the caller.
 * @returns the peer's card.
 */
async card(ref: A2APeerRef, signal?: AbortSignal): Promise<AgentCard>

/**
 * Read every peer's card, reporting each failure beside its peer.
 * @param signal - cancellation owned by the caller.
 * @returns one row per configured peer, in configuration order.
 */
async inspect(signal?: AbortSignal): Promise<A2APeerInfo[]>
```

Source: [`packages/a2a/a2a/src/index.ts`](../../packages/a2a/a2a/src/index.ts)

<a id="ctxa2ahost--a2ahostservice"></a>

### `ctx.a2aHost` — `A2AHostService`

The A2A endpoint this deployment serves.

Binding happens in A2AHostService.init: a port that cannot be taken fails the plugin's fiber at load, which is where a deployment learns that its advertised endpoint is not the one it is serving.

```ts cordis-catalog
/**
 * Create the executor and bind the listener.
 *
 * Called by {@link Service.init} when this class is mounted as a plugin and
 * by {@link apply} when the module is mounted; both paths must bind before
 * they resolve, so a deployment learns at boot that its advertised endpoint
 * is the one it serves.
 * @returns a promise resolved once the listener is bound.
 */
async start(): Promise<void>
```

Source: [`packages/a2a/a2a-host/src/index.ts`](../../packages/a2a/a2a-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
