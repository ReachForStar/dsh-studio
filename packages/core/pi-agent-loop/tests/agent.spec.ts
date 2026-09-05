import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { PiLoop, PiLoopAgent } from '@deepseek-ai/dsh-pi-agent-loop'
import type { PiAgentSessionLike, OpenPiSession } from '@deepseek-ai/dsh-pi-agent-loop'

function stubPiSession() {
  const prompts: string[] = []
  const steers: string[] = []
  const aborts: number[] = []
  const session: PiAgentSessionLike = {
    isStreaming: false,
    async prompt(text) { prompts.push(text) },
    async steer(text) { steers.push(text) },
    async followUp(text) { prompts.push(text) },
    async abort() { aborts.push(aborts.length) },
    dispose() {},
    subscribe() { return () => {} },
  }
  return { session, prompts, steers, aborts }
}

describe('PiLoopAgent', () => {
  it('bridges followup and steer to the Pi session and tracks idle', async () => {
    const ctx = new Context()
    const { session, prompts, steers } = stubPiSession()
    const dshSession = Session.create(SessionId('pi-s'))
    const agent = new PiLoopAgent(ctx, SessionId('pi-s'), {}, dshSession, session)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'stop' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts).toEqual(['hello'])
    expect(steers).toEqual(['stop'])
    expect(agent.status).toBe('idle')
    await agent.dispose()
  })

  it('exposes running status while a Pi operation is in flight', async () => {
    const ctx = new Context()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    let streaming = true
    const session: PiAgentSessionLike = {
      get isStreaming() { return streaming },
      async prompt() { await pending },
      async steer() {},
      async followUp() {},
      async abort() {},
      dispose() {},
      subscribe() { return () => {} },
    }
    const agent = new PiLoopAgent(ctx, SessionId('pi-s'), {}, Session.create(SessionId('pi-s')), session)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }))
    // The synchronous followup has already incremented the run counter.
    expect(agent.status).toBe('running')
    streaming = false
    release!()
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    await agent.dispose()
  })
})

describe('PiLoop factory', () => {
  it('registers under the pi backend and creates a pi-backed agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const openCalls: string[] = []
    const openSession: OpenPiSession = async ({ cwd }) => {
      openCalls.push(cwd)
      const { session } = stubPiSession()
      return { session, dispose() {} }
    }
    await ctx.plugin(PiLoop, { openSession })

    const handle = await ctx.agents.create({
      sessionId: SessionId('pi-agent'),
      meta: { backend: 'pi', cwd: process.cwd() },
    })

    expect(handle.agent).toBeInstanceOf(PiLoopAgent)
    expect(openCalls).toEqual([process.cwd()])
    await handle.dispose()
  })

  it('routes resume with backend pi to the Pi factory', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    // A persisted pi session is required for resume to load its header + history.
    ctx.provide('sessionPersistence', {
      async open(_id: SessionId) {
        return {
          async read() { return [] },
          async append() {},
          async close() {},
          header: { cwd: process.cwd(), backend: 'pi' },
          inheritedEventCount: 0,
        }
      },
    })
    await ctx.plugin(PiLoop, { openSession: async () => ({ ...stubPiSession(), dispose() {} }) })

    const handle = await ctx.agents.resume({ resumeSessionId: SessionId('pi-resume'), backend: 'pi' })
    expect(handle.agent).toBeInstanceOf(PiLoopAgent)
    await handle.dispose()
  })

  it('forwards configured gateway providers to the session opener', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    let receivedProviders: unknown
    await ctx.plugin(PiLoop, {
      providers: [{
        id: 'amax',
        baseUrl: 'https://gateway.example/v1',
        apiKeyEnv: 'AMAX_API_KEY',
        models: [{ id: 'qwen-3.8-27B', name: 'Qwen', contextWindow: 128_000, maxTokens: 8192 }],
      }],
      openSession: async (options) => {
        receivedProviders = options.providers
        return { ...stubPiSession(), dispose() {} }
      },
    })

    await ctx.agents.create({ sessionId: SessionId('pi-provider'), meta: { backend: 'pi', cwd: process.cwd() } })
    expect(receivedProviders).toEqual([{
      id: 'amax',
      baseUrl: 'https://gateway.example/v1',
      apiKeyEnv: 'AMAX_API_KEY',
      models: [{ id: 'qwen-3.8-27B', name: 'Qwen', contextWindow: 128_000, maxTokens: 8192 }],
    }])
  })
})
