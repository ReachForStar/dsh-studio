/** Auto-compaction control: the pressure override only fires below the harness default. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, COMPACTION_RATIO_FIELD } from '../src/background-settings.ts'
import { configuredRatio, installCompactionControl } from '../src/compaction-control.ts'

const AGENT = { id: 'agent-1' } as unknown as Agent

/** Mount the control with a live volatile Config, returning the caller's ctx. */
async function mountControl(config: Record<string, unknown>) {
  const ctx = new Context()
  let live: Config | undefined
  const fiber = ctx.plugin({
    name: 'ui-polish-compaction-probe',
    Config,
    apply(context: Context, pluginConfig: Config) {
      live = pluginConfig
      installCompactionControl(context, pluginConfig)
    },
  }, config)
  await fiber.await()
  return { ctx, fiber, live: live as Config }
}

/** Run one agent pre-step through the installed listener, collecting what it decided. */
async function preStep(ctx: Context, signal: AbortSignal) {
  const compact = vi.fn(async () => undefined)
  ctx.provide('agentPresets', { serviceFor: () => ({ compactIfNeeded: compact }) } as never)
  const next = vi.fn(async () => 'continued')
  const decision = await (ctx.waterfall as unknown as (
    name: string, payload: object, terminal: unknown,
  ) => Promise<unknown>)('agent/pre-step', { agent: AGENT, signal }, next)
  return { compact, next, decision }
}

describe('configuredRatio', () => {
  it('reads the live ratio and ignores an absent one', async () => {
    const set = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.6 })
    expect(configuredRatio(set.live)).toBe(0.6)
    await set.fiber.dispose()

    const unset = await mountControl({})
    expect(configuredRatio(unset.live)).toBeUndefined()
    await unset.fiber.dispose()
  })
})

describe('installCompactionControl', () => {
  const disposers: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (disposers.length > 0) await disposers.pop()?.()
    vi.restoreAllMocks()
  })

  it('compacts with the user ratio as the per-call threshold override', async () => {
    const { ctx, fiber } = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.6 })
    disposers.push(() => fiber.dispose())
    const { compact, next, decision } = await preStep(ctx, new AbortController().signal)

    expect(compact).toHaveBeenCalledWith(AGENT, 'pressure', expect.anything(), { thresholdRatio: 0.6 })
    expect(next).toHaveBeenCalledOnce()
    expect(decision).toBe('continued')
  })

  it('leaves the harness default alone when no ratio is configured', async () => {
    const { ctx, fiber } = await mountControl({})
    disposers.push(() => fiber.dispose())
    const { compact, next } = await preStep(ctx, new AbortController().signal)

    expect(compact).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('leaves the harness default alone at the default ratio', async () => {
    const { ctx, fiber } = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.8 })
    disposers.push(() => fiber.dispose())
    const { compact, next } = await preStep(ctx, new AbortController().signal)

    expect(compact).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not compact once the turn is aborted', async () => {
    const { ctx, fiber } = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.6 })
    disposers.push(() => fiber.dispose())
    const controller = new AbortController()
    controller.abort()
    const { compact, next } = await preStep(ctx, controller.signal)

    expect(compact).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('continues the turn when the preset realm mounts no compaction service', async () => {
    const { ctx, fiber } = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.6 })
    disposers.push(() => fiber.dispose())
    ctx.provide('agentPresets', { serviceFor: () => undefined } as never)
    const next = vi.fn(async () => 'continued')
    await (ctx.waterfall as unknown as (
      name: string, payload: object, terminal: unknown,
    ) => Promise<unknown>)('agent/pre-step', { agent: AGENT, signal: new AbortController().signal }, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('warns and continues when the compaction service fails', async () => {
    const { ctx, fiber } = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.6 })
    disposers.push(() => fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.provide('agentPresets', {
      serviceFor: () => ({ compactIfNeeded: async () => { throw new Error('backend offline') } }),
    } as never)
    const next = vi.fn(async () => 'continued')
    const decision = await (ctx.waterfall as unknown as (
      name: string, payload: object, terminal: unknown,
    ) => Promise<unknown>)('agent/pre-step', { agent: AGENT, signal: new AbortController().signal }, next)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backend offline'))
    expect(next).toHaveBeenCalledOnce()
    expect(decision).toBe('continued')
  })

  it('reports a non-Error compaction failure by its text', async () => {
    const { ctx, fiber } = await mountControl({ [COMPACTION_RATIO_FIELD]: 0.6 })
    disposers.push(() => fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.provide('agentPresets', {
      serviceFor: () => ({ compactIfNeeded: async () => { throw 'quota' } }),
    } as never)
    const next = vi.fn(async () => 'continued')
    await (ctx.waterfall as unknown as (
      name: string, payload: object, terminal: unknown,
    ) => Promise<unknown>)('agent/pre-step', { agent: AGENT, signal: new AbortController().signal }, next)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quota'))
    expect(next).toHaveBeenCalledOnce()
  })
})
