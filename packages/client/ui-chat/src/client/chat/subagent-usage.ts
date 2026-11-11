/**
 * Subagent token accounting for the composer usage pill. A subagent runs in
 * its own Session, so the parent's `tokenUsage` projection excludes it; the
 * conversation's cost is the parent plus every descendant the session list
 * already carries.
 * @module
 */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Summed subagent usage under one Session. */
export interface SubagentUsage {
  /** Descendants with billable usage; descendants without usage stay uncounted. */
  readonly sessions: number
  /** Summed prompt and output buckets of those descendants. */
  readonly usage: TokenUsageProjection
}

const ZERO: TokenUsageProjection = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function billable(usage: TokenUsageProjection): boolean {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens > 0
}

function add(left: TokenUsageProjection, right: TokenUsageProjection): TokenUsageProjection {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

/**
 * Direct-child edges from both sources the list carries: a loaded parent
 * catalog knows children even before their rows arrive, while listed rows keep
 * nested descendants whose catalogs were never read. External children have no
 * local Session and contribute no usage.
 * @param list - the client session list snapshot.
 * @returns child ids grouped by their direct parent.
 */
function childEdges(list: SessionListState): Map<SessionId, SessionId[]> {
  const edges = new Map<SessionId, SessionId[]>()
  const link = (parentId: SessionId, childId: SessionId): void => {
    const current = edges.get(parentId)
    if (current === undefined) edges.set(parentId, [childId])
    else if (!current.includes(childId)) current.push(childId)
  }
  for (const [parentId, snapshot] of Object.entries(list.projectionsBySession)) {
    for (const entry of snapshot.values.subagentCatalog ?? []) {
      if (entry.mode === 'external') continue
      link(parentId as SessionId, entry.id)
    }
  }
  for (const row of Object.values(list.byId)) {
    if (row.origin === 'subagent' && row.parentId !== undefined) link(row.parentId, row.id)
  }
  return edges
}

/**
 * Total one Session's subagent descendants across every depth.
 *
 * Rows are read from the list's projection block, which the Host serves for
 * unopened Sessions too. Cycles and repeated rows are visited once, so a
 * malformed catalog cannot double-count a child.
 * @param list - the client session list snapshot.
 * @param rootId - the Session on screen.
 * @returns the contributing descendant count and their summed buckets.
 */
export function subagentUsage(list: SessionListState, rootId: SessionId): SubagentUsage {
  const edges = childEdges(list)
  const visited = new Set<SessionId>([rootId])
  let sessions = 0
  let usage = ZERO
  const queue = [...edges.get(rootId) ?? []]
  for (let childId = queue.shift(); childId !== undefined; childId = queue.shift()) {
    if (visited.has(childId)) continue
    visited.add(childId)
    queue.push(...edges.get(childId) ?? [])
    const reported = list.byId[childId]?.projectionValues?.tokenUsage
    if (reported === undefined || !billable(reported)) continue
    sessions += 1
    usage = add(usage, reported)
  }
  return { sessions, usage }
}
