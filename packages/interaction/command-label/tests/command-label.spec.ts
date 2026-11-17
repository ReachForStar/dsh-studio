import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import {
  executeLabel,
  lastAssistantSeq,
  normalizeLabel,
  sessionLabelsProjectionDefinition,
} from '../src/index.ts'

function invocationOf(session: Session, rawInput: string) {
  return { agent: { session }, rawInput } as never
}

function seedAssistant(session: Session) {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'mock', model: 'mock' } }),
    stream: [],
  }, { surfaceOp: 'append' })
}

describe('normalizeLabel', () => {
  it('trims and rejects empty or oversized labels', () => {
    expect(normalizeLabel('  ship it  ')).toBe('ship it')
    expect(normalizeLabel('   ')).toBeUndefined()
    expect(normalizeLabel('x'.repeat(81))).toBeUndefined()
    expect(normalizeLabel('x'.repeat(80))).toHaveLength(80)
  })
})

describe('lastAssistantSeq', () => {
  it('returns the last assistant message seq and undefined when none exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    expect(lastAssistantSeq(session)).toBeUndefined()
    const assistant = seedAssistant(session)
    expect(lastAssistantSeq(session)).toBe(assistant.seq)
    await ctx.fiber.dispose()
  })
})

describe('sessionLabelsProjectionDefinition', () => {
  it('folds labels and clears by null', () => {
    const first = sessionLabelsProjectionDefinition.apply({}, {
      type: 'session/label', seq: 1 as never, time: 0, data: { target: 42 as never, label: 'checkpoint' },
    } as never)
    expect(first).toEqual({ '42': 'checkpoint' })
    const second = sessionLabelsProjectionDefinition.apply(first, {
      type: 'session/label', seq: 2 as never, time: 0, data: { target: 42 as never, label: null },
    } as never)
    expect(second).toEqual({})
  })
})

describe('executeLabel', () => {
  it('requires input and an assistant message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    expect(executeLabel(invocationOf(session, '   ')).kind).toBe('error')
    expect(executeLabel(invocationOf(session, 'checkpoint')).text).toContain('No assistant message')
    await ctx.fiber.dispose()
  })

  it('labels the last assistant message and clears it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    seedAssistant(session)
    expect(executeLabel(invocationOf(session, 'checkpoint')).kind).toBe('success')
    const labeled = session.snapshotEvents().at(-1)
    expect(labeled).toMatchObject({ type: 'session/label', data: { label: 'checkpoint' } })
    expect(executeLabel(invocationOf(session, 'clear')).kind).toBe('success')
    const cleared = session.snapshotEvents().at(-1)
    expect(cleared).toMatchObject({ type: 'session/label', data: { label: null } })
    await ctx.fiber.dispose()
  })

  it('rejects an oversized label', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    seedAssistant(session)
    expect(executeLabel(invocationOf(session, 'x'.repeat(81))).kind).toBe('error')
    await ctx.fiber.dispose()
  })
})
