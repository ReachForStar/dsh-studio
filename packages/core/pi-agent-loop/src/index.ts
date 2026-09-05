/**
 * The Pi agent-loop plugin: registers a second {@link AgentFactory} under the
 * `pi` backend so a session created with `meta.backend: 'pi'` is driven by the
 * Pi coding-agent runtime instead of the default dsh React loop.
 *
 * Stage-2 POC scope:
 * - Pi drives turns through its own AgentSession (own model + own tools).
 * - dsh still owns session lifecycle and the registry, but Pi turn/step events
 *   are NOT written back into the dsh session log yet (stage 3).
 * - resume is a fresh Pi session; persisting/reloading Pi history is deferred.
 *
 * @module dsh-pi-agent-loop
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { interruptedTurnClosers, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { PiLoopAgent } from './agent.ts'
import type { PiDurableWrite } from './agent.ts'
import { openPiSession } from './pi-session.ts'
import type { OpenedPiSession, PiProviderConfig } from './pi-session.ts'

/** One session's owned durable write handle plus its stored event cursor. */
interface Durable {
  readonly handle: PiDurableWrite
  readonly stored: number
}

/** Minimal session-persistence service surface PiLoop create/resume needs. */
interface PiPersistence {
  create(
    header: SessionHeader,
    options?: { readonly inheritedEventCount?: SessionLogOffset },
  ): Promise<PiDurableWrite>
  open(id: SessionId, access: 'write'): Promise<PiDurableWrite & {
    readonly header: { readonly cwd?: string }
    readonly inheritedEventCount: SessionLogOffset
    read(offset?: number, length?: number): Promise<readonly SessionEvent[]>
  }>
}

/** Factory for opening one Pi session; injectable for tests. */
export type OpenPiSession = (options: {
  cwd: string
  provider?: string
  modelId?: string
  providers?: readonly PiProviderConfig[]
}) => Promise<OpenedPiSession>

/** Configuration for the Pi agent loop. */
export interface PiLoopConfig {
  /** Replace the real Pi session opener (test seam). */
  openSession?: OpenPiSession
  /** OpenAI-compatible gateways registered into Pi before model selection. */
  providers?: readonly PiProviderConfig[]
  /**
   * The Pi model route every session uses. When set, it wins over dsh's
   * `agentOptions.provider/model` (whose provider names dsh adapters, not Pi
   * providers); omit to fall back to dsh's selection.
   */
  model?: { readonly provider: string; readonly modelId: string }
}

/**
 * The `pi` agent factory. Mount it alongside the default loop; it registers
 * itself under the `pi` backend via {@link AgentRegistry.setFactory}.
 */
