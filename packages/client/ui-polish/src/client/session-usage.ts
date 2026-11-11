// Per-session usage breakdown for the stats float: every session the
// workspace holds reports its tokens through its list row, while the session
// on screen may have a newer live projection and message-priced totals. One
// row per contributing session keeps the card's total attributable.

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { billedInputTokens, estimateCost, type CostTotals, type RateCardData } from './cost.ts'

/** One session-list row as the workspace aggregation reads it. */
export interface UsageRow {
  /** Human-facing label; the session id stands in when the host has none. */
  displayTitle?: string
  /** Last durable update, Unix epoch ms (drives monthly attribution). */
  updatedAt?: number
  /** Direct creator, present on a listed subagent row. */
  parentId?: SessionId
  /** Coarse durable origin; only `subagent` rows join their parent's scope. */
  origin?: 'subagent'
  projectionValues?: { readonly tokenUsage?: TokenUsageProjection }
}

/** One session's projection snapshot, as the list store holds it. */
export interface UsageCatalog {
  readonly values: {
    readonly subagentCatalog?: readonly { readonly id: SessionId; readonly mode: string }[]
  }
}

/**
 * Add every subagent Session beneath the given roots.
 *
 * Workspace membership only lists Sessions attached at creation; a subagent
 * keeps its own Session and may never enter that list. The list still carries
 * both sources of the parent edge: a loaded parent catalog, and the listed
 * child rows' `parentId`. Roots keep their order, descendants follow in
 * discovery order, and repeated ids (a child already in the workspace, a
 * malformed cycle) appear once.
 * @param sessionIds - workspace members, or the single current Session.
 * @param rows - the session list's rows.
 * @param catalogs - per-session projection snapshots.
 * @returns the roots plus every reachable subagent Session.
 */
export function withSubagentSessions(
  sessionIds: readonly SessionId[],
  rows: Readonly<Record<string, UsageRow | undefined>>,
  catalogs: Readonly<Record<string, UsageCatalog | undefined>>,
): SessionId[] {
  const children = new Map<SessionId, SessionId[]>()
  const link = (parentId: SessionId, childId: SessionId): void => {
    const current = children.get(parentId)
    if (current === undefined) children.set(parentId, [childId])
    else if (!current.includes(childId)) current.push(childId)
  }
  for (const [parentId, catalog] of Object.entries(catalogs)) {
    if (catalog === undefined) continue
    for (const entry of catalog.values.subagentCatalog ?? []) {
      if (entry.mode === 'external') continue
      link(parentId as SessionId, entry.id)
    }
  }
  for (const [childId, row] of Object.entries(rows)) {
    if (row?.origin === 'subagent' && row.parentId !== undefined) link(row.parentId, childId as SessionId)
  }
  const visited = new Set<SessionId>()
  const scope: SessionId[] = []
  const queue = [...sessionIds]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (visited.has(id)) continue
    visited.add(id)
    scope.push(id)
    queue.push(...children.get(id) ?? [])
  }
  return scope
}


/** What the caller knows about the session it is watching. */
export interface WatchedUsage {
  readonly sessionId: SessionId
  /** Live token projection of that session, newer than the row the list carries. */
  readonly usage?: TokenUsageProjection
  /** Message-priced totals of that session, when its settled nodes are held. */
  readonly totals?: CostTotals
}

/** One session's token total and estimated cost. */
export interface SessionUsage {
  sessionId: SessionId
  /** Display title, or the session id when the host projects none. */
  title: string
  /** Billed input plus output tokens. */
  tokens: number
  /** Estimated cost in yuan. */
  cost: number
  /** Whether this is the session on screen. */
  current: boolean
}

/** Whether one usage value reports any billable activity at all. */
function billable(usage: TokenUsageProjection): boolean {
  return billedInputTokens(usage) > 0 || usage.outputTokens > 0
}

/** The session's live projection when watched, else the value its row carries. */
function usageFor(
  id: SessionId,
  rows: Readonly<Record<string, UsageRow | undefined>>,
  watched: WatchedUsage,
): TokenUsageProjection | undefined {
  const listed = rows[id]?.projectionValues?.tokenUsage
  return watched.sessionId === id ? watched.usage ?? listed : listed
}

/**
 * List every contributing session with its token total and cost.
 *
 * The watched session is priced message by message when its settled nodes are
 * held; every other session is priced from the buckets its row reports at the
 * card's default rate, because the wire projection carries no model
 * attribution. Sessions without billable activity are skipped rather than
 * listed as empty rows. Rows are ordered by tokens, then by id for a stable
 * order between equal totals.
 * @param sessionIds - the workspace's session ids.
 * @param rows - the session list's rows.
 * @param watched - the session on screen.
 * @param at - the instant an estimate is billed at.
 * @param card - the rate card pricing the sessions.
 * @returns one row per contributing session.
 */
export function sessionUsageRows(
  sessionIds: readonly SessionId[],
  rows: Readonly<Record<string, UsageRow | undefined>>,
  watched: WatchedUsage,
  at: number,
  card: RateCardData,
): SessionUsage[] {
  const result: SessionUsage[] = []
  for (const id of sessionIds) {
    const usage = usageFor(id, rows, watched)
    if (usage === undefined || !billable(usage)) continue
    const current = watched.sessionId === id
    result.push({
      sessionId: id,
      title: rows[id]?.displayTitle ?? id,
      tokens: billedInputTokens(usage) + usage.outputTokens,
      cost: current && watched.totals !== undefined
        ? watched.totals.total
        : estimateCost(usage, 'default', at, card),
      current,
    })
  }
  return result.sort((left, right) => right.tokens - left.tokens || left.sessionId.localeCompare(right.sessionId))
}
