import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Followup from '../src/index.ts'
import {
  accumulateTurn,
  parseSuggestions,
  renderSuggestionInput,
  requestSuggestions,
  type Config,
  type TurnExcerpt,
} from '../src/index.ts'

const CONFIG: Config = {
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  maxInputBytes: 1_000,
  maxSuggestions: 3,
  maxSuggestionChars: 40,
  provider: 'mock',
  model: 'mock-fast',
}

function stubLlm(reply: string) {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return {
    prepareCall: () => Promise.resolve({
      config: { provider: 'mock', model: 'mock-fast', maxTokens: 256 },
      stream,
    }),
  }
}

describe('renderSuggestionInput', () => {
  it('frames both sections', () => {
    const input = renderSuggestionInput({ request: 'fix build', reply: 'build fixed' }, 1_000)
    expect(input).toContain("User's last request:\nfix build")
    expect(input).toContain("Assistant's last reply:\nbuild fixed")
  })

  it('handles a missing section and truncates over the cap', () => {
    expect(renderSuggestionInput({ reply: 'done' }, 1_000)).not.toContain("User's last request")
    const input = renderSuggestionInput({ reply: 'x'.repeat(2_000) }, 300)
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(300)
    expect(input).toContain('Suggest the next concrete actions')
  })

  it('returns the bare header for an empty excerpt', () => {
    expect(renderSuggestionInput({}, 1_000)).toContain('Suggest the next concrete actions')
  })

  it('hard-truncates when the framed text exceeds the cap', () => {
    const input = renderSuggestionInput({ request: 'req', reply: 'y'.repeat(500) }, 60)
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(60)
  })

  it('returns the bare header when nothing fits', () => {
    const input = renderSuggestionInput({ reply: 'x'.repeat(2_000) }, 40)
    expect(input).toContain('Suggest the next concrete actions')
  })
})

describe('parseSuggestions', () => {
  it('strips list markers, blends blank lines, and caps the count', () => {
    expect(parseSuggestions('1. run tests\n\n- deploy\n* ship it\n4) extra', CONFIG))
      .toEqual(['run tests', 'deploy', 'ship it'])
  })

  it('truncates long actions and keeps none for empty replies', () => {
    expect(parseSuggestions('x'.repeat(100), CONFIG)[0]).toHaveLength(40)
    expect(parseSuggestions('   \n\n', CONFIG)).toEqual([])
  })
})

