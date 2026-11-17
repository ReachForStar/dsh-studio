import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  buildHandoffMessages,
  executeHandoff,
  HANDOFF_SYSTEM,
  requestHandoffPrompt,
  resolveConfig,
  type Config as ConfigModel,
} from '../src/index.ts'

const CONFIG: ConfigModel = {
  maxOutputTokens: 2048,
  timeoutMs: 5_000,
  maxHistoryMessages: 40,
  provider: 'mock',
  model: 'mock-fast',
}

function historyOf(length: number): Message[] {
  return Array.from({ length }, (_, index) => createUserMessage({
    content: [{ type: 'text', text: `message ${index}` }],
    source: { kind: 'user' },
  }))
}

function stubLlm(reply: string, seen?: { purpose?: string; provider?: string; model?: string; system?: string }) {
  return {
    prepareCall: (config: { provider: string; model: string; maxTokens: number }) => {
      if (seen) {
        seen.provider = config.provider
        seen.model = config.model
      }
      return Promise.resolve({
        config,
        stream: async function* () {
          if (seen) seen.system = HANDOFF_SYSTEM
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })
    },
  }
}

describe('Config', () => {
  it('rejects a half-configured route after resolution', () => {
    const { model: _model, ...noModel } = CONFIG
    expect(() => resolveConfig({ ...noModel })).toThrow('configured together')
    const { provider: _provider, ...noProvider } = CONFIG
    expect(() => resolveConfig({ ...noProvider })).toThrow('configured together')
    expect(() => resolveConfig(CONFIG)).not.toThrow()
  })
})

describe('buildHandoffMessages', () => {
  it('keeps the whole history under the cap and appends the goal', () => {
    const messages = buildHandoffMessages(historyOf(3), 'ship it', 40)
    expect(messages).toHaveLength(4)
    expect(messages.at(-1)!.role).toBe('user')
  })

  it('keeps only the most recent messages over the cap', () => {
    const messages = buildHandoffMessages(historyOf(10), 'ship it', 3)
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user' })
  })

  it('accepts an empty history', () => {
    expect(buildHandoffMessages([], 'goal', 5)).toHaveLength(1)
  })
})

describe('requestHandoffPrompt', () => {
  it('returns the assistant text and uses the configured route', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior work' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const seen: { provider?: string; model?: string; system?: string } = {}
    ctx.provide('llm', stubLlm('## Task\nship it', seen))
    const prompt = await requestHandoffPrompt(ctx, {
      commandId: 'cmd-1' as never,
      agent: { model: { current: () => undefined }, session } as never,
      rawInput: 'ship it',
      attachments: [],
      signal: new AbortController().signal,
    }, CONFIG)
    expect(prompt).toBe('## Task\nship it')
    expect(seen.provider).toBe('mock')
    expect(seen.model).toBe('mock-fast')
    expect(seen.system).toBe(HANDOFF_SYSTEM)
    await ctx.fiber.dispose()
  })

  it('fails when the reply carries no text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm(''))
    await expect(requestHandoffPrompt(ctx, {
      commandId: 'cmd-1' as never,
      agent: { model: { current: () => undefined }, session } as never,
      rawInput: 'goal',
      attachments: [],
      signal: new AbortController().signal,
    }, CONFIG)).rejects.toThrow('no text')
    await ctx.fiber.dispose()
  })

  it('rejects a missing route with no session selection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm('x'))
    const { provider: _provider, model: _model, ...config } = CONFIG
    await expect(requestHandoffPrompt(ctx, {
      commandId: 'cmd-1' as never,
      agent: { model: { current: () => undefined }, session } as never,
      rawInput: 'goal',
      attachments: [],
      signal: new AbortController().signal,
    }, config)).rejects.toThrow('no model selection')
    await ctx.fiber.dispose()
  })
})

describe('executeHandoff', () => {
  it('requires a goal', async () => {
    const ctx = new Context()
    const result = await executeHandoff(ctx, {
      commandId: 'cmd-1' as never,
      agent: {} as never,
      rawInput: '   ',
      attachments: [],
      signal: new AbortController().signal,
    }, CONFIG)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /handoff')
  })
})
