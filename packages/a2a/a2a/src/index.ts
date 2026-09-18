import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { A2AClient } from './client.ts'
import { textOf } from './schema.ts'
import type { AgentCard, A2ATask } from './schema.ts'
import type { A2APeerCall, A2APeerConfig, A2APeerInfo, A2APeerRef, A2APeerReply } from './types.ts'

export { A2AClient } from './client.ts'
export type { A2AClientMessage, A2AClientOptions, A2ATaskPage } from './client.ts'
export { createA2ARequestHandler, createA2AServer } from './server.ts'
export type { A2AExecutor, A2AExecutorContext, A2ARequestHandlerOptions, A2AServer, A2AServerOptions, A2AStreamSink } from './server.ts'
export { isTerminal, textOf } from './schema.ts'
export type * from './schema.ts'
export { TaskStore } from './task-store.ts'
export type { TaskStoreOptions } from './task-store.ts'
export type {
  A2APeerCall,
  A2APeerConfig,
  A2APeerInfo,
  A2APeerRef,
  A2APeerReply,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    a2a: A2AService
  }
}

/** One configured peer. */
const peerSchema = z.object({
  url: z.string().required(),
  apiKey: z.string(),
  cardPath: z.string(),
  timeoutMs: z.number(),
})

/** Plugin configuration: the peers this deployment may call. */
export interface Config {
  /** Remote agents by caller-facing name. */
  peers?: Record<string, A2APeerConfig>
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  peers: z.dict(peerSchema).default({}),
})

/** One peer call, as the seam accepts it. */
export interface A2ASendRequest extends A2APeerCall {
  /** Configured peer name, or an endpoint URL. */
  readonly peer: A2APeerRef
  /** Message text to send. */
  readonly text: string
}

/**
 * Peer registry and one-call vocabulary over the A2A client.
 *
 * A reference is resolved against the configured peers first and treated as an
 * endpoint URL otherwise, so a model or operator can address an agent this
 * deployment never configured. Names are resolved per call rather than cached:
 * a peer's endpoint and credentials are configuration, and a stale client would
 * keep calling an endpoint the deployment has since changed.
 */
export class A2AService extends Service {
  private readonly peers: Readonly<Record<string, A2APeerConfig>>

  /**
   * @param ctx - the owning host context.
   * @param config - configured peers.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'a2a')
    this.peers = Object.fromEntries(Object.entries(config.peers ?? {}).map(([name, peer]) => {
      if (name.length === 0) throw new Error('a2a: peer names must be non-empty')
      if (peer.url.length === 0) throw new Error(`a2a: peer "${name}" has an empty url`)
      return [name, peer]
    }))
  }

  /**
   * Every configured peer name, in configuration order.
   * @returns the configured peer names.
   */
  list(): string[] {
    return Object.keys(this.peers)
  }

  /**
   * Resolve one peer reference to its configuration.
   * @param ref - a configured peer name, or an endpoint URL.
   * @returns the peer configuration to call.
   * @throws Error when the reference names no configured peer and is not a URL.
   */
  resolve(ref: A2APeerRef): A2APeerConfig {
    if (ref.length === 0) throw new Error('an A2A peer must be named or given a URL')
    const configured = this.peers[ref]
    if (configured !== undefined) return configured
    if (/^https?:\/\//.test(ref)) return { url: ref }
    const known = this.list()
    throw new Error(`no A2A peer named "${ref}"; configured peers are ${known.length === 0 ? '(none)' : known.join(', ')}`)
  }

  /** The client one peer configuration addresses. */
  private clientOf(peer: A2APeerConfig): A2AClient {
    return new A2AClient({
      url: peer.url,
      ...peer.apiKey === undefined ? {} : { apiKey: peer.apiKey },
      ...peer.timeoutMs === undefined ? {} : { timeoutMs: peer.timeoutMs },
    })
  }

  /**
   * Send one text message to a peer and read its answer.
   * @param request - the peer, the message text, and any continuation.
   * @returns the peer's answer and the addressing that continues it.
   * @throws Error when the peer is unknown or the call fails.
   */
  async send(request: A2ASendRequest): Promise<A2APeerReply> {
    const peer = this.resolve(request.peer)
    const task = await this.clientOf(peer).sendMessage({
      text: request.text,
      ...request.contextId === undefined ? {} : { contextId: request.contextId },
      ...request.taskId === undefined ? {} : { taskId: request.taskId },
    }, request.signal)
    return replyOf(task)
  }

  /**
   * Read one peer's card.
   * @param ref - a configured peer name, or an endpoint URL.
   * @param signal - cancellation owned by the caller.
   * @returns the peer's card.
   */
  async card(ref: A2APeerRef, signal?: AbortSignal): Promise<AgentCard> {
    const peer = this.resolve(ref)
    return await this.clientOf(peer).getCard({
      ...peer.cardPath === undefined ? {} : { path: peer.cardPath },
      ...signal === undefined ? {} : { signal },
    })
  }

  /**
   * Read every peer's card, reporting each failure beside its peer.
   * @param signal - cancellation owned by the caller.
   * @returns one row per configured peer, in configuration order.
   */
  async inspect(signal?: AbortSignal): Promise<A2APeerInfo[]> {
    return await Promise.all(Object.entries(this.peers).map(async ([name, peer]) => {
      try {
        const card = await this.card(name, signal)
        return { name, url: peer.url, title: card.name }
      } catch (error) {
        return { name, url: peer.url, error: error instanceof Error ? error.message : String(error) }
      }
    }))
  }
}

/**
 * Read one task answer as a reply: the artifacts it produced, else its status
 * message, else the last agent message in its history.
 * @param task - the task the peer returned.
 * @returns the answer text and the addressing that continues it.
 */
export function replyOf(task: A2ATask): A2APeerReply {
  const fromArtifacts = task.artifacts
    .flatMap(artifact => artifact.parts)
    .map(part => part.text ?? '')
    .join('')
  const fromStatus = textOf(task.status.message?.parts)
  const fromHistory = [...task.history].reverse()
    .filter(message => message.role === 'ROLE_AGENT')
    .map(message => textOf(message.parts))
    .find(text => text.length > 0)
  return {
    text: fromArtifacts.length > 0 ? fromArtifacts : fromStatus.length > 0 ? fromStatus : fromHistory ?? '',
    taskId: task.id,
    contextId: task.contextId,
    state: task.status.state,
  }
}

/**
 * Register the peer seam.
 * @param ctx - the owning host context.
 * @param config - configured peers.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(A2AService, config)
}
