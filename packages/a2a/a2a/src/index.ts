import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { A2AClient } from './client.ts'
import { createA2ABus } from './bus.ts'
import { loadA2ABridgeConfig } from './bridge-config.ts'
import { isTerminal, textOf } from './schema.ts'
import type { A2ABus, A2ABusHandle } from './bus.ts'
import type { A2ABridgeConfig } from './bridge-config.ts'
import type { AgentCard, A2ATask, BusEvent, BusTask } from './schema.ts'
import type { A2APeerCall, A2APeerConfig, A2APeerInfo, A2APeerRef, A2APeerReply } from './types.ts'

export { A2AClient } from './client.ts'
export type { A2AClientMessage, A2AClientOptions, A2ATaskPage } from './client.ts'
export { createA2ABus } from './bus.ts'
export type { A2ABus, A2ABusConfig, A2ABusHandle, A2ABusOptions, A2AConsumeOptions } from './bus.ts'
export { loadA2ABridgeConfig } from './bridge-config.ts'
export type { A2ABridgeAgent, A2ABridgeAgents, A2ABridgeConfig, A2ABridgeConfigSource, A2ABridgeSkills } from './bridge-config.ts'
export { createA2ARequestHandler, createA2AServer } from './server.ts'
export type { A2AExecutor, A2AExecutorContext, A2ARequestHandlerOptions, A2AServer, A2AServerOptions, A2AStreamSink } from './server.ts'
export { A2A_PROTOCOL_VERSION, isTerminal, textOf } from './schema.ts'
export type * from './schema.ts'
export { TaskStore } from './task-store.ts'
export type { A2ATaskRow, TaskCursor, TaskStoreOptions } from './task-store.ts'
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

/** The bridge deployment this harness dispatches into. */
const bridgeSchema = z.object({
  configPath: z.string(),
  agent: z.string(),
})

/** Plugin configuration: the peers this deployment may call. */
export interface Config {
  /** Remote agents by caller-facing name. */
  peers?: Record<string, A2APeerConfig>
  /**
   * Bridge deployment to dispatch into. When set, its configuration file
   * supplies the three agent endpoints, their skills, and the bus topics, so a
   * deployment does not restate them here.
   */
  bridge?: {
    /** Path of the bridge's `config.json`; defaults to the `A2A_CONFIG` environment variable. */
    configPath?: string
    /** Name this harness publishes tasks as; defaults to `dsh`. */
    agent?: string
  }
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  peers: z.dict(peerSchema).default({}),
  bridge: bridgeSchema,
})

/** One peer call, as the seam accepts it. */
export interface A2ASendRequest extends A2APeerCall {
  /** Configured peer name, or an endpoint URL. */
  readonly peer: A2APeerRef
  /** Message text to send. */
  readonly text: string
  /** Peer-defined message metadata, such as the skill the agent should select. */
  readonly metadata?: Record<string, unknown>
}

/** One progress report from a running dispatch: the latest state and cumulative answer text. */
export interface A2ADispatchProgress {
  /** Latest task state the peer reported, when it has reported one. */
  readonly state?: string
  /** Answer text accumulated so far from the peer's artifacts. */
  readonly text: string
}

/** One task dispatched into a bridge deployment. */
export interface A2ADispatchRequest {
  /** Bridge agent name: `pi`, `claude-code`, or `opencode`. */
  readonly agent: string
  /** Skill the agent selects its instructions and tools from. */
  readonly skill: string
  /** Task text. */
  readonly text: string
  /** Working directory the agent runs in; omitted uses the agent's default. */
  readonly workspace?: string
  /** Conversation to continue; omitted starts one. */
  readonly contextId?: string
  /**
   * Channel the task travels on: `direct` waits for the answer, `bus`
   * publishes the task and returns once it is claimed or finished.
   */
  readonly mode?: 'direct' | 'bus'
  /** Whether a `bus` dispatch waits for the terminal event before returning. */
  readonly wait?: boolean
  /** How long the call may take, in milliseconds. */
  readonly timeoutMs?: number
  /** Cancellation owned by the caller. */
  readonly signal?: AbortSignal
  /**
   * Receives one report per state or text change while the task runs. Direct
   * mode forwards the peer's stream frames; bus mode forwards the
   * deployment's event frames. The report is advisory: a direct-channel
   * reporter failure fails the dispatch, while the bus channel contains it
   * with the bus's documented event-handler containment.
   */
  readonly onProgress?: (progress: A2ADispatchProgress) => void
}

/** What one dispatch answered with. */
export interface A2ADispatchReply extends A2APeerReply {
  /** Agent the task was addressed to. */
  readonly agent: string
  /** Skill the task selected on that agent. */
  readonly skill: string
  /** Channel the task travelled on. */
  readonly mode: 'direct' | 'bus'
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
  private readonly bridge: A2ABridgeConfig | undefined
  private readonly agent: string
  private bus: A2ABus | undefined
  private topicsReady = false

