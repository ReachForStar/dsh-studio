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
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import { PiLoopAgent } from './agent.ts'
import { openPiSession } from './pi-session.ts'
import type { OpenedPiSession } from './pi-session.ts'

/** Factory for opening one Pi session; injectable for tests. */
export type OpenPiSession = (options: { cwd: string }) => Promise<OpenedPiSession>

/** Configuration for the Pi agent loop. */
export interface PiLoopConfig {
  /** Replace the real Pi session opener (test seam). */
  openSession?: OpenPiSession
}

/**
 * The `pi` agent factory. Mount it alongside the default loop; it registers
 * itself under the `pi` backend via {@link AgentRegistry.setFactory}.
 */
export class PiLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions']

  private readonly openSession: OpenPiSession

  constructor(ctx: Context, config: PiLoopConfig = {}) {
    super(ctx, 'piAgentLoop')
    this.openSession = config.openSession ?? openPiSession
    ctx.effect(() => ctx.agents.setFactory(this, 'pi'), 'piAgentLoop.setFactory()')
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const cwd = options.meta?.cwd ?? process.cwd()
    // The dsh session is prepared so the registry and session store see a real
    // session identity; its log stays empty until stage 3 translates Pi events.
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))

    let opened: OpenedPiSession
    try {
      opened = await this.openSession({ cwd })
    } catch (error: unknown) {
      preparation[Symbol.dispose]()
      throw error
    }

    const agent = new PiLoopAgent(this.ctx, options.sessionId, options.agentOptions ?? {}, preparation.session, opened.session)
    return this.publish(ownerCtx, agent, opened, options.setup)
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // POC: a resumed Pi session re-runs through a fresh Pi session. Persisting
    // and reloading Pi's message tree is deferred; the dsh log is also empty
    // here, so there is no history to replay into Pi yet.
    return this.createAgent(ownerCtx, {
      sessionId: options.resumeSessionId,
      ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
      meta: { backend: 'pi' },
      ...options.setup === undefined ? {} : { setup: options.setup },
    })
  }

  /** Run setup, publish the dsh session + agent, and return the owned handle. */
  private async publish(
    ownerCtx: Context,
    agent: PiLoopAgent,
    opened: OpenedPiSession,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> {
    try {
      const commit = await setup?.(agent.ctx)
      commit?.commit()
    } catch (error: unknown) {
      await agent.dispose()
      opened.dispose()
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
        opened.dispose()
        detachAgent()
        detachSession()
      },
    }
  }
}

export { PiLoopAgent } from './agent.ts'
export { PiEventTranslator } from './pi-event-translator.ts'
export type { PiAgentSessionLike } from './agent.ts'
export type { OpenPiSessionOptions, OpenedPiSession } from './pi-session.ts'
