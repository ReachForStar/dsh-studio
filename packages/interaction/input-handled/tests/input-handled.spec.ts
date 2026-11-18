import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InputHandlingService from '../src/index.ts'

function harness() {
  const ctx = new Context()
  const service = new InputHandlingService(ctx)
  return { ctx, service }
}

const agent = { id: 'agent-1' } as never
const signal = new AbortController().signal

describe('InputHandlingService.handle', () => {
  it('returns continue when no interceptor is registered', async () => {
    const { ctx, service } = harness()
    await expect(service.handle(agent, 'hello', signal)).resolves.toEqual({ action: 'continue' })
    await ctx.fiber.dispose()
  })

  it('stops at the first non-continue decision', async () => {
    const { ctx, service } = harness()
    service.register({ intercept: () => ({ action: 'transform', text: 'rewritten' }) })
    service.register({ intercept: () => ({ action: 'handled' }) })
    await expect(service.handle(agent, 'hello', signal)).resolves.toEqual({ action: 'transform', text: 'rewritten' })
    await ctx.fiber.dispose()
  })

  it('lets a later interceptor handle when earlier ones continue', async () => {
    const { ctx, service } = harness()
    service.register({ intercept: () => ({ action: 'continue' }) })
    service.register({ intercept: () => ({ action: 'handled' }) })
    await expect(service.handle(agent, 'hello', signal)).resolves.toEqual({ action: 'handled' })
    await ctx.fiber.dispose()
  })

  it('unregisters an interceptor', async () => {
    const { ctx, service } = harness()
    const dispose = service.register({ intercept: () => ({ action: 'handled' }) })
    dispose()
    await expect(service.handle(agent, 'hello', signal)).resolves.toEqual({ action: 'continue' })
    await ctx.fiber.dispose()
  })

  it('passes the agent, text, and signal through', async () => {
    const { ctx, service } = harness()
    const seen: [unknown, string, AbortSignal] = [undefined, '', signal]
    service.register({ intercept: (agentArg, text, signalArg) => {
      seen[0] = agentArg
      seen[1] = text
      seen[2] = signalArg
      return { action: 'continue' }
    } })
    await service.handle(agent, 'payload', signal)
    expect(seen[0]).toBe(agent)
    expect(seen[1]).toBe('payload')
    expect(seen[2]).toBe(signal)
    await ctx.fiber.dispose()
  })
})