  /**
   * @param ctx - the owning host context.
   * @param config - configured peers and the bridge deployment to dispatch into.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'a2a')
    this.bridge = this.bridgeOf(config.bridge)
    this.agent = config.bridge?.agent ?? 'dsh'
    const explicit = Object.fromEntries(Object.entries(config.peers ?? {}).map(([name, peer]) => {
      if (name.length === 0) throw new Error('a2a: peer names must be non-empty')
      if (peer.url.length === 0) throw new Error(`a2a: peer "${name}" has an empty url`)
      return [name, peer]
    }))
    // The bridge answers for its own three agents, so its file is where their
    // endpoints come from; a peer configured here overrides one by name.
    this.peers = { ...peersOf(this.bridge), ...explicit }
  }

  /** The bridge deployment this harness dispatches into, when one is configured. */
  get bridgeConfig(): A2ABridgeConfig | undefined {
    return this.bridge
  }

  /**
   * Skills one agent accepts, as the deployment's skill maps declare them.
   * @param agent - bridge agent name.
   * @returns the agent's skill ids, empty for a name the deployment does not run.
   */
  skills(agent: string): string[] {
    const skills = this.bridge?.skills as Record<string, string[]> | undefined
    return skills?.[agent] ?? []
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
      ...request.metadata === undefined ? {} : { metadata: request.metadata },
    }, request.signal)
    return replyOf(task)
  }

  /**
   * Dispatch one task into the bridge deployment.
   *
   * `direct` streams the answer back over JSON-RPC and returns when the task
   * reaches a terminal state; `bus` publishes the task to the deployment's
   * topic and returns as soon as it is claimed, or at the terminal event when
   * the caller asks to wait. A bus task outlives this process, so its text is
   * whatever the event stream delivered before the call returned.
   * @param request - the agent, skill, task text, and channel to use.
   * @returns the answer text and the addressing that continues the conversation.
   * @throws Error when no bridge is configured, the agent is unknown, or the call fails.
   */
  async dispatch(request: A2ADispatchRequest): Promise<A2ADispatchReply> {
    const bridge = this.requireBridge(request.agent)
    const skill = request.skill
    const mode = request.mode ?? 'direct'
    const timeoutMs = request.timeoutMs ?? bridge.taskTimeoutMs
    if (mode === 'bus') return await this.dispatchOverBus(request, bridge, skill, timeoutMs)
    const peer = this.resolve(request.agent)
    let text = ''
    let task: A2ATask | undefined
    let lastState: string | undefined
    for await (const event of this.clientOf(peer).sendMessageStream({
      text: request.text,
      ...request.contextId === undefined ? {} : { contextId: request.contextId },
      metadata: {
        skill,
        ...request.workspace === undefined ? {} : { workspace: request.workspace },
      },
    }, request.signal)) {
      if ('task' in event) task = event.task
      if ('artifactUpdate' in event) {
        text += textOf(event.artifactUpdate.artifact.parts)
        request.onProgress?.({ ...lastState === undefined ? {} : { state: lastState }, text })
      }
      if ('statusUpdate' in event) {
        const state = event.statusUpdate.status.state
        const stateChanged = state !== lastState
        lastState = state
        // A failing gateway reports why in the terminal status message.
        const reason = event.statusUpdate.status.message
        const textBefore = text
        if (isTerminal(state) && text.length === 0 && reason !== undefined) {
          text = textOf(reason.parts)
        }
        if (stateChanged || text !== textBefore) request.onProgress?.({ state, text })
      }
    }
    if (task === undefined) {
      throw new Error(`a2a ${request.agent}/${skill}: stream ended without a task`)
    }
    // A peer that purged the task after finishing it hands back the streamed
    // snapshot, whose status is still the one it opened with; the terminal
    // state the stream reported is the one the caller has to see.
    const settled = await this.settled(peer, task, request.signal)
    const reply = replyOf(settled)
    const state = lastState ?? reply.state
    return {
      ...reply,
      text: text.length > 0 ? text : reply.text,
      ...state === undefined ? {} : { state },
      agent: request.agent,
      skill,
      mode: 'direct',
    }
  }

  /** Publish one task to the bus, optionally waiting for its terminal event. */
  private async dispatchOverBus(
    request: A2ADispatchRequest,
    bridge: A2ABridgeConfig,
    skill: string,
    timeoutMs: number,
  ): Promise<A2ADispatchReply> {
    const bus = this.busOf(bridge)
    await this.ensureTopics(bus)
    const taskId = randomUUID()
    const contextId = request.contextId ?? randomUUID()
    let text = ''
    let state: string | undefined
    let terminal: BusEvent | undefined
    // Subscribe before publishing: a consumer that joins afterwards starts at
    // the topic's end and would miss the events a fast agent already emitted.
    const handle: A2ABusHandle = await bus.consumeEvents(`dsh-${taskId}`, (event) => {
      if (event.taskId !== taskId) return
      if (event.type === 'terminal') terminal = event
      if (event.state !== undefined) state = event.state
      if (event.type === 'artifact-update' && event.text !== undefined) text += event.text
      if (state !== undefined || text.length > 0) request.onProgress?.({ ...state === undefined ? {} : { state }, text })
    })
    try {
      const task: BusTask = {
        schema: 'a2a.task/1',
        taskId,
        contextId,
        from: this.agent,
        to: request.agent,
        skill,
        input: {
          text: request.text,
          ...request.workspace === undefined ? {} : { workspace: request.workspace },
        },
        ts: Date.now(),
        attempt: 1,
      }
      await bus.produceTask(task)
      if (request.wait !== true) {
        return { agent: request.agent, skill, mode: 'bus', text, taskId, contextId, state: 'TASK_STATE_SUBMITTED' }
      }
      const deadline = Date.now() + timeoutMs
      const settled = async (): Promise<BusEvent | undefined> => terminal
      while (Date.now() < deadline) {
        const event = await settled()
        if (event !== undefined) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      const finished = await settled()
      return {
        agent: request.agent,
        skill,
        mode: 'bus',
        text: text.length > 0 ? text : finished?.error ?? '',
        taskId,
        contextId,
        // A task still running when the wait ended keeps its working state; the
        // gateway owns it from here and keeps publishing on the same topics.
        state: finished?.state ?? 'TASK_STATE_WORKING',
      }
    } finally {
      await handle.stop()
    }
  }

  /**
   * The task as the peer stores it, falling back to the streamed copy.
   *
   * The streamed copy carries the status the task opened with, so the caller
   * that fallback reaches keeps the state the stream last reported.
   */
  private async settled(peer: A2APeerConfig, task: A2ATask, signal?: AbortSignal): Promise<A2ATask> {
    try {
      return await this.clientOf(peer).getTask(task.id, signal)
    } catch {
      // The streamed task already carries the terminal state; a peer that
      // purged it in between must not turn a finished answer into a failure.
      return task
    }
  }

  /** Create the deployment's topics once; every later dispatch reuses them. */
  private async ensureTopics(bus: A2ABus): Promise<void> {
    if (this.topicsReady) return
    await bus.ensureTopics()
    this.topicsReady = true
  }

  /** The deployment's bus, created on first use and closed with the plugin. */
  protected busOf(bridge: A2ABridgeConfig): A2ABus {
    if (this.bus !== undefined) return this.bus
    const bus = createA2ABus(bridge.bus)
    this.bus = bus
    this.ctx.effect(() => async () => {
      this.bus = undefined
      this.topicsReady = false
      await bus.close()
    }, 'a2a.bus')
    return bus
  }

  /**
   * Read the bridge deployment the configuration asks for, if it asks for one.
   *
   * The composition always materializes the `bridge` object, so an empty one
   * means this deployment dispatches nowhere; a deployment that names a path,
   * here or in `A2A_CONFIG`, gets its file read or an error explaining why not.
   * @param bridge - the bridge section the composition passed.
   * @returns the deployment's configuration, absent when none was asked for.
   */
  private bridgeOf(bridge: Config['bridge']): A2ABridgeConfig | undefined {
    const fromEnv = process.env.A2A_CONFIG
    if (bridge === undefined) return undefined
    if (bridge.configPath === undefined && (fromEnv === undefined || fromEnv.length === 0)) return undefined
    return loadA2ABridgeConfig({
      ...bridge.configPath === undefined ? {} : { path: bridge.configPath },
    })
  }

  /**
   * Resolve the bridge deployment a dispatch needs.
   * @param agent - agent the caller addressed.
   * @returns the deployment's configuration.
   * @throws Error when no bridge is configured or it does not run that agent.
   */
  private requireBridge(agent: string): A2ABridgeConfig {
    const bridge = this.bridge
    if (bridge === undefined) {
      throw new Error('a2a: no bridge deployment is configured, so no task can be dispatched')
    }
    if (!(agent in bridge.agents)) {
      throw new Error(`a2a: bridge runs ${Object.keys(bridge.agents).join(', ')}, not "${agent}"`)
    }
    return bridge
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
 * Derive the peers a bridge deployment answers for, so a task addressed to one
 * of its agents reaches the gateway that runs it.
 * @param bridge - the deployment's configuration, absent when none is configured.
 * @returns peer configuration per agent name, empty without a bridge.
 */
function peersOf(bridge: A2ABridgeConfig | undefined): Record<string, A2APeerConfig> {
  if (bridge === undefined) return {}
  return Object.fromEntries(Object.entries(bridge.agents).map(([name, agent]) => [name, {
    url: `http://127.0.0.1:${String(agent.port)}/`,
    ...bridge.apiKey.length === 0 ? {} : { apiKey: bridge.apiKey },
    timeoutMs: bridge.taskTimeoutMs,
  }]))
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
