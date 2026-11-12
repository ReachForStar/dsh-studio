import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, LlmCallConfig, ToolSchema } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Warming from '../src/index.ts'
import {
  AUTO_INTERVAL_MS,
  KEEP_ALIVE_PROMPT,
  pingFitsWindow,
  requestKeepAlive,
  resolveIntervalMs,
  routeOf,
  type Config,
} from '../src/index.ts'

const CONFIG = {
  enabled: true,
  interval: 25,
  durationMs: 5_000,
  prompt: KEEP_ALIVE_PROMPT,
  maxOutputTokens: 16,
  timeoutMs: 5_000,
} satisfies Config

const TOOL: ToolSchema = { name: 'read', description: 'Read a file', parameters: { type: 'object' } }

interface Ping {
  config: LlmCallConfig
  request: GenerateOptions
}

function stubLlm(options: { fail?: boolean; finishKind?: 'stop' | 'error' } = {}) {
  const pings: Ping[] = []
  return {
    pings,
    prepareCall: (config: LlmCallConfig) => {
      if (options.fail === true) return Promise.reject(new Error('no route'))
      const prepared = {
        config,
        stream: async function* (request: GenerateOptions) {
          pings.push({ config, request })
          if (options.finishKind === 'error') {
            yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { message: 'boom', code: 'UNKNOWN' } } }
            return
          }
          yield { type: 'text-delta' as const, index: 0, text: 'OK' }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      }
      return Promise.resolve(prepared)
    },
  }
}

async function mount(llm: ReturnType<typeof stubLlm>, config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  ctx.provide('llm', llm)
  await ctx.plugin(Warming, { ...CONFIG, ...config })
  return { ctx, session }
}

