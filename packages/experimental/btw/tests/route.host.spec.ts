import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, BTW_ASK_PATH, Config } from '../src/index.ts'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'

const agent = { session: { id: SessionId('s1') } } as unknown as Agent

function activation(output: readonly { type: string; text?: string }[] = [{ type: 'text', text: 'the answer' }], stopReason = 'completed') {
  const dispose = vi.fn(async () => {})
  return {
    childId: SessionId('child-1'), name: 'btw', dispose,
    result: Promise.resolve({ stopReason, output }),
  } as unknown as SubagentActivation & { readonly dispose: ReturnType<typeof vi.fn> }
}

async function mounted(options: {
  readonly agents?: boolean
  readonly activation?: SubagentActivation
} = {}): Promise<{
  readonly connection: HostConnectionService
  readonly startActivation: ReturnType<typeof vi.fn>
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  if (options.agents !== false) {
    ctx.provide('agents', { get: (id: SessionId) => id === 's1' ? agent : undefined } as never)
  }
  const startActivation = vi.fn(async () => options.activation ?? activation())
  ctx.provide('subagents', { startActivation } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = await ctx.plugin({ inject: [...inject], apply })
  return {
    connection,
    startActivation,
    dispose: async () => { await fiber.dispose() },
  }
}

function ask(connection: HostConnectionService, body: unknown): Promise<Response> {
  const shared = connection.createSharedFetchHandler('/api')
  return shared.fetch(new Request(`http://host${BTW_ASK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), connection.browserPeer)
}

describe('btw route', () => {
  it('answers from the forked child and disposes it', async () => {
    const child = activation()
    const { connection, startActivation, dispose } = await mounted({ activation: child })
    const response = await ask(connection, { sessionId: 's1', question: '  why?  ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answer: 'the answer' })
    expect(startActivation.mock.calls[0]?.[0]).toMatchObject({
      provider: 'fork', label: 'btw', parent: agent, delivery: 'caller',
      prompt: [{ type: 'text', text: 'why?' }],
    })
    expect(child.dispose).toHaveBeenCalledOnce()
    await dispose()
  })

  it('joins text blocks and tolerates an empty answer', async () => {
    const { connection, dispose } = await mounted({
      activation: activation([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    })
    expect(await (await ask(connection, { sessionId: 's1', question: 'q' })).json()).toEqual({ answer: 'a\nb' })
    await dispose()
    const empty = await mounted({ activation: activation([]) })
    expect(await (await ask(empty.connection, { sessionId: 's1', question: 'q' })).json()).toEqual({ answer: '' })
    await empty.dispose()
  })

  it('rejects invalid bodies, unknown Sessions, and incomplete answers', async () => {
    const { connection, dispose } = await mounted()
    const shared = connection.createSharedFetchHandler('/api')
    const raw = (body: string): Promise<Response> => shared.fetch(new Request(`http://host${BTW_ASK_PATH}`, {
      method: 'POST', body,
    }), connection.browserPeer)
    expect((await raw('not json')).status).toBe(400)
    expect((await raw('42')).status).toBe(400)
    expect((await ask(connection, { question: 'q' })).status).toBe(400)
    expect((await ask(connection, { sessionId: 's1', question: '   ' })).status).toBe(400)
    expect((await ask(connection, { sessionId: 's1', question: 'x'.repeat(4001) })).status).toBe(400)
    expect((await ask(connection, { sessionId: 'missing', question: 'q' })).status).toBe(404)
    await dispose()

    const missingAgents = await mounted({ agents: false })
    expect((await ask(missingAgents.connection, { sessionId: 's1', question: 'q' })).status).toBe(404)
    await missingAgents.dispose()

    const incomplete = await mounted({ activation: activation([{ type: 'text', text: 'x' }], 'error') })
    expect((await ask(incomplete.connection, { sessionId: 's1', question: 'q' })).status).toBe(502)
    await incomplete.dispose()
  })

  it('times out one question and later questions keep working', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('subagents', {
      startActivation: (spec: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        spec.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = await ctx.plugin({ inject: [...inject], apply }, { timeoutMs: 5 })
    expect((await ask(connection, { sessionId: 's1', question: 'q' })).status).toBe(504)
    expect(await (await ask(connection, { sessionId: 's1', question: '   ' })).text()).toBe('missing or oversized question')
    await fiber.dispose()
  })

  it('contains a disposal failure and reports a non-Error provider failure', async () => {
    const child = activation()
    child.dispose.mockRejectedValue('cleanup failed')
    const throwNonError = await mounted({ activation: child })
    expect((await ask(throwNonError.connection, { sessionId: 's1', question: 'q' })).status).toBe(200)
    await throwNonError.dispose()

    const failing = activation()
    failing.dispose.mockRejectedValue(new Error('cleanup failed'))
    const failingDispose = await mounted({ activation: failing })
    expect((await ask(failingDispose.connection, { sessionId: 's1', question: 'q' })).status).toBe(200)
    await failingDispose.dispose()

    const ctx = new Context()
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('subagents', { startActivation: async () => { throw 'boom' } } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = await ctx.plugin({ inject: [...inject], apply })
    expect(await (await ask(connection, { sessionId: 's1', question: 'q' })).text()).toBe('the side question failed')
    await fiber.dispose()
  })

  it('reports a provider failure without leaking details and validates config', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('subagents', { startActivation: async () => { throw new Error('secret host path') } } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = await ctx.plugin({ inject: [...inject], apply })
    const response = await ask(connection, { sessionId: 's1', question: 'q' })
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('the side question failed')
    await fiber.dispose()

    expect(Config({})).toEqual({ provider: 'fork', maxQuestionChars: 4000, timeoutMs: 120000 })
  })
})
