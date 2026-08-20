/** Cost estimate and formatter helpers: flat, time-tiered, and len-tiered billing. */
import { describe, expect, it } from 'vitest'
import {
  accumulateCost, billingFor, billedInputTokens, costBreakdown, estimateCost, formatCost,
  parseRateCard, tierFor,
} from '../src/client/cost.ts'

/** Peak instant: 2026-08-19 01:00 UTC = 09:00 Asia/Shanghai (first peak window start, 540). */
const PEAK_AT = Date.UTC(2026, 7, 19, 1, 0, 0)
/** Off-peak instant: 2026-08-19 20:00 UTC = 04:00 Asia/Shanghai. */
const OFF_PEAK_AT = Date.UTC(2026, 7, 19, 20, 0, 0)

const USAGE = { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }

describe('billingFor', () => {
  it('resolves time-tiered, len-tiered, flat, and unknown models', () => {
    expect(billingFor('deepseek-v4-flash').mode).toBe('time')
    expect(billingFor('qwen3.5-flash').mode).toBe('len')
    expect(billingFor('claude-sonnet-4-6').mode).toBe('flat')
    expect(billingFor('future-model').mode).toBe('flat')
  })
})

describe('tierFor', () => {
  it('selects peak vs off-peak for deepseek by Asia/Shanghai minute', () => {
    const billing = billingFor('deepseek-v4-flash')
    const peak = tierFor(billing, USAGE, PEAK_AT)
    expect(peak.inputPerMillion).toBe(3)
    expect(peak.outputPerMillion).toBe(9)
    expect(peak.cacheReadPerMillion).toBe(0.1)
    const off = tierFor(billing, USAGE, OFF_PEAK_AT)
    expect(off.inputPerMillion).toBe(1.5)
    expect(off.outputPerMillion).toBe(4.5)
    expect(off.cacheReadPerMillion).toBe(0.05)
  })

  it('selects the len tier covering the billed input length', () => {
    const billing = billingFor('qwen3.5-flash')
    const noCache = { ...USAGE, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const small = tierFor(billing, { ...noCache, uncachedInputTokens: 100_000 }, 0)
    expect(small.inputPerMillion).toBe(0.2)
    const mid = tierFor(billing, { ...noCache, uncachedInputTokens: 200_000 }, 0)
    expect(mid.inputPerMillion).toBe(0.8)
    const big = tierFor(billing, { ...noCache, uncachedInputTokens: 1_000_000 }, 0)
    expect(big.inputPerMillion).toBe(1.2)
  })
})

describe('estimateCost and costBreakdown', () => {
  it('bills deepseek at off-peak rates outside peak windows', () => {
    // input 1M×1.5 + cache 1M×0.05 + output 0.5M×4.5 = 1.5+0.05+2.25 = 3.80
    const cost = estimateCost(USAGE, 'deepseek-v4-flash', OFF_PEAK_AT)
    expect(cost).toBeCloseTo(3.80, 10)
    const parts = costBreakdown(USAGE, 'deepseek-v4-flash', OFF_PEAK_AT)
    expect(parts.input).toBeCloseTo(1.5, 10)
    expect(parts.cache).toBeCloseTo(0.05, 10)
    expect(parts.output).toBeCloseTo(2.25, 10)
  })

  it('bills deepseek at 2x peak rates inside peak windows', () => {
    // input 1M×3 + cache 1M×0.1 + output 0.5M×9 = 3+0.1+4.5 = 7.60
    const cost = estimateCost(USAGE, 'deepseek-v4-flash', PEAK_AT)
    expect(cost).toBeCloseTo(7.60, 10)
  })

  it('bills a len-tiered model at the tier covering the input length', () => {
    const cost = estimateCost(
      { uncachedInputTokens: 200_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'qwen3.5-flash',
      0,
    )
    // input 200K×0.8 + output 0.5M×8 = 0.16 + 4 = 4.16
    expect(cost).toBeCloseTo(4.16, 10)
  })
})

describe('accumulateCost', () => {
  it('sums buckets and per-model subtotals over messages at their own times', () => {
    const totals = accumulateCost([
      { usage: USAGE, model: 'deepseek-v4-flash', at: OFF_PEAK_AT }, // 3.80
      { usage: USAGE, model: 'deepseek-v4-flash', at: PEAK_AT }, // 7.60
      // deepseek-v4-pro off-peak: input 1M×4.5 + cache 1M×0.15 + output 0.5M×13.5 = 4.5+0.15+6.75 = 11.40
      { usage: USAGE, model: 'deepseek-v4-pro', at: OFF_PEAK_AT },
    ])
    expect(totals.input).toBeCloseTo(1.5 + 3 + 4.5, 10)
    expect(totals.cache).toBeCloseTo(0.05 + 0.1 + 0.15, 10)
    expect(totals.output).toBeCloseTo(2.25 + 4.5 + 6.75, 10)
    expect(totals.total).toBeCloseTo(3.80 + 7.60 + 11.40, 10)
    expect(totals.models).toHaveLength(2)
    const flash = totals.models.find(m => m.model === 'deepseek-v4-flash')
    expect(flash?.cost).toBeCloseTo(3.80 + 7.60, 10)
  })
})

describe('billedInputTokens and formatCost', () => {
  it('sums the three prompt-side buckets', () => {
    expect(billedInputTokens({ uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 })).toBe(100)
  })

  it('formats yuan with two decimals and thousands grouping, hiding sub-cent amounts', () => {
    expect(formatCost(0)).toBe('¥0.00')
    expect(formatCost(0.0049)).toBe('¥0.00')
    expect(formatCost(0.005)).toBe('¥0.01')
    expect(formatCost(1.8665)).toBe('¥1.87')
    expect(formatCost(1_234.5)).toBe('¥1,234.50')
  })
})

describe('parseRateCard', () => {
  it('parses and validates a user card with all three billing modes', () => {
    const card = parseRateCard(JSON.stringify({
      default: { inputPerMillion: 2, outputPerMillion: 6 },
      models: {
        'flat-model': { mode: 'flat', flat: { inputPerMillion: 1, outputPerMillion: 3 } },
        'time-model': {
          mode: 'time',
          time: { timezone: 'Asia/Shanghai', peak: [{ startMinute: 0, endMinute: 60 }], tiers: [
            { name: 'default', inputPerMillion: 1, outputPerMillion: 3 },
            { name: 'peak', inputPerMillion: 2, outputPerMillion: 6 },
          ] },
        },
        'len-model': { mode: 'len', len: { tiers: [
          { name: 'small', maxLen: 1000, inputPerMillion: 1, outputPerMillion: 2 },
          { name: 'big', inputPerMillion: 4, outputPerMillion: 8 },
        ] } },
      },
    }))
    expect(card.default.inputPerMillion).toBe(2)
    expect(card.models['flat-model']!).toEqual({ mode: 'flat', flat: { inputPerMillion: 1, outputPerMillion: 3 } })
    expect(card.models['time-model']!.mode).toBe('time')
    expect(card.models['len-model']!.mode).toBe('len')
  })

  it('ignores a $comment key and rejects malformed payloads', () => {
    const card = parseRateCard(JSON.stringify({
      $comment: 'note',
      default: { inputPerMillion: 1, outputPerMillion: 2 },
      models: {},
    }))
    expect(card.default.inputPerMillion).toBe(1)
    expect(() => parseRateCard('{not json')).toThrow(/not valid JSON/)
    expect(() => parseRateCard(JSON.stringify({ default: { inputPerMillion: -1, outputPerMillion: 1 }, models: {} })))
      .toThrow(/finite non-negative/)
    expect(() => parseRateCard(JSON.stringify({ default: { inputPerMillion: 1, outputPerMillion: 1 }, models: { m: { mode: 'weird' } } })))
      .toThrow(/unsupported mode/)
  })

  it('a flat card prices at its own rates (the seed bug fix: `flat` key)', () => {
    const card = parseRateCard(JSON.stringify({
      default: { inputPerMillion: 1.5, outputPerMillion: 4.5 },
      models: { 'flat-model': { mode: 'flat', flat: { inputPerMillion: 70, outputPerMillion: 350 } } },
    }))
    const cost = estimateCost(
      { uncachedInputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'flat-model',
      0,
      card,
    )
    expect(cost).toBeCloseTo(70 + 35, 10)
  })

  it('unknown models fall back to the card default and the seed card still bills', () => {
    const card = parseRateCard(JSON.stringify({
      default: { inputPerMillion: 10, outputPerMillion: 20 },
      models: {},
    }))
    const cost = estimateCost(
      { uncachedInputTokens: 100_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'future-model',
      0,
      card,
    )
    expect(cost).toBeCloseTo(1 + 2, 10)
    // The built-in seed still resolves deepseek and claude models.
    expect(billingFor('deepseek-v4-flash').mode).toBe('time')
    expect(billingFor('claude-opus-4-6').mode).toBe('flat')
  })
})
