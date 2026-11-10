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

describe('parseRateCard validation', () => {
  const BASE = { inputPerMillion: 1, outputPerMillion: 2 }
  const card = (models: Record<string, unknown>, fallback: unknown = BASE): string =>
    JSON.stringify({ default: fallback, models })

  it('rejects a root that is not an object', () => {
    expect(() => parseRateCard('[]')).toThrow(/must be a JSON object/)
    expect(() => parseRateCard('null')).toThrow(/must be a JSON object/)
  })

  it('rejects a default card that is not an object', () => {
    expect(() => parseRateCard(card({}, 1))).toThrow(/rate card: default must be an object/)
  })

  it('rejects a models table that is not an object', () => {
    expect(() => parseRateCard(JSON.stringify({ default: BASE, models: [] })))
      .toThrow(/`models` must be an object/)
    expect(() => parseRateCard(JSON.stringify({ default: BASE, models: null })))
      .toThrow(/`models` must be an object/)
  })

  it('rejects a model entry that is not an object', () => {
    expect(() => parseRateCard(card({ m: 1 }))).toThrow(/model "m" entry must be an object/)
  })

  it('rejects a flat payload that is not an object', () => {
    expect(() => parseRateCard(card({ m: { mode: 'flat', flat: null } })))
      .toThrow(/models\.m\.flat must be an object/)
  })

  it('keeps the optional cache rates only when they are numbers', () => {
    const parsed = parseRateCard(card({
      bare: { mode: 'flat', flat: { inputPerMillion: 1, outputPerMillion: 2 } },
      full: { mode: 'flat', flat: { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 } },
    }))
    expect(parsed.models['bare']).toEqual({ mode: 'flat', flat: { inputPerMillion: 1, outputPerMillion: 2 } })
    expect(parsed.models['full']).toEqual({
      mode: 'flat',
      flat: { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 },
    })
  })

  it('rejects every malformed time payload', () => {
    expect(() => parseRateCard(card({ m: { mode: 'time', time: null } })))
      .toThrow(/time payload must be an object/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { peak: [], tiers: [{ name: 'a', inputPerMillion: 1, outputPerMillion: 2 }] } } })))
      .toThrow(/time\.timezone must be a string/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: 'x', tiers: [{ name: 'a', inputPerMillion: 1, outputPerMillion: 2 }] } } })))
      .toThrow(/time\.peak must be an array/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: [1], tiers: [{ name: 'a', inputPerMillion: 1, outputPerMillion: 2 }] } } })))
      .toThrow(/time\.peak\[0\] must be an object/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: [] } } })))
      .toThrow(/time\.tiers must be a non-empty array/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: [], tiers: [] } } })))
      .toThrow(/time\.tiers must be a non-empty array/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: [], tiers: [1] } } })))
      .toThrow(/time\.tiers\[0\] must be an object/)
    expect(() => parseRateCard(card({ m: { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: [], tiers: [{ inputPerMillion: 1, outputPerMillion: 2 }] } } })))
      .toThrow(/time\.tiers\[0\]\.name must be a string/)
  })

  it('accepts a time tier cache read rate and rejects a bad one', () => {
    const parsed = parseRateCard(card({
      m: {
        mode: 'time',
        time: {
          timezone: 'Asia/Shanghai',
          peak: [{ startMinute: 540, endMinute: 1140 }],
          tiers: [{ name: 'default', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 }],
        },
      },
    }))
    expect(parsed.models['m']).toMatchObject({ mode: 'time' })
    expect(() => parseRateCard(card({
      m: {
        mode: 'time',
        time: {
          timezone: 'Asia/Shanghai',
          peak: [],
          tiers: [{ name: 'default', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: -1 }],
        },
      },
    }))).toThrow(/tiers\[0\]\.cacheReadPerMillion must be a finite non-negative number/)
  })

  it('rejects every malformed len payload', () => {
    expect(() => parseRateCard(card({ m: { mode: 'len', len: null } })))
      .toThrow(/len payload must be an object/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [] } } })))
      .toThrow(/len\.tiers must be a non-empty array/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: {} } })))
      .toThrow(/len\.tiers must be a non-empty array/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [1] } } })))
      .toThrow(/len\.tiers\[0\] must be an object/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [{ inputPerMillion: 1 }] } } })))
      .toThrow(/len\.tiers\[0\]\.name must be a string/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [{ name: 'a', maxLen: -1 }] } } })))
      .toThrow(/len\.tiers\[0\]\.maxLen must be a finite non-negative number/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [{ name: 'a', inputPerMillion: -1 }] } } })))
      .toThrow(/len\.tiers\[0\]\.inputPerMillion must be a finite non-negative number/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [{ name: 'a', outputPerMillion: -1 }] } } })))
      .toThrow(/len\.tiers\[0\]\.outputPerMillion must be a finite non-negative number/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [{ name: 'a', cacheReadPerMillion: -1 }] } } })))
      .toThrow(/len\.tiers\[0\]\.cacheReadPerMillion must be a finite non-negative number/)
    expect(() => parseRateCard(card({ m: { mode: 'len', len: { tiers: [{ name: 'a', cacheWritePerMillion: -1 }] } } })))
      .toThrow(/len\.tiers\[0\]\.cacheWritePerMillion must be a finite non-negative number/)
  })

  it('keeps every len tier field only when it is a number', () => {
    const parsed = parseRateCard(card({
      m: {
        mode: 'len',
        len: {
          tiers: [
            { name: 'bare' },
            { name: 'full', maxLen: 1000, inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 },
          ],
        },
      },
    }))
    expect(parsed.models['m']).toEqual({
      mode: 'len',
      len: {
        tiers: [
          { name: 'bare' },
          { name: 'full', maxLen: 1000, inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 },
        ],
      },
    })
  })
})