describe('accumulateTurn', () => {
  it('accumulates request text under the open turn and keeps the last reply', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const live = ctx.sessions.create()
    const state = new Map<number, TurnExcerpt>()
    live.append('turn/start', { turn: 1 })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, live.snapshotEvents().at(-1)!)).toBe(true)
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    accumulateTurn(state, 1, live.snapshotEvents().at(-1)!)
    expect(state.get(1)!.request).toBe('first\nsecond')
    const assistant = live.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'mock', model: 'mock-fast' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, assistant)).toBe(true)
    expect(state.get(1)!.reply).toBe('answer')
    await ctx.fiber.dispose()
  })

  it('ignores empty assistant replies', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const live = ctx.sessions.create()
    const state = new Map<number, TurnExcerpt>()
    const assistant = live.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock-fast' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, assistant)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('ignores non-text content blocks', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const live = ctx.sessions.create()
    const state = new Map<number, TurnExcerpt>()
    const user = live.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'hmm' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, user)).toBe(false)
    const assistant = live.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'hmm' }], source: { provider: 'mock', model: 'mock-fast' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, assistant)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('records a reply even when no request text preceded it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const live = ctx.sessions.create()
    const state = new Map<number, TurnExcerpt>()
    const assistant = live.append('assistant/message', {
      turn: 7,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'standalone' }], source: { provider: 'mock', model: 'mock-fast' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, assistant)).toBe(true)
    expect(state.get(7)).toEqual({ reply: 'standalone' })
    await ctx.fiber.dispose()
  })

  it('ignores unrelated, empty, and turn-less events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const live = ctx.sessions.create()
    const state = new Map<number, TurnExcerpt>()
    const empty = live.append('user/message', createUserMessage({
      content: [], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(accumulateTurn(state, 1, empty)).toBe(false)
    expect(accumulateTurn(state, undefined, empty)).toBe(false)
    const other = live.append('step/start', { turn: 1, step: 1 })
    expect(accumulateTurn(state, 1, other)).toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('requestSuggestions', () => {
  it('ignores reasoning-only replies', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', {
      prepareCall: () => Promise.resolve({
        config: { provider: 'mock', model: 'mock-fast', maxTokens: 256 },
        stream: async function* () {
          yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    expect(await requestSuggestions(
      ctx, session, CONFIG, { request: 'go' }, new AbortController().signal,
    )).toEqual([])
    await ctx.fiber.dispose()
  })

  it('returns no suggestions for an empty reply', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm(''))
    expect(await requestSuggestions(
      ctx, session, CONFIG, { request: 'go' }, new AbortController().signal,
    )).toEqual([])
    await ctx.fiber.dispose()
  })

  it('returns parsed suggestions and requires a route', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm('run tests\nship it'))
    const suggestions = await requestSuggestions(
      ctx, session, CONFIG, { request: 'fix build', reply: 'done' }, new AbortController().signal,
    )
    expect(suggestions).toEqual(['run tests', 'ship it'])
    await expect(requestSuggestions(
      ctx, session, {
        maxOutputTokens: 256, timeoutMs: 5_000, maxInputBytes: 1_000,
        maxSuggestions: 3, maxSuggestionChars: 40, provider: 'mock',
      }, {}, new AbortController().signal,
    )).rejects.toThrow('provider and model must be configured together')
    await ctx.fiber.dispose()
  })
})

describe('apply', () => {
  async function mount(reply: string) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm(reply))
    await ctx.plugin(Followup, CONFIG)
    const suggestions: { data: unknown }[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'followup/suggestions') suggestions.push(event)
    })
    return { ctx, session, suggestions }
  }

  it('logs suggestions once per completed turn', async () => {
    const { ctx, session, suggestions } = await mount('run tests\nship it')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'fix build' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'fixed' }], source: { provider: 'mock', model: 'mock-fast' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    await vi.waitFor(() => {
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0]!.data).toMatchObject({ turn: 1, suggestions: ['run tests', 'ship it'] })
    }, { timeout: 5_000 })
    await ctx.fiber.dispose()
  })

  it('skips turns without text and replays without double requests', async () => {
    const { ctx, session, suggestions } = await mount('run tests')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(suggestions).toHaveLength(0)

    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } as never })
    ctx.emit('session/event', session, end)
    await vi.waitFor(() => { expect(suggestions.length).toBeGreaterThan(0) }, { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(suggestions).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('skips empty suggestion replies and aborts in-flight requests on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = () => { resolve() } })
    ctx.provide('llm', {
      prepareCall: () => Promise.resolve({
        config: { provider: 'mock', model: 'mock-fast', maxTokens: 256 },
        stream: async function* () {
          await gate
          yield { type: 'text-delta', index: 0, text: '' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    await ctx.plugin(Followup, CONFIG)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    await new Promise(resolve => setTimeout(resolve, 30))
    await ctx.fiber.dispose()
    release?.()
  })

  it('logs nothing for an empty suggestion reply', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm('   '))
    await ctx.plugin(Followup, CONFIG)
    const logged: unknown[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'followup/suggestions') logged.push(event)
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(logged).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('warns instead of throwing when the auxiliary request fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.provide('llm', { prepareCall: () => Promise.reject(new Error('no route')) })
    await ctx.plugin(Followup, CONFIG)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() }, { timeout: 5_000 })
    await ctx.fiber.dispose()
  })
})
