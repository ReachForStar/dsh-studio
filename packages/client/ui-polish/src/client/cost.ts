// Cost estimate for the stats float: a pure function set over per-message
// usage priced against a rate card (CNY per 1M tokens). The built-in card in
// `model-pricing.json` is the seed; the user can override it through the
// ui-polish settings row, which persists a JSON card and re-prices the float
// without a rebuild. Three billing modes come from the amaxsmp gateway:
// flat per-model prices, time-tiered peak/off-peak (deepseek), and
// length-tiered prices. Unknown models fall back to the `default` card so a
// newly released model still shows an estimate.

import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import seedCard from './model-pricing.json'

/** One flat model's prices in CNY per 1M tokens; cache fields may be absent. */
export interface FlatRateCard {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
}

/** One time tier (deepseek peak/off-peak). */
export interface TimeTier {
  name: string
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
}

/** One length tier with its upper bound (omitted on the catch-all final tier). */
export interface LenTier {
  name: string
  maxLen?: number
  inputPerMillion?: number
  outputPerMillion?: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
}

/** A model's billing mode (mirrors the JSON structure: nested per-mode payloads). */
export type ModelBilling =
  | { mode: 'flat'; flat: FlatRateCard }
  | { mode: 'time'; time: { timezone: string; peak: readonly { startMinute: number; endMinute: number }[]; tiers: readonly TimeTier[] } }
  | { mode: 'len'; len: { tiers: readonly LenTier[] } }

/** One complete rate card: the fallback card plus per-model billing modes. */
export interface RateCardData {
  /** Fallback card for unknown models. */
  default: FlatRateCard
  /** Model-name → billing mode. */
  models: Readonly<Record<string, ModelBilling>>
}

/** The built-in seed card (deepseek-v4-flash off-peak: input 1.5 / output 4.5 / cache read 0.05). */
export const DEFAULT_RATE_CARD: FlatRateCard = seedCard.default

/** The built-in seed model table. */
export const DEFAULT_MODEL_BILLING: Readonly<Record<string, ModelBilling>> =
  seedCard.models as Readonly<Record<string, ModelBilling>>

/** The complete built-in seed card. */
export const SEED_RATE_CARD: RateCardData = {
  default: DEFAULT_RATE_CARD,
  models: DEFAULT_MODEL_BILLING,
}

/** Non-finite numbers corrupt every price computation; a card is rejected wholesale. */
function finiteNonNegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`rate card: ${where} must be a finite non-negative number`)
  }
  return value
}

/** Validate one flat card payload. */
function parseFlatCard(value: unknown, where: string): FlatRateCard {
  if (typeof value !== 'object' || value === null) throw new Error(`rate card: ${where} must be an object`)
  const record = value as Record<string, unknown>
  return {
    inputPerMillion: finiteNonNegative(record['inputPerMillion'], `${where}.inputPerMillion`),
    outputPerMillion: finiteNonNegative(record['outputPerMillion'], `${where}.outputPerMillion`),
    ...typeof record['cacheReadPerMillion'] === 'number'
      ? { cacheReadPerMillion: finiteNonNegative(record['cacheReadPerMillion'], `${where}.cacheReadPerMillion`) }
      : {},
    ...typeof record['cacheWritePerMillion'] === 'number'
      ? { cacheWritePerMillion: finiteNonNegative(record['cacheWritePerMillion'], `${where}.cacheWritePerMillion`) }
      : {},
  }
}