describe('billingFor case folding and fallbacks', () => {
  it('matches a model id case-insensitively before falling back', () => {
    const models = { 'Mixed-Case': { mode: 'flat' as const, flat: { inputPerMillion: 9, outputPerMillion: 9 } } }
    expect(billingFor('mixed-case', models).mode).toBe('flat')
    expect(billingFor('MIXED-CASE', models)).toBe(models['Mixed-Case'])
    expect(billingFor('other', models, { inputPerMillion: 3, outputPerMillion: 4 }))
      .toEqual({ mode: 'flat', flat: { inputPerMillion: 3, outputPerMillion: 4 } })
  })
})

describe('tierFor tier selection edges', () => {
  it('falls back to the default tier, then the first tier, when the named tier is absent', () => {
    const timeBilling = (tiers: { name: string; inputPerMillion: number; outputPerMillion: number }[]) => ({
      mode: 'time' as const,
      time: { timezone: 'Asia/Shanghai', peak: [{ startMinute: 540, endMinute: 1140 }], tiers },
    })
    // Peak window without a peak tier: the default tier wins.
    const withDefault = tierFor(
      timeBilling([
        { name: 'first', inputPerMillion: 1, outputPerMillion: 1 },
        { name: 'default', inputPerMillion: 5, outputPerMillion: 6 },
      ]),
      USAGE,
      PEAK_AT,
    )
    expect(withDefault.inputPerMillion).toBe(5)
    // No named tier at all: the first tier wins.
    const firstOnly = tierFor(timeBilling([{ name: 'only', inputPerMillion: 7, outputPerMillion: 8 }]), USAGE, PEAK_AT)
    expect(firstOnly.inputPerMillion).toBe(7)
  })

  it('keeps the fallback rates when a time model lists no tiers at all', () => {
    // The card parser rejects an empty list, but `tierFor` is also reachable
    // with a hand-built billing value, so the fallback must hold.
    const tier = tierFor(
      { mode: 'time', time: { timezone: 'Asia/Shanghai', peak: [], tiers: [] } },
      USAGE,
      OFF_PEAK_AT,
      { inputPerMillion: 4, outputPerMillion: 5 },
    )
    expect(tier.inputPerMillion).toBe(4)
    expect(tier.outputPerMillion).toBe(5)
  })

  it('keeps the fallback cache read rate when the selected time tier omits it', () => {
    const tier = tierFor(
      {
        mode: 'time',
        time: {
          timezone: 'Asia/Shanghai',
          peak: [],
          tiers: [{ name: 'off_peak', inputPerMillion: 1, outputPerMillion: 2 }],
        },
      },
      USAGE,
      OFF_PEAK_AT,
      { inputPerMillion: 9, outputPerMillion: 9, cacheReadPerMillion: 0.5 },
    )
    expect(tier.cacheReadPerMillion).toBe(0.5)
  })

  it('falls back to the default rates for len tiers that omit prices', () => {
    const tier = tierFor(
      { mode: 'len', len: { tiers: [{ name: 'bare', maxLen: 10 }] } },
      { uncachedInputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      0,
      { inputPerMillion: 4, outputPerMillion: 6, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0.3 },
    )
    expect(tier).toEqual({ inputPerMillion: 4, outputPerMillion: 6, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0.3 })
  })

  it('carries every len tier price when the tier supplies them', () => {
    const tier = tierFor(
      {
        mode: 'len',
        len: { tiers: [{ name: 'full', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 }] },
      },
      { uncachedInputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      0,
    )
    expect(tier).toEqual({ inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.2 })
  })
})

describe('cache read fallback chain', () => {
  const USAGE_NO_CACHE = { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }
  const FLAT_NO_CACHE = { mode: 'flat' as const, flat: { inputPerMillion: 1, outputPerMillion: 2 } }

  it('uses the card default cache read rate, then zero', () => {
    const models = { 'flat-model': FLAT_NO_CACHE }
    const withRate = { default: { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.5 }, models }
    expect(costBreakdown(USAGE_NO_CACHE, 'flat-model', 0, withRate).cache).toBeCloseTo(0.5, 10)
    const withoutRate = { default: { inputPerMillion: 1, outputPerMillion: 2 }, models }
    expect(costBreakdown(USAGE_NO_CACHE, 'flat-model', 0, withoutRate).cache).toBe(0)
    expect(estimateCost(USAGE_NO_CACHE, 'flat-model', 0, withoutRate)).toBeCloseTo(1, 10)
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