function seedHistory(session: ReturnType<Context['sessions']['create']>): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'fix the build' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'build fixed' }],
      source: { provider: 'mock', model: 'mock-fast' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

function recordRequest(
  session: ReturnType<Context['sessions']['create']>,
  effort?: string,
  tools?: ToolSchema[],
): void {
  session.append('request/header', {
    reason: 'initial',
    header: {
      config: {
        provider: 'mock',
        model: 'mock-fast',
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      },
      ...tools === undefined ? {} : { tools },
    },
  })
  session.append('step/start', { turn: 1, step: 1 })
}

function endTurn(session: ReturnType<Context['sessions']['create']>): void {
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('resolveIntervalMs', () => {
  it('resolves auto to four minutes and keeps an explicit interval', () => {
    expect(resolveIntervalMs('auto')).toBe(AUTO_INTERVAL_MS)
    expect(AUTO_INTERVAL_MS).toBe(4 * 60_000)
    expect(resolveIntervalMs(90_000)).toBe(90_000)
  })
})

describe('routeOf', () => {
  it('keeps an explicit effort and omits an adapter default', () => {
    expect(routeOf({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }, false))
      .toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(routeOf({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }, true))
      .toEqual({ provider: 'p', model: 'm' })
    expect(routeOf({ provider: 'p', model: 'm' }, undefined)).toEqual({ provider: 'p', model: 'm' })
  })
})

describe('pingFitsWindow', () => {
  it('requires the next ping to land before the window closes', () => {
    expect(pingFitsWindow(1_000, 1_000, { intervalMs: 100, durationMs: 300 })).toBe(true)
    expect(pingFitsWindow(1_200, 1_000, { intervalMs: 100, durationMs: 300 })).toBe(false)
  })
})

describe('requestKeepAlive', () => {
  it('replays the conversation prefix and appends the keep-alive prompt', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    seedHistory(session)
    recordRequest(session, 'high', [TOOL])
    const llm = stubLlm()
    ctx.provide('llm', llm)
    await requestKeepAlive(ctx, session, CONFIG, new AbortController().signal)
    expect(llm.pings).toHaveLength(1)
    const ping = llm.pings[0]!
    expect(ping.config).toMatchObject({ provider: 'mock', model: 'mock-fast', reasoningEffort: 'high', maxTokens: 16 })
    expect(ping.request.purpose).toBe('warming')
    expect(ping.request.sessionId).toBe(session.id)
    // The shared prefix is what makes the provider reuse the conversation's cache entry.
    const derived = session.deriveMessages()
    expect(derived.length).toBeGreaterThan(0)
    expect(ping.request.messages.slice(0, derived.length)).toEqual(derived)
    expect(ping.request.messages).toHaveLength(derived.length + 1)
    expect(ping.request.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: KEEP_ALIVE_PROMPT }],
    })
    expect(ping.request.tools).toEqual([TOOL])
    expect(ping.request.toolHistory).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('throws without a recorded header, when the provider fails, and on abort', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm({ finishKind: 'error' }))
    await expect(requestKeepAlive(
      ctx, session, CONFIG, new AbortController().signal,
    )).rejects.toThrow('no recorded request header')
    recordRequest(session)
    await expect(requestKeepAlive(
      ctx, session, CONFIG, new AbortController().signal,
    )).rejects.toThrow('finished with error')
    await expect(requestKeepAlive(
      ctx, session, CONFIG, AbortSignal.abort(new Error('stop')),
    )).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('apply', () => {
  it('warms an idle Session after the interval with the recorded route and prefix', async () => {
    const llm = stubLlm()
    const { ctx, session } = await mount(llm)
    seedHistory(session)
    recordRequest(session, 'high', [TOOL])
    endTurn(session)
    await vi.waitFor(() => { expect(llm.pings.length).toBeGreaterThan(0) }, { timeout: 3_000 })
    const ping = llm.pings[0]!
    expect(ping.config).toMatchObject({ provider: 'mock', model: 'mock-fast', reasoningEffort: 'high' })
    const derived = session.deriveMessages()
    expect(ping.request.messages.slice(0, derived.length)).toEqual(derived)
    expect(ping.request.messages.at(-1)).toMatchObject({
      content: [{ type: 'text', text: KEEP_ALIVE_PROMPT }],
    })
    expect(ping.request.tools).toEqual([TOOL])
    await ctx.fiber.dispose()
  })

  it('sends nothing while the interval has not elapsed', async () => {
    const llm = stubLlm()
    const { ctx, session } = await mount(llm, { interval: 400 })
    recordRequest(session)
    endTurn(session)
    await settle(80)
    expect(llm.pings).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('stops when the duration window closes', async () => {
    const llm = stubLlm()
    const { ctx, session } = await mount(llm, { interval: 30, durationMs: 100 })
    recordRequest(session)
    endTurn(session)
    await settle(260)
    const count = llm.pings.length
    expect(count).toBeGreaterThan(0)
    await settle(150)
    expect(llm.pings).toHaveLength(count)
    await ctx.fiber.dispose()
  })

  it('does not warm without a recorded request route', async () => {
    const llm = stubLlm()
    const { ctx, session } = await mount(llm)
    session.append('turn/start', { turn: 1 })
    endTurn(session)
    await settle(80)
    expect(llm.pings).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('sends nothing when disabled and stops warming after a failure', async () => {
    const disabledLlm = stubLlm()
    const disabled = await mount(disabledLlm, { enabled: false })
    recordRequest(disabled.session)
    endTurn(disabled.session)
    await settle(80)
    expect(disabledLlm.pings).toHaveLength(0)
    await disabled.ctx.fiber.dispose()

    const failing = stubLlm({ fail: true })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.provide('llm', failing)
    await ctx.plugin(Warming, CONFIG)
    recordRequest(session)
    endTurn(session)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) }, { timeout: 3_000 })
    await settle(120)
    expect(warn).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('stops warming when a ping reports a failed finish', async () => {
    const llm = stubLlm({ finishKind: 'error' })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.provide('llm', llm)
    await ctx.plugin(Warming, CONFIG)
    recordRequest(session)
    endTurn(session)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) }, { timeout: 3_000 })
    await settle(80)
    expect(llm.pings).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('cancels pending pings on disposal', async () => {
    const llm = stubLlm()
    const { ctx, session } = await mount(llm, { interval: 200 })
    recordRequest(session)
    endTurn(session)
    await ctx.fiber.dispose()
    await settle(260)
    expect(llm.pings).toHaveLength(0)
  })

  it('aborts an in-flight ping on disposal without warning', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const started = Promise.withResolvers<boolean>()
    ctx.provide('llm', {
      prepareCall: (config: LlmCallConfig) => Promise.resolve({
        config,
        stream: async function* (request: GenerateOptions) {
          started.resolve(true)
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      }),
    })
    await ctx.plugin(Warming, { ...CONFIG, interval: 5 })
    recordRequest(session)
    endTurn(session)
    await started.promise
    await ctx.fiber.dispose()
    expect(warn).not.toHaveBeenCalled()
  })
})