/** Validate one billing-mode payload against the three supported shapes. */
function parseModelBilling(value: unknown, model: string): ModelBilling {
  if (typeof value !== 'object' || value === null) throw new Error(`rate card: model "${model}" entry must be an object`)
  const record = value as Record<string, unknown>
  if (record['mode'] === 'flat') {
    return { mode: 'flat', flat: parseFlatCard(record['flat'], `models.${model}.flat`) }
  }
  if (record['mode'] === 'time') {
    const time = record['time']
    if (typeof time !== 'object' || time === null) {
      throw new Error(`rate card: model "${model}" time payload must be an object`)
    }
    const timeRecord = time as Record<string, unknown>
    if (typeof timeRecord['timezone'] !== 'string') {
      throw new Error(`rate card: model "${model}" time.timezone must be a string`)
    }
    if (!Array.isArray(timeRecord['peak'])) {
      throw new Error(`rate card: model "${model}" time.peak must be an array`)
    }
    const peak = timeRecord['peak'].map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`rate card: model "${model}" time.peak[${index}] must be an object`)
      }
      const record2 = entry as Record<string, unknown>
      return {
        startMinute: finiteNonNegative(record2['startMinute'], `models.${model}.time.peak[${index}].startMinute`),
        endMinute: finiteNonNegative(record2['endMinute'], `models.${model}.time.peak[${index}].endMinute`),
      }
    })
    if (!Array.isArray(timeRecord['tiers']) || timeRecord['tiers'].length === 0) {
      throw new Error(`rate card: model "${model}" time.tiers must be a non-empty array`)
    }
    const tiers = timeRecord['tiers'].map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`rate card: model "${model}" time.tiers[${index}] must be an object`)
      }
      const record3 = entry as Record<string, unknown>
      if (typeof record3['name'] !== 'string') {
        throw new Error(`rate card: model "${model}" time.tiers[${index}].name must be a string`)
      }
      return {
        name: record3['name'],
        inputPerMillion: finiteNonNegative(record3['inputPerMillion'], `models.${model}.time.tiers[${index}].inputPerMillion`),
        outputPerMillion: finiteNonNegative(record3['outputPerMillion'], `models.${model}.time.tiers[${index}].outputPerMillion`),
        ...typeof record3['cacheReadPerMillion'] === 'number'
          ? { cacheReadPerMillion: finiteNonNegative(record3['cacheReadPerMillion'], `models.${model}.time.tiers[${index}].cacheReadPerMillion`) }
          : {},
      }
    })
    return { mode: 'time', time: { timezone: timeRecord['timezone'], peak, tiers } }
  }
  if (record['mode'] === 'len') {
    const len = record['len']
    if (typeof len !== 'object' || len === null) throw new Error(`rate card: model "${model}" len payload must be an object`)
    const lenRecord = len as Record<string, unknown>
    if (!Array.isArray(lenRecord['tiers']) || lenRecord['tiers'].length === 0) {
      throw new Error(`rate card: model "${model}" len.tiers must be a non-empty array`)
    }
    const tiers = lenRecord['tiers'].map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`rate card: model "${model}" len.tiers[${index}] must be an object`)
      }
      const record4 = entry as Record<string, unknown>
      if (typeof record4['name'] !== 'string') {
        throw new Error(`rate card: model "${model}" len.tiers[${index}].name must be a string`)
      }
      return {
        name: record4['name'],
        ...typeof record4['maxLen'] === 'number'
          ? { maxLen: finiteNonNegative(record4['maxLen'], `models.${model}.len.tiers[${index}].maxLen`) }
          : {},
        ...typeof record4['inputPerMillion'] === 'number'
          ? { inputPerMillion: finiteNonNegative(record4['inputPerMillion'], `models.${model}.len.tiers[${index}].inputPerMillion`) }
          : {},
        ...typeof record4['outputPerMillion'] === 'number'
          ? { outputPerMillion: finiteNonNegative(record4['outputPerMillion'], `models.${model}.len.tiers[${index}].outputPerMillion`) }
          : {},
        ...typeof record4['cacheReadPerMillion'] === 'number'
          ? { cacheReadPerMillion: finiteNonNegative(record4['cacheReadPerMillion'], `models.${model}.len.tiers[${index}].cacheReadPerMillion`) }
          : {},
        ...typeof record4['cacheWritePerMillion'] === 'number'
          ? { cacheWritePerMillion: finiteNonNegative(record4['cacheWritePerMillion'], `models.${model}.len.tiers[${index}].cacheWritePerMillion`) }
          : {},
      }
    })
    return { mode: 'len', len: { tiers } }
  }
  throw new Error(`rate card: model "${model}" has unsupported mode "${String(record['mode'])}"`)
}

