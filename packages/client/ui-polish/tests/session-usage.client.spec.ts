/** Per-session usage rows: live projection, message-priced totals, and ordering. */
import { describe, expect, it } from 'vitest'
import { sessionUsageRows, type UsageRow } from '../src/client/session-usage.ts'
import { estimateCost, SEED_RATE_CARD } from '../src/client/cost.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

const A = 's-a' as SessionId
const B = 's-b' as SessionId

const usage = (over: Partial<TokenUsageProjection> = {}): TokenUsageProjection => ({
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
})

describe('sessionUsageRows', () => {
  it('prices the watched session from its totals and the rest at the card default', () => {
    const rows: Record<string, UsageRow | undefined> = {
      [A]: { displayTitle: 'Alpha', projectionValues: { tokenUsage: usage({ uncachedInputTokens: 1_000 }) } },
      [B]: { displayTitle: 'Beta', projectionValues: { tokenUsage: usage({ uncachedInputTokens: 1_000_000 }) } },
    }
    const result = sessionUsageRows([A, B], rows, {
      sessionId: A,
      usage: usage({ uncachedInputTokens: 2_000_000 }),
      totals: { input: 3, cache: 0, output: 0, total: 3, models: [] },
    }, 0, SEED_RATE_CARD)

    expect(result).toEqual([
      { sessionId: A, title: 'Alpha', tokens: 2_000_000, cost: 3, current: true },
      { sessionId: B, title: 'Beta', tokens: 1_000_000, cost: estimateCost(usage({ uncachedInputTokens: 1_000_000 }), 'default', 0, SEED_RATE_CARD), current: false },
    ])
  })

  it('falls back to the listed row when the watched session has no live usage', () => {
    const result = sessionUsageRows(
      [A],
      { [A]: { projectionValues: { tokenUsage: usage({ outputTokens: 10 }) } } },
      { sessionId: A },
      0,
      SEED_RATE_CARD,
    )

    expect(result[0]?.tokens).toBe(10)
  })

  it('skips sessions without a projection and sessions without billable activity', () => {
    const rows: Record<string, UsageRow | undefined> = {
      [A]: {},
      [B]: { projectionValues: { tokenUsage: usage() } },
    }
    expect(sessionUsageRows([A, B, 's-missing' as SessionId], rows, { sessionId: A }, 0, SEED_RATE_CARD))
      .toEqual([])
  })

  it('uses the session id when the row projects no title and orders equal totals by id', () => {
    const rows: Record<string, UsageRow | undefined> = {
      [B]: { projectionValues: { tokenUsage: usage({ outputTokens: 5 }) } },
      [A]: { projectionValues: { tokenUsage: usage({ outputTokens: 5 }) } },
    }
    const result = sessionUsageRows([B, A], rows, { sessionId: B }, 0, SEED_RATE_CARD)

    expect(result.map(row => row.title)).toEqual(['s-a', 's-b'])
    expect(result.map(row => row.current)).toEqual([false, true])
  })
})
