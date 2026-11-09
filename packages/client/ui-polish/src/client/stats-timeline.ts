// Token timeline for the session on screen: settled assistant messages folded
// into equal, contiguous buckets whose newest edge is the current instant. The
// bucket width is the finest offered width that keeps the count under
// {@link MAX_BUCKETS}, so a short session reads in minutes and a long one in
// days without ever drawing more bars than the card can show.

import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { billedInputTokens, costBreakdown, type RateCardData } from './cost.ts'

/** One priced bucket of the timeline. */
export interface TimelineBucket {
  /** Bucket start, Unix epoch ms. */
  start: number
  /** Billed input plus output tokens settled in the bucket. */
  tokens: number
  /** Estimated cost of those tokens, in yuan. */
  cost: number
}

/** A built timeline: contiguous buckets plus the width each one covers. */
export interface Timeline {
  /** Oldest bucket first; the last bucket ends at the instant passed in. */
  buckets: TimelineBucket[]
  /** Bucket width in ms (5 minutes, 1 hour, or 1 day). */
  span: number
}

/** Offered bucket widths, from the finest that keeps the count under the cap. */
const SPANS = [5 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const

/** Widest offered width; a session older than the cap is shown in days. */
const WIDEST_SPAN = 24 * 60 * 60_000

/** Buckets rendered at most; the newest bucket always ends at the given instant. */
export const MAX_BUCKETS = 24

/**
 * Fold per-message usage into the timeline of one session.
 *
 * Every message is priced at its own model's rate and settle time, so a
 * bucket's cost matches what the totals row charges for the same tokens. A
 * message outside the retained window (older than the newest bucket) lands in
 * the oldest bucket rather than being dropped.
 * @param messages - the session's cost-attributable settled messages.
 * @param now - the instant the newest bucket ends at.
 * @param card - the rate card pricing the buckets.
 * @returns the timeline, or null when the session has no settled messages.
 */
export function buildTimeline(
  messages: readonly { usage: TokenUsageProjection; model: string; at: number }[],
  now: number,
  card: RateCardData,
): Timeline | null {
  if (messages.length === 0) return null
  const oldest = messages.reduce((min, message) => Math.min(min, message.at), now)
  const range = now - oldest
  const span = SPANS.find(width => Math.ceil(range / width) <= MAX_BUCKETS) ?? WIDEST_SPAN
  const count = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(range / span)))
  const start = now - count * span
  const buckets = Array.from({ length: count }, (_, index): TimelineBucket => ({
    start: start + index * span,
    tokens: 0,
    cost: 0,
  }))
  for (const message of messages) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((message.at - start) / span)))
    const bucket = buckets[index] as TimelineBucket
    const parts = costBreakdown(message.usage, message.model, message.at, card)
    bucket.tokens += billedInputTokens(message.usage) + message.usage.outputTokens
    bucket.cost += parts.input + parts.cache + parts.output
  }
  return { buckets, span }
}

/** The unit and count that label one bucket width. */
export interface TimelineSpanLabel {
  /** Width unit; the caller owns the localized label. */
  unit: 'minute' | 'hour' | 'day'
  /** How many of the unit one bucket covers. */
  count: number
}

/**
 * Describe a bucket width in the largest unit that divides it evenly.
 * @param span - the bucket width in ms.
 * @returns the unit and count labelling the width.
 */
export function spanLabel(span: number): TimelineSpanLabel {
  if (span < 60 * 60_000) return { unit: 'minute', count: Math.round(span / 60_000) }
  if (span < 24 * 60 * 60_000) return { unit: 'hour', count: Math.round(span / (60 * 60_000)) }
  return { unit: 'day', count: Math.round(span / (24 * 60 * 60_000)) }
}