/**
 * Parse and validate a user-supplied rate card from JSON text. The accepted
 * shape mirrors `model-pricing.json`: `{ default: FlatRateCard, models: {
 * [model]: { mode, flat | time | len } } }`. A `$comment` key is ignored.
 * @param json - the raw JSON text from the settings document.
 * @returns the validated card.
 * @throws {Error} with a field-level message when the JSON is malformed or a price is invalid.
 */
export function parseRateCard(json: string): RateCardData {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('rate card: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('rate card: must be a JSON object with `default` and `models`')
  }
  const record = parsed as Record<string, unknown>
  const fallback = parseFlatCard(record['default'], 'default')
  if (typeof record['models'] !== 'object' || record['models'] === null || Array.isArray(record['models'])) {
    throw new Error('rate card: `models` must be an object')
  }
  const models: Record<string, ModelBilling> = {}
  for (const [model, value] of Object.entries(record['models'] as Record<string, unknown>)) {
    models[model] = parseModelBilling(value, model)
  }
  return { default: fallback, models }
}

/**
 * Resolve the billing mode for one model id: exact match on the card, a
 * case-insensitive match as a fallback, then a flat card at the fallback
 * rates (the card's `default`, or the built-in seed when none is supplied).
 * @param model - the model id (from an assistant node's provenance).
 * @param models - the card's model table (defaults to the built-in seed).
 * @param fallback - the flat card unknown models fall back to (defaults to the seed).
 * @returns the effective billing mode for the model.
 */
export function billingFor(
  model: string,
  models: Readonly<Record<string, ModelBilling>> = DEFAULT_MODEL_BILLING,
  fallback: FlatRateCard = DEFAULT_RATE_CARD,
): ModelBilling {
  const exact = models[model]
  if (exact !== undefined) return exact
  const lower = model.toLowerCase()
  for (const key of Object.keys(models)) {
    if (key.toLowerCase() === lower) return models[key] as ModelBilling
  }
  return { mode: 'flat', flat: { ...fallback } }
}

/** Sum the three disjoint prompt-side billing buckets.
 * @param usage - the message's token usage projection.
 * @returns uncached + cache-read + cache-write input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Whether the given UTC instant falls inside a peak interval (minutes since midnight, Asia/Shanghai). */
function isPeakMinute(instantMs: number, peak: readonly { startMinute: number; endMinute: number }[]): boolean {
  // Asia/Shanghai is UTC+8, fixed — no DST. Derive local minutes of day.
  const local = new Date(instantMs + 8 * 60 * 60 * 1000)
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  return peak.some(iv => minute >= iv.startMinute && minute < iv.endMinute)
}

/**
 * Resolve the price tier for one message under its model's billing mode.
 * @param billing - the model's billing mode.
 * @param usage - the message's token usage (length tiers use billed input tokens).
 * @param at - the message's wall-clock instant (time tiers use Asia/Shanghai minute).
 * @param fallback - the card's default rates used for absent tier fields.
 * @returns the flat card or the selected tier's prices.
 */
export function tierFor(
  billing: ModelBilling,
  usage: TokenUsageProjection,
  at: number,
  fallback: FlatRateCard = DEFAULT_RATE_CARD,
): FlatRateCard {
  if (billing.mode === 'flat') return { ...fallback, ...billing.flat }
  if (billing.mode === 'time') {
    const { peak, tiers } = billing.time
    const isPeak = isPeakMinute(at, peak)
    const tier = isPeak
      ? tiers.find(t => t.name === 'peak')
      : tiers.find(t => t.name === 'off_peak')
    const selected = tier ?? tiers.find(t => t.name === 'default') ?? tiers[0]
    return {
      ...fallback,
      inputPerMillion: selected?.inputPerMillion ?? fallback.inputPerMillion,
      outputPerMillion: selected?.outputPerMillion ?? fallback.outputPerMillion,
      ...selected?.cacheReadPerMillion === undefined
        ? {}
        : { cacheReadPerMillion: selected.cacheReadPerMillion },
    }
  }
  // Length tiers: pick the first tier whose upper bound covers the billed input.
  const { tiers } = billing.len
  const len = billedInputTokens(usage)
  const tier = tiers.find(t => t.maxLen === undefined || len <= t.maxLen)
  return {
    ...fallback,
    ...tier?.inputPerMillion === undefined ? {} : { inputPerMillion: tier.inputPerMillion },
    ...tier?.outputPerMillion === undefined ? {} : { outputPerMillion: tier.outputPerMillion },
    ...tier?.cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion: tier.cacheReadPerMillion },
    ...tier?.cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion: tier.cacheWritePerMillion },
  }
}

