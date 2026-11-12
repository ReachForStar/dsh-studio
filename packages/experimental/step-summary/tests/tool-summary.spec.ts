
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { LlmService } from '@deepseek-ai/dsh-llm'
import * as ToolSummary from '../src/index.ts'
import {
  collectToolBatch,
  resultExcerpt,
  normalizeSummary,
  renderBatchInput,
  requestSummary,
  type Config,
} from '../src/index.ts'

const CONFIG: Config = {
  maxOutputTokens: 64,
  timeoutMs: 5_000,
  maxInputBytes: 1_000,
  maxSummaryChars: 80,
  provider: 'mock',
  model: 'mock-fast',
}

function toolCall(session: Session, turn: number, step: number, callId: string, name: string, args: string) {
  return session.append('tool/call', {
    turn,
    step,
    callId: ToolCallId(callId),
    name,
    arguments: args,
  })
}

function toolResult(session: Session, turn: number, step: number, callId: string, text: string, isError = false) {
  return session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      isError,
    }),
  }, { surfaceOp: 'append' })
}

function stubLlm(reply: string): LlmService {
  const stream = async function* () {
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return {
    prepareCall: () => Promise.resolve({
      config: { provider: 'mock', model: 'mock-fast', maxTokens: 64 },
      stream,
    }),
  }
}

describe('collectToolBatch', () => {
  it('pairs calls with results in call order and marks failures', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const events = [
      toolCall(session, 1, 1, 'a', 'read', '{"path":"x"}'),
      toolResult(session, 1, 1, 'a', 'file body'),
      toolCall(session, 1, 1, 'b', 'bash', '{"command":"ls"}'),
      toolResult(session, 1, 1, 'b', 'boom', true),
      toolCall(session, 1, 2, 'c', 'other', '{}'),
    ]
    const entries = collectToolBatch(events, 1, 1)
    expect(entries.map(entry => entry.name)).toEqual(['read', 'bash'])
    const duplicate = toolCall(session, 1, 1, 'a', 'read', '{"path":"y"}')
    expect(collectToolBatch([...events, duplicate], 1, 1)).toHaveLength(2)
    expect(entries[0]!.result).toBe('file body')
    expect(entries[1]!.isError).toBe(true)
    await ctx.fiber.dispose()
  })

  it('keeps calls without results and ignores results without calls', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const events = [
      toolCall(session, 1, 1, 'a', 'read', '{"path":"x"}'),
      toolResult(session, 1, 1, 'ghost', 'orphan'),
    ]
    const entries = collectToolBatch(events, 1, 1)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.result).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('resultExcerpt', () => {
  it('handles non-array content, non-text blocks, and very long results', () => {
    expect(resultExcerpt('not blocks')).toBe('')
    expect(resultExcerpt([{ type: 'image', url: 'x' }, { type: 'text', text: 'a\n b' }])).toBe('a b')
    expect(resultExcerpt([{ type: 'text', text: 'x'.repeat(400) }])).toHaveLength(201)
  })
})

describe('duplicate step events', () => {
  it('starts one request for a replayed step/end and skips empty replies', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const prepare = vi.fn()
    let release: (() => void) | undefined
    const gate = new Promise((resolve) => { release = () => { resolve() } })
    ctx.provide('llm', {
      prepareCall: () => {
        prepare()
        const stream = async function* () {
          await gate
          yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return Promise.resolve({ config: { provider: 'm', model: 'm' }, stream })
      },
    })
    await ctx.plugin(ToolSummary, CONFIG)
    toolCall(session, 1, 1, 'a', 'bash', '{}')
    toolResult(session, 1, 1, 'a', 'done')
    const end = session.append('step/end', { turn: 1, step: 1 })
    ctx.emit('session/event', session, end)
    ctx.emit('session/event', session, end)
    release?.()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(prepare).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('aborts in-flight requests on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const stream = async function* () {
      await new Promise(() => { /* never resolves */ })
    }
    ctx.provide('llm', {
      prepareCall: () => Promise.resolve({ config: { provider: 'm', model: 'm' }, stream }),
    })
    await ctx.plugin(ToolSummary, CONFIG)
    toolCall(session, 1, 1, 'a', 'bash', '{}')
    session.append('step/end', { turn: 1, step: 1 })
    await new Promise(resolve => setTimeout(resolve, 30))
    await ctx.fiber.dispose()
  })
})

describe('renderBatchInput', () => {
  it('frames the batch with outcomes', () => {
    const input = renderBatchInput([
      { name: 'read', arguments: '{"path":"x"}', result: 'body' },
      { name: 'bash', arguments: '{}', isError: true, result: 'boom' },
      { name: 'wait', arguments: '' },
    ], 1_000)
    expect(input).toContain('- read {"path":"x"}')
    expect(input).toContain('result: body')
    expect(input).toContain('error: boom')
    expect(input).toContain('no result')
  })

  it('drops lines over the byte cap', () => {
    const input = renderBatchInput([
      { name: 'read', arguments: 'x'.repeat(500), result: 'body' },
      { name: 'bash', arguments: 'y'.repeat(500), result: 'later' },
    ], 300)
    expect(input).not.toContain('later')
    expect(input.startsWith('Summarize this tool batch')).toBe(true)
  })

  it('keeps the lines that fit', () => {
    const input = renderBatchInput([
      { name: 'read', arguments: '{}', result: 'body' },
      { name: 'bash', arguments: 'y'.repeat(500), result: 'later' },
    ], 120)
    expect(input).toContain('result: body')
    expect(input).not.toContain('later')
  })

  it('falls back to the bare prompt when no line fits', () => {
    const input = renderBatchInput([{ name: 'read', arguments: 'x'.repeat(500) }], 10)
    expect(input).toBe('Summarize this tool batch in one short sentence.')
  })
})

describe('normalizeSummary', () => {
  it('collapses whitespace into one line', () => {
    expect(normalizeSummary('  read\n\ntwo files  ', 80)).toBe('read two files')
  })

  it('returns undefined for empty replies and truncates long ones', () => {
    expect(normalizeSummary('   ', 80)).toBeUndefined()
    expect(normalizeSummary('x'.repeat(200), 80)).toHaveLength(80)
  })
})

describe('requestSummary', () => {
  it('returns the model reply for the rendered batch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm('read two files'))
    const summary = await requestSummary(
      ctx, session, CONFIG,
      [{ name: 'read', arguments: '{}', result: 'body' }],
      new AbortController().signal,
    )
    expect(summary).toBe('read two files')
    await ctx.fiber.dispose()
  })

  it('requires an explicit route', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    await expect(requestSummary(
      ctx, session, {
        maxOutputTokens: 64, timeoutMs: 5_000, maxInputBytes: 1_000, maxSummaryChars: 80,
      }, [], new AbortController().signal,
    )).rejects.toThrow('provider and model must be configured together')
    await ctx.fiber.dispose()
  })
})

