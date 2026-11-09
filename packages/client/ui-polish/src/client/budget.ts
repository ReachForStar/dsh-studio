// Monthly spend against the user's budget. The estimate covers the current
// calendar month: the session on screen contributes its settled messages that
// landed this month (or its live projection when no settled message is held),
// and every other session contributes its whole reported projection when the
// list row was updated this month. The wire projection carries no per-message
// timestamps, so a row updated this month is counted as this month's usage.

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { estimateCost, type RateCardData } from './cost.ts'
import type { UsageRow, WatchedUsage } from './session-usage.ts'

/** Spend against the monthly budget. */
export interface BudgetStatus {
  /** Estimated spend this calendar month, in yuan. */
  spent: number
  /** The configured budget, or null when none is set. */
  budget: number | null
  /** Spent divided by the budget, or null when no positive budget is set. */
  ratio: number | null
  /** Whether spend exceeded the budget. */
  over: boolean
}

/** One cost-attributable message: usage, model, and settle time. */
export interface MonthlyMessage {
  usage: TokenUsageProjection
  model: string
  at: number
}

/**
 * Local start of the calendar month containing `now`.
 * @param now - the instant to place in its month, Unix epoch ms.
 * @returns the month's first local instant, Unix epoch ms.
 */
export function monthStart(now: number): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

/** Sum the priced cost of the given messages. */
function priceMessages(messages: readonly MonthlyMessage[], card: RateCardData): number {
  let total = 0
  for (const message of messages) {
    total += estimateCost(message.usage, message.model, message.at, card)
  }
  return total
}

/**
 * Estimate the calendar month's spend over one workspace.
 * @param sessionIds - the workspace's session ids.
 * @param rows - the session list's rows.
 * @param watched - the session on screen.
 * @param messages - the watched session's cost-attributable settled messages.
 * @param now - the instant placing the calendar month.
 * @param card - the rate card pricing the sessions.
 * @returns the estimated spend this month, in yuan.
 */
export function monthlySpend(
  sessionIds: readonly SessionId[],
  rows: Readonly<Record<string, UsageRow | undefined>>,
  watched: WatchedUsage,
  messages: readonly MonthlyMessage[],
  now: number,
  card: RateCardData,
): number {
  const start = monthStart(now)
  let spent = 0
  for (const id of sessionIds) {
    if (watched.sessionId === id) {
      if (messages.length > 0) {
        spent += priceMessages(messages.filter(message => message.at >= start), card)
        continue
      }
      const usage = watched.usage ?? rows[id]?.projectionValues?.tokenUsage
      if (usage !== undefined) spent += estimateCost(usage, 'default', now, card)
      continue
    }
    const row = rows[id]
    if (row === undefined || (row.updatedAt ?? 0) < start) continue
    const usage = row.projectionValues?.tokenUsage
    if (usage !== undefined) spent += estimateCost(usage, 'default', now, card)
  }
  return spent
}

/**
 * Compare a month's spend against the configured budget.
 * @param spent - the month's estimated spend, in yuan.
 * @param budget - the configured budget, or null when none is set.
 * @returns the spend, the budget, the used share, and whether it is exceeded.
 */
export function budgetStatus(spent: number, budget: number | null): BudgetStatus {
  // A zero budget carries no ratio, so it cannot report an overspend either.
  if (budget === null || budget <= 0) return { spent, budget, ratio: null, over: false }
  return { spent, budget, ratio: spent / budget, over: spent > budget }
}
