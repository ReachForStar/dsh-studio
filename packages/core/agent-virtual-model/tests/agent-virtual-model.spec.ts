import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import VirtualModelService, { virtualModelStateProjectionDefinition } from '../src/index.ts'
import type { ModelRouteRequest } from '@deepseek-ai/dsh-agent'

function requestOf(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return {
    reason: 'user',
    previous: undefined,
    failed: undefined,
    state: undefined,
    messages: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(VirtualModelService)
  const session = ctx.sessions.create(brandString<SessionId>('virtual-model-test'))
  return { ctx, session, service: ctx.virtualModels }
}

describe('VirtualModelService.resolve', () => {
  it('returns the selection unchanged when no virtual model is registered', async () => {
    const { ctx, session, service } = await harness()
    const selection = { provider: 'deepseek', model: 'deepseek-chat' }
    await expect(service.resolve(session, selection, requestOf())).resolves.toBe(selection)
    await ctx.fiber.dispose()
  })

  it('routes to the physical selection chosen by the router', async () => {
    const { ctx, session, service } = await harness()
    service.register({
      provider: 'router',
      id: 'auto',
      name: 'Auto',
      route: () => ({ selection: { provider: 'deepseek', model: 'deepseek-v4-flash' } }),
    })
    const resolved = await service.resolve(session, { provider: 'router', model: 'auto' }, requestOf())
    expect(resolved).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    await ctx.fiber.dispose()
  })

  it('passes the stored router state and persists a changed state', async () => {
    const { ctx, session, service } = await harness()
    let seenState: unknown
    service.register({
      provider: 'router',
      id: 'phased',
      name: 'Phased',
      route: (request) => {
        seenState = request.state
        return { selection: { provider: 'deepseek', model: 'deepseek-chat' }, state: { phase: 'build' } }
      },
    })
    await service.resolve(session, { provider: 'router', model: 'phased' }, requestOf())
    expect(seenState).toBeUndefined()
    await service.resolve(session, { provider: 'router', model: 'phased' }, requestOf())
    expect(seenState).toEqual({ phase: 'build' })
    const stored = session.snapshotEvents().filter(event => event.type === 'virtual-model/state')
    expect(stored.length).toBeGreaterThanOrEqual(1)
    expect(stored.at(-1)).toMatchObject({ data: { provider: 'router', modelId: 'phased', state: { phase: 'build' } } })
    await ctx.fiber.dispose()
  })

  it('unregisters a virtual model', async () => {
    const { ctx, session, service } = await harness()
    const dispose = service.register({
      provider: 'router',
      id: 'auto',
      name: 'Auto',
      route: () => ({ selection: { provider: 'deepseek', model: 'deepseek-chat' } }),
    })
    dispose()
    const selection = { provider: 'router', model: 'auto' }
    await expect(service.resolve(session, selection, requestOf())).resolves.toBe(selection)
    await ctx.fiber.dispose()
  })
})

describe('virtualModelStateProjectionDefinition', () => {
  it('keeps the latest state per virtual model', () => {
    const first = virtualModelStateProjectionDefinition.apply([], {
      type: 'virtual-model/state', seq: 1 as never, time: 0, data: { provider: 'router', modelId: 'auto', state: { a: 1 } },
    } as never)
    expect(first).toEqual([{ provider: 'router', modelId: 'auto', state: { a: 1 } }])
    const second = virtualModelStateProjectionDefinition.apply(first, {
      type: 'virtual-model/state', seq: 2 as never, time: 0, data: { provider: 'router', modelId: 'auto', state: { a: 2 } },
    } as never)
    expect(second).toEqual([{ provider: 'router', modelId: 'auto', state: { a: 2 } }])
  })
})