/** Estimated spend in CNY for one message at its model's rate and time.
 * @param usage - the message's token usage projection.
 * @param model - the model id (from an assistant node's provenance).
 * @param at - the message's wall-clock instant.
 * @param card - the rate card to bill against (defaults to the built-in seed).
 * @returns the estimated spend in yuan.
 */
export function estimateCost(
  usage: TokenUsageProjection,
  model: string,
  at: number,
  card: RateCardData = SEED_RATE_CARD,
): number {
  const tier = tierFor(billingFor(model, card.models, card.default), usage, at, card.default)
  return (
    (usage.uncachedInputTokens + usage.cacheWriteTokens) * tier.inputPerMillion
    + usage.cacheReadTokens * (tier.cacheReadPerMillion ?? card.default.cacheReadPerMillion ?? 0)
    + usage.outputTokens * tier.outputPerMillion
  ) / 1_000_000
}

/** Per-bucket cost split for one message, mirroring {@link estimateCost}.
 * @param usage - the message's token usage projection.
 * @param model - the model id (from an assistant node's provenance).
 * @param at - the message's wall-clock instant.
 * @param card - the rate card to bill against (defaults to the built-in seed).
 * @returns the input/cache/output bucket split in yuan.
 */
export function costBreakdown(
  usage: TokenUsageProjection,
  model: string,
  at: number,
  card: RateCardData = SEED_RATE_CARD,
): { input: number; cache: number; output: number } {
  const tier = tierFor(billingFor(model, card.models, card.default), usage, at, card.default)
  return {
    input: (usage.uncachedInputTokens + usage.cacheWriteTokens) * tier.inputPerMillion / 1_000_000,
    cache: usage.cacheReadTokens * (tier.cacheReadPerMillion ?? card.default.cacheReadPerMillion ?? 0) / 1_000_000,
    output: usage.outputTokens * tier.outputPerMillion / 1_000_000,
  }
}

/** Cumulative cost over a model-keyed usage map, priced per message at its own time. */
export interface CostTotals {
  input: number
  cache: number
  output: number
  total: number
  /** Per-model subtotals for the breakdown row. */
  models: { model: string; cost: number }[]
}

/**
 * Accumulate totals over per-message usages, each priced at its model's rate
 * and its own wall-clock instant (time-tiered models switch price by hour).
 * @param messages - message usages with model and settled timestamp.
 * @param card - the rate card to bill against (defaults to the built-in seed).
 * @returns summed buckets, total, and per-model subtotals.
 */
export function accumulateCost(
  messages: readonly { usage: TokenUsageProjection; model: string; at: number }[],
  card: RateCardData = SEED_RATE_CARD,
): CostTotals {
  let input = 0
  let cache = 0
  let output = 0
  const byModel = new Map<string, number>()
  for (const message of messages) {
    const parts = costBreakdown(message.usage, message.model, message.at, card)
    input += parts.input
    cache += parts.cache
    output += parts.output
    byModel.set(message.model, (byModel.get(message.model) ?? 0) + parts.input + parts.cache + parts.output)
  }
  return {
    input,
    cache,
    output,
    total: input + cache + output,
    models: [...byModel].map(([model, cost]) => ({ model, cost })),
  }
}

/**
 * CNY display string: two decimals with thousands grouping; sub-cent amounts
 * read as ¥0.00 (the caller hides the cost row entirely at that scale).
 * @param cost - estimated cost in yuan.
 * @returns the display string, `¥` prefix included.
 */
export function formatCost(cost: number): string {
  if (cost < 0.005) return '¥0.00'
  const fixed = (Math.round(cost * 100) / 100).toFixed(2)
  return `¥${fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}