export class PiLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions']

  private readonly openSession: OpenPiSession
  private readonly providers: readonly PiProviderConfig[]
  private readonly model: { readonly provider: string; readonly modelId: string } | undefined

  constructor(ctx: Context, config: PiLoopConfig = {}) {
    super(ctx, 'piAgentLoop')
    this.openSession = config.openSession ?? openPiSession
    this.providers = config.providers ?? []
    this.model = config.model
    ctx.effect(() => ctx.agents.setFactory(this, 'pi'), 'piAgentLoop.setFactory()')
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const persistence = this.ctx.get('sessionPersistence') as PiPersistence | undefined
    return this.launch(
      ownerCtx,
      options,
      // A fresh session's durable identity is stored before publication; live
      // events drain through the owned handle (see {@link PiLoopAgent}).
      persistence === undefined
        ? undefined
        : async (session) => {
          const handle = await persistence.create(session.header, {
            inheritedEventCount: session.inheritedEventCount,
          })
          return { handle, stored: 0 }
        },
    )
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // A pi session's dsh log lives in persistence; resume must rehydrate its
    // history (and header cwd) exactly like the dsh loop does, otherwise the
    // reopened session loses every prior message and falls back to process.cwd.
    const persistence = this.ctx.get('sessionPersistence') as PiPersistence | undefined
    if (persistence === undefined) {
      throw new Error('cannot resume a pi session: session persistence is not configured')
    }
    const id = options.resumeSessionId
    const handle = await persistence.open(id, 'write')
    try {
      const persisted = await handle.read(0, undefined)
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      const cwd = handle.header.cwd
      return await this.launch(ownerCtx, {
        sessionId: id,
        ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
        meta: {
          ...cwd === undefined ? {} : { cwd },
          backend: 'pi' as const,
        },
        seed: [...persisted, ...closers],
        inheritedEventCount: handle.inheritedEventCount,
        ...options.setup === undefined ? {} : { setup: options.setup },
      }, {
        handle,
        stored: persisted.length + closers.length,
      })
    } catch (error: unknown) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  /**
   * Prepare the dsh session, open one Pi session, wire the durable handle, and
   * publish. `durableFactory` stores a fresh session; a resumed session passes
   * its already-open handle directly.
   */
  private async launch(
    ownerCtx: Context,
    options: CreateAgentOptions,
    durableFactory:
      | ((session: { readonly header: SessionHeader; readonly inheritedEventCount: SessionLogOffset }) => Promise<Durable>)
      | Durable
      | undefined,
  ): Promise<AgentHandle> {
    const cwd = options.meta?.cwd ?? process.cwd()
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))

    let durable: Durable | undefined
    if (typeof durableFactory === 'function') {
      try {
        durable = await durableFactory(preparation.session)
      } catch (error: unknown) {
        preparation[Symbol.dispose]()
        throw error
      }
    } else if (durableFactory !== undefined) {
      durable = durableFactory
    }

    let opened: OpenedPiSession
    try {
      const agentProvider = options.agentOptions?.provider
      const agentModel = options.agentOptions?.model
      const route = this.model
        ?? (agentProvider !== undefined && agentModel !== undefined
          ? { provider: agentProvider, modelId: agentModel }
          : undefined)
      opened = await this.openSession({
        cwd,
        ...route === undefined ? {} : { provider: route.provider, modelId: route.modelId },
        providers: this.providers,
      })
    } catch (error: unknown) {
      preparation[Symbol.dispose]()
      if (durable !== undefined) await durable.handle.close().catch(() => {})
      throw error
    }

    const agent = new PiLoopAgent(
      this.ctx,
      options.sessionId,
      options.agentOptions ?? {},
      preparation.session,
      opened.session,
      durable?.handle,
      durable?.stored,
    )
    const tools = this.ctx.get('tools')
    if (tools !== undefined) {
      agent.registerDshTools(tools)
      agent.registerPiTools(tools)
    }
    return this.publish(ownerCtx, agent, opened, options.setup, durable)
  }

  /** Run setup, publish the dsh session + agent, and return the owned handle. */
  private async publish(
    ownerCtx: Context,
    agent: PiLoopAgent,
    opened: OpenedPiSession,
    setup: CreateAgentOptions['setup'],
    durable?: Durable,
  ): Promise<AgentHandle> {
    try {
      const commit = await setup?.(agent.ctx)
      commit?.commit()
    } catch (error: unknown) {
      await agent.dispose()
      opened.dispose()
      await agent.flushDurable().catch(() => {})
      await durable?.handle.close().catch(() => {})
      throw error
    }

    const detachSession = this.ctx.sessions.enter(agent.session)
    const detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
    this.ctx.sessions.announce(agent.session)
    this.ctx.agents.announce(agent)
    emitAgentEvent(this.ctx, agent, 'agent/session-start', { source: 'startup' })

    return {
      agent,
      dispose: async () => {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        await agent.dispose()
        // Stopping Pi first guarantees no further appends; then drain the
        // remaining events and release the durable write path.
        opened.dispose()
        await agent.flushDurable()
        detachAgent()
        detachSession()
        await durable?.handle.close().catch(() => {})
      },
    }
  }
}

export { PiLoopAgent } from './agent.ts'
export { PiEventTranslator } from './pi-event-translator.ts'
export { adaptDshTool } from './dsh-tool-adapter.ts'
export { adaptPiTool } from './pi-tool-adapter.ts'
export type { AdaptedPiTool } from './dsh-tool-adapter.ts'
export type { PiToolDefinitionLike, PiRunnerLike } from './pi-tool-adapter.ts'
export type { PiAgentSessionLike } from './agent.ts'
export type { OpenPiSessionOptions, OpenedPiSession, PiProviderConfig, PiProviderModelConfig } from './pi-session.ts'

export default PiLoop