describe('apply', () => {
  it('logs one summary per step with a tool batch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm('listed the directory'))
    ctx.provide('logger', { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
    await ctx.plugin(ToolSummary, CONFIG)
    toolCall(session, 1, 1, 'a', 'bash', '{"command":"ls"}')
    toolResult(session, 1, 1, 'a', 'a.txt')
    const summaries: { data: unknown }[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/batch-summary') summaries.push(event)
    })
    session.append('step/end', { turn: 1, step: 1 })
    await vi.waitFor(() => {
      expect(summaries).toHaveLength(1)
      expect(summaries[0]!.data).toMatchObject({ turn: 1, step: 1, summary: 'listed the directory', callCount: 1 })
    }, { timeout: 5_000 })
    await ctx.fiber.dispose()
  })

  it('skips steps without tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const prepare = vi.fn()
    ctx.provide('llm', { prepareCall: prepare })
    await ctx.plugin(ToolSummary, CONFIG)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 2 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(prepare).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('deduplicates replayed calls and ignores orphan results', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm('one failure'))
    await ctx.plugin(ToolSummary, CONFIG)
    toolCall(session, 1, 1, 'a', 'bash', '{}')
    toolCall(session, 1, 1, 'a', 'bash', '{}')
    toolResult(session, 1, 1, 'ghost', 'orphan')
    toolResult(session, 1, 1, 'a', 'boom', true)
    const summaries: { data: unknown }[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/batch-summary') summaries.push(event)
    })
    session.append('step/end', { turn: 1, step: 1 })
    await vi.waitFor(() => {
      expect(summaries).toHaveLength(1)
      expect(summaries[0]!.data).toMatchObject({ callCount: 1, summary: 'one failure' })
    }, { timeout: 5_000 })
    await ctx.fiber.dispose()
  })

  it('warns instead of throwing when the auxiliary request fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.provide('llm', { prepareCall: () => Promise.reject(new Error('no route')) })
    await ctx.plugin(ToolSummary, CONFIG)
    toolCall(session, 1, 1, 'a', 'bash', '{}')
    session.append('step/end', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() }, { timeout: 5_000 })
    await ctx.fiber.dispose()
  })
})
