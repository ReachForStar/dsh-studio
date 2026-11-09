/** Monthly spend and budget comparison: calendar window, attribution, and ratio. */
import { describe, expect, it } from 'vitest'
import { budgetStatus, monthlySpend, monthStart } from '../src/client/budget.ts'
import { estimateCost, SEED_RATE_CARD } from '../src/client/cost.ts'
import type { UsageRow } from '../src/client/session-usage.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

const A = 's-a' as SessionId
const B = 's-b' as SessionId

const usage = (over: Partial<TokenUsageProjection> = {}): TokenUsageProjection => ({
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
})

const NOW = new Date(2026, 4, 15, 12).getTime()
const START = new Date(2026, 4, 1).getTime()

describe('monthStart', () => {
  it('returns the first local instant of the calendar month', () => {
    expect(monthStart(NOW)).toBe(START)
  })
})

describe('monthlySpend', () => {
  it('counts only the watched session messages settled this month', () => {
    const spent = monthlySpend([A], {}, { sessionId: A }, [
      { usage: usage({ uncachedInputTokens: 1_000_000 }), model: 'default', at: START },
      { usage: usage({ uncachedInputTokens: 1_000_000 }), model: 'default', at: START - 1 },
    ], NOW, SEED_RATE_CARD)

    expect(spent).toBeCloseTo(estimateCost(usage({ uncachedInputTokens: 1_000_000 }), 'default', START, SEED_RATE_CARD))
  })

  it('falls back to the live projection when no settled message is held', () => {
    const spent = monthlySpend([A], {}, {
      sessionId: A,
      usage: usage({ uncachedInputTokens: 1_000_000 }),
    }, [], NOW, SEED_RATE_CARD)

    expect(spent).toBeCloseTo(estimateCost(usage({ uncachedInputTokens: 1_000_000 }), 'default', NOW, SEED_RATE_CARD))
  })

  it('skips the watched session without usage and no settled messages', () => {
    expect(monthlySpend([A], {}, { sessionId: A }, [], NOW, SEED_RATE_CARD)).toBe(0)
  })

  it('counts another session only when its row was updated this month', () => {
    const rows: Record<string, UsageRow | undefined> = {
      [B]: { updatedAt: START, projectionValues: { tokenUsage: usage({ uncachedInputTokens: 1_000_000 }) } },
      's-old': { updatedAt: START - 1, projectionValues: { tokenUsage: usage({ uncachedInputTokens: 1_000_000 }) } },
      's-unknown': {},
    }
    const spent = monthlySpend([B, 's-old' as SessionId, 's-unknown' as SessionId, 's-missing' as SessionId], rows, { sessionId: A }, [], NOW, SEED_RATE_CARD)

    expect(spent).toBeCloseTo(estimateCost(usage({ uncachedInputTokens: 1_000_000 }), 'default', NOW, SEED_RATE_CARD))
  })
})

describe('budgetStatus', () => {
  it('reports no ratio without a positive budget', () => {
    expect(budgetStatus(2, null)).toEqual({ spent: 2, budget: null, ratio: null, over: false })
    expect(budgetStatus(2, 0)).toEqual({ spent: 2, budget: 0, ratio: null, over: false })
  })

  it('computes the used share and flags an overspend', () => {
    expect(budgetStatus(5, 10)).toEqual({ spent: 5, budget: 10, ratio: 0.5, over: false })
    expect(budgetStatus(15, 10)).toEqual({ spent: 15, budget: 10, ratio: 1.5, over: true })
  })
})
