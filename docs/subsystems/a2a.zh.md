# A2A（agent-to-agent）

[English](a2a.md) | 中文

A2A 让一个 harness 部署成为别的部署可以调用的 agent，也让本部署以同样方式调用 peer。协议是 A2A v1.0.1，走 JSON-RPC 2.0，流式用 server-sent events，只用 `node:http` 实现：没有 SDK、没有消息中间件。三个包分担职责——[dsh-a2a](../../packages/a2a/a2a) 拥有协议与 peer 注册表（`ctx.a2a`），[dsh-a2a-host](../../packages/a2a/a2a-host) 是 profile 挂载的监听端（`ctx.a2aHost`），[dsh-tool-a2a](../../packages/a2a/tool-a2a) 给模型两个调用 peer 的工具。

Source: [`packages/a2a/a2a/src/index.ts`](../../packages/a2a/a2a/src/index.ts)

## peer 是配置，不是模型输入

peer 是配置在 `dsh-a2a` 上的名字（URL、可选的 `apiKey`（以 `X-Api-Key` 发送）、可选 `cardPath`、可选单次调用预算 `timeoutMs`）。`ctx.a2a.resolve(ref)` 把名字变成调用目标；不匹配任何已配置 peer 的引用被当作端点 URL 处理，因此运维可以刻意调用未配置的 agent，而模型永远不会自己发明一个。`a2a_peers` 列出本部署可调用的名字，`a2a_send` 发一条文本消息，并可通过续接参数继续此前任务或上下文，而不是重新开始一次对话。

## 服务端半边

`ctx.a2aHost` 绑定自己的监听端（默认回环），对 `POST /` 应答 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`SubscribeToTask` 与 `GetExtendedAgentCard`；四个推送通知方法返回 `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED` 而不是假装支持。发往终态任务的消息、订阅终态任务分别以 `-32004` 拒绝，取消终态任务以 `-32002` 拒绝；卡片未声明 `extendedAgentCard`，`GetExtendedAgentCard` 回 `-32004`。调用必须带 `A2A-Version: 1.0`；缺省或空值按规范视为 0.3，服务端以 `-32009` 拒绝。`GET /.well-known/agent-card.json` 提供对外宣告的 agent card，`GET /health` 提供存活应答。它是独立监听端而非浏览器服务器的前缀，因为 peer 按 `origin + /.well-known/agent-card.json` 发现它。请求体上限 1 MiB；配置了 `apiKey` 时，缺少匹配 `X-Api-Key` 的调用以 `-32000` 被拒绝。

## 任务与会话标识

任务的 `contextId` 就是它运行的 harness 会话，因此带此前 `contextId` 发来消息的 peer 会继续那个会话，而不是新开一个。A2A 本身没有超出这层标识的会话概念，所以该端点把调用方视为可信并用 `apiKey` 把关：能访问它就等于能指名本部署的一个会话。

## 持久性

任务存放在进程生命周期内的有界内存存储中，终态任务会被淘汰；查询、取消与订阅只对此进程创建过的任务作答。跨重启投递由部署方自行构建，会话日志仍是 agent 所做事情的唯一持久记录。

## 配置

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

peer 的 `url` 必填，其余默认未设置（`cardPath` 回落到 `/.well-known/agent-card.json`）。监听端的端口、绑定地址、`apiKey` 与 card 身份都是配置；只向外调用的部署挂 `dsh-a2a` 即可，不必挂 `dsh-a2a-host`。

## 相关

- 包文档：[dsh-a2a](../../packages/a2a/a2a/README.zh.md)、[dsh-a2a-host](../../packages/a2a/a2a-host/README.zh.md)、[dsh-tool-a2a](../../packages/a2a/tool-a2a/README.zh.md)
- 分组总览：[packages/a2a](../../packages/a2a/README.zh.md)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
