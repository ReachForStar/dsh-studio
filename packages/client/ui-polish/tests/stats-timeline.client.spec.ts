/** Stats timeline: adaptive bucketing, per-message pricing, and width labels. */
import { describe, expect, it } from 'vitest'
import { buildTimeline, spanLabel } from '../src/client/stats-timeline.ts'
import { costBreakdown, SEED_RATE_CARD } from '../src/client/cost.ts'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

const usage = (over: Partial<TokenUsageProjection> = {}): TokenUsageProjection => ({
  uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
})

const MINUTE = 60_000

describe('buildTimeline', () => {
  it('returns null without settled messages', () => {
    expect(buildTimeline([], 0, SEED_RATE_CARD)).toBeNull()
  })

  it('buckets a short session in five-minute spans', () => {
    const now = 10 * MINUTE
    const timeline = buildTimeline([
      { usage: usage({ uncachedInputTokens: 1_000 }), model: 'default', at: 0 },
      { usage: usage({ outputTokens: 2_000 }), model: 'default', at: now },
    ], now, SEED_RATE_CARD)

    expect(timeline?.span).toBe(5 * MINUTE)
    expect(timeline?.buckets).toHaveLength(2)
    expect(timeline?.buckets.map(bucket => bucket.tokens)).toEqual([1_000, 2_000])
    const expected = costBreakdown(usage({ uncachedInputTokens: 1_000 }), 'default', 0, SEED_RATE_CARD)
    expect(timeline?.buckets[0]?.cost).toBeCloseTo(expected.input)
  })

  it('widens to hourly buckets once the range needs more than the cap', () => {
    const now = 121 * MINUTE
    const timeline = buildTimeline([{ usage: usage({ uncachedInputTokens: 1 }), model: 'default', at: 0 }], now, SEED_RATE_CARD)

    expect(timeline?.span).toBe(60 * MINUTE)
    expect(timeline?.buckets).toHaveLength(3)
  })

  it('widens to daily buckets for a session older than a day', () => {
    const now = 25 * 60 * MINUTE
    const timeline = buildTimeline([{ usage: usage({ uncachedInputTokens: 1 }), model: 'default', at: 0 }], now, SEED_RATE_CARD)

    expect(timeline?.span).toBe(24 * 60 * MINUTE)
    expect(timeline?.buckets).toHaveLength(2)
  })

  it('clamps a message older than the retained window into the oldest bucket', () => {
    const now = 25 * 60 * MINUTE
    const timeline = buildTimeline([
      { usage: usage({ uncachedInputTokens: 5 }), model: 'default', at: 0 },
      { usage: usage({ uncachedInputTokens: 7 }), model: 'default', at: now - 1 },
    ], now, SEED_RATE_CARD)

    expect(timeline?.buckets[0]?.tokens).toBe(5)
    expect(timeline?.buckets[1]?.tokens).toBe(7)
  })
})

describe('spanLabel', () => {
  it('names the largest unit that divides the width', () => {
    expect(spanLabel(5 * MINUTE)).toEqual({ unit: 'minute', count: 5 })
    expect(spanLabel(60 * MINUTE)).toEqual({ unit: 'hour', count: 1 })
    expect(spanLabel(24 * 60 * MINUTE)).toEqual({ unit: 'day', count: 1 })
  })
})
