// Session stats float: a composer.dock contribution that positions itself
// with `position: fixed` at the viewport's bottom-right, so it never overlaps
// the conversation header or input. Durable figures ride the sessionStats and
// tokenUsage projections (the window fold below is only the fallback for
// assemblies without the sessionStats unit). Collapsed by default to a compact
// cost capsule; clicking expands the full readout.

import { Fragment, memo, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the chat target into ConversationViewSnapshotMap and the
// session hooks (useSession/useProjection/useSessions/useWorkspaces) into dock
// slot props.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import {
  accumulateCost,
  billedInputTokens,
  costBreakdown,
  formatCost,
  type CostTotals,
  type RateCardData,
} from './cost.ts'
import css from './StatsFloat.module.css'

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Compact throughput: 152 / 12.4 tok/s (one decimal under ten). */
export function formatTokensPerSecond(rate: number): string {
  return `${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10} tok/s`
}

/** Cache-hit share of prompt-side input over the whole durable log. */
function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100)
}

/** One assistant node's provider-reported usage, field names per dsh-llm TokenUsage. */
interface NodeUsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Normalize one assistant node's usage into the projection bucket shape. */
function projectionFromNodeUsage(usage: unknown): TokenUsageProjection | null {
  if (typeof usage !== 'object' || usage === null) return null
  const raw = usage as NodeUsageLike
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const uncached = num(raw.inputTokens)
  const output = num(raw.outputTokens)
  const cacheRead = num(raw.cacheReadTokens)
  const cacheWrite = num(raw.cacheWriteTokens)
  if (uncached + output + cacheRead + cacheWrite === 0) return null
  return { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

/** One assistant node's model id, from the node's recorded request config. */
function modelOfNode(node: Extract<ConversationNode, { kind: 'assistant' }>): string | undefined {
  return node.requestConfig?.model
}

/** One cost-attributable assistant message: usage, model, and settled time. */
export interface MessageCostInput {
  usage: TokenUsageProjection
  model: string
  /** Unix epoch ms when the message settled (drives time-tiered pricing). */
  at: number
}

/**
 * Cost-attributable messages over the settled assistant nodes in the window.
 * Each finalized message carries its own provider usage, model, and settle
 * time, so a session that switched models or crossed a peak/off-peak boundary
 * bills each step at its own rate. Nodes without a model or without usage are
 * skipped; the caller falls back to the durable projection when nothing is
 * attributable.
 * @param nodes - the conversation's settled nodes.
 * @returns per-message cost inputs; empty when no node carries both.
 */
export function messageCosts(nodes: readonly ConversationNode[]): MessageCostInput[] {
  const messages: MessageCostInput[] = []
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const model = modelOfNode(node)
    if (model === undefined) continue
    const usage = projectionFromNodeUsage(node.usage)
    if (usage === null) continue
    messages.push({ usage, model, at: node.time })
  }
  return messages
}

/** The token buckets one session reports through the list row's projections. */
type ListedUsage = { readonly tokenUsage?: TokenUsageProjection }

/** Session list rows addressed by id, as the list store keeps them. */
export type WorkspaceSessionRows = Readonly<Record<string, { readonly projectionValues?: ListedUsage } | undefined>>

/** The empty bucket total a workspace sum starts from. */
const ZERO_USAGE: TokenUsageProjection = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** Whether one usage value reports any billable activity at all. */
function billed(usage: TokenUsageProjection): boolean {
  return billedInputTokens(usage) > 0 || usage.outputTokens > 0
}

/**
 * One bucket total priced at the card's default rate, as a full totals row.
 * The estimate carries no model attribution, so it renders no breakdown row.
 * @param usage - the buckets to price.
 * @param at - the instant the estimate is billed at.
 * @param card - the rate card pricing the estimate.
 * @returns summed buckets, total, and an empty model list.
 */
function estimatedTotals(usage: TokenUsageProjection, at: number, card: RateCardData): CostTotals {
  const parts = costBreakdown(usage, 'default', at, card)
  return { ...parts, total: parts.input + parts.cache + parts.output, models: [] }
}

/** What the caller knows about the one session it is watching. */
export interface WatchedSession {
  readonly sessionId: SessionId
  /** Live token projection of that session, newer than the row the list carries. */
  readonly usage?: TokenUsageProjection
  /** Message-priced totals of that session, when its settled nodes are held. */
  readonly totals?: CostTotals
}

/**
 * Sum the tokens every session in one workspace reports.
 *
 * A watched session supplies its live projection, which is newer than the row
 * the list last carried; every other session contributes the value its row
 * holds. Sessions whose projection reports no billable activity are skipped
 * rather than counted as empty contributors.
 * @param sessionIds - the workspace's session ids.
 * @param rows - the session list's rows.
 * @param watched - the session on screen.
 * @returns the summed buckets and the number of sessions that contributed.
 */
export function workspaceUsage(
  sessionIds: readonly SessionId[],
  rows: WorkspaceSessionRows,
  watched: WatchedSession,
): { usage: TokenUsageProjection; sessions: number } {
  let usage = ZERO_USAGE
  let sessions = 0
  for (const id of sessionIds) {
    const reported = watched.sessionId === id
      ? watched.usage ?? rows[id]?.projectionValues?.tokenUsage
      : rows[id]?.projectionValues?.tokenUsage
    if (reported === undefined || !billed(reported)) continue
    usage = {
      uncachedInputTokens: usage.uncachedInputTokens + reported.uncachedInputTokens,
      outputTokens: usage.outputTokens + reported.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + reported.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens + reported.cacheWriteTokens,
    }
    sessions += 1
  }
  return { usage, sessions }
}

/**
 * Price every session in one workspace.
 *
 * A session whose settled messages this client holds is priced message by
 * message — each at its own model's rate and its own settle time — while every
 * other session is priced from the buckets its projection reports at the
 * card's default rate: the wire projection carries totals per bucket, with no
 * model attribution to price it more exactly. Per-model subtotals survive only
 * when a single session contributed, because a total that mixes both pricing
 * paths attributes nothing.
 * @param sessionIds - the workspace's session ids.
 * @param rows - the session list's rows.
 * @param watched - the session on screen.
 * @param at - the instant an estimate is billed at.
 * @param card - the rate card pricing the workspace.
 * @returns summed buckets, total, and per-model subtotals when one session contributed.
 */
export function workspaceCost(
  sessionIds: readonly SessionId[],
  rows: WorkspaceSessionRows,
  watched: WatchedSession,
  at: number,
  card: RateCardData,
): CostTotals {
  let input = 0
  let cache = 0
  let output = 0
  let contributors = 0
  let models: CostTotals['models'] = []
  for (const id of sessionIds) {
    if (watched.sessionId === id && watched.totals !== undefined) {
      input += watched.totals.input
      cache += watched.totals.cache
      output += watched.totals.output
      models = watched.totals.models
      contributors += 1
      continue
    }
    const reported = watched.sessionId === id
      ? watched.usage ?? rows[id]?.projectionValues?.tokenUsage
      : rows[id]?.projectionValues?.tokenUsage
    if (reported === undefined || !billed(reported)) continue
    const parts = costBreakdown(reported, 'default', at, card)
    input += parts.input
    cache += parts.cache
    output += parts.output
    contributors += 1
  }
  return {
    input,
    cache,
    output,
    total: input + cache + output,
    models: contributors === 1 ? models : [],
  }
}
/** Window-scoped fallback totals (only when the sessionStats projection is absent). */
interface WindowStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
}

function windowStats(nodes: readonly ConversationNode[]): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
      if (node.timing.firstTokenTime !== null) {
        ttftMs += Math.max(0, node.timing.firstTokenTime - node.timing.stepStartTime)
        ttftSteps += 1
      }
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps }
}

/** Full component props: dock standard hooks + the ui-polish locale seat + the rate card. */
export type StatsFloatProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'ui-polish'> & {
  /** The rate card pricing the float (the user card, or the built-in seed). */
  card: RateCardData
}

export const StatsFloat = memo(function StatsFloat({
  useConversation, useProjection, useSessions, useWorkspaces, sessionId, t, card,
}: StatsFloatProps) {
  const [expanded, setExpanded] = useState(false)
  const settledNodes = useConversation(s => s.views.get('chat')?.legacy.nodes ?? [])
  const usage = useProjection('tokenUsage')
  const projected = useProjection('sessionStats')
  const stats = useMemo(
    () => projected ?? windowStats(settledNodes),
    [projected, settledNodes],
  )
  // Scope: the card answers for the whole workspace, not for whichever
  // sessions happen to be loaded. Every session the workspace holds reports
  // its tokens through the list row the host projects; the session on screen
  // reports its live projection instead, which is newer than its row.
  const rows = useSessions(s => s.byId)
  const workspaceSessionIds = useWorkspaces(s =>
    s.items.find(workspace => workspace.sessionIds.includes(sessionId))?.sessionIds)
  // Cost prices the session on screen message by message (each at its own
  // model's rate and settle time) and the rest from the totals they report.
  const messages = useMemo(() => messageCosts(settledNodes), [settledNodes])
  const watched: WatchedSession = {
    sessionId,
    ...usage === undefined ? {} : { usage },
    ...messages.length === 0 ? {} : { totals: accumulateCost(messages, card) },
  }
  const reported = workspaceSessionIds === undefined
    ? (watched.usage === undefined ? undefined : { usage: watched.usage, sessions: 1 })
    : workspaceUsage(workspaceSessionIds, rows, watched)
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) {
      speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  if (reported !== undefined && (billedInputTokens(reported.usage) > 0 || reported.usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(reported.usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    groups.push(t('stats.tokens', {
      input: formatTokens(billedInputTokens(reported.usage)),
      output: formatTokens(reported.usage.outputTokens),
    }))
    if (reported.sessions > 1) groups.push(t('stats.workspace', { sessions: reported.sessions }))
  }
  // Cost covers the same workspace. The row stays hidden at a sub-cent bill,
  // so a fresh or failed workspace gains no noise.
  const totals = workspaceSessionIds === undefined
    ? watched.totals ?? (watched.usage === undefined
      ? undefined
      : estimatedTotals(watched.usage, Date.now(), card))
    : workspaceCost(workspaceSessionIds, rows, watched, Date.now(), card)
  let costDisplay: { totals: CostTotals; label: string } | null = null
  if (totals !== undefined) {
    const label = formatCost(totals.total)
    if (label !== '¥0.00') {
      costDisplay = { totals, label }
    }
  }
  if (groups.length === 0 && costDisplay === null) return null
  return (
    <div
      className={css.root}
      data-ui-polish-stats=""
      data-expanded={expanded}
      role="button"
      tabIndex={0}
      title={expanded ? undefined : t('stats.expand')}
      onClick={() => { setExpanded(value => !value) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setExpanded(value => !value)
        }
      }}
    >
      {/* Collapsed: a single line with the total cost (the figure users glance at). */}
      {!expanded && costDisplay !== null && (
        <span className={css.costInline}>{t('stats.cost', { cost: costDisplay.label })}</span>
      )}
      {!expanded && costDisplay === null && groups.length > 0 && (
        <span className={css.costInline}>{groups[0]}</span>
      )}
      {expanded && (
        <>
          {groups.length > 0 && (
            <div className={css.line}>
              {groups.map((group, i) => (
                <Fragment key={group}>
                  {i > 0 && <><span className={css.sep} aria-hidden>|</span>{' '}</>}
                  <span>{group}</span>
                </Fragment>
              ))}
            </div>
          )}
          {costDisplay !== null && (
            <div className={css.cost}>
              <span className={css.costTotal}>{t('stats.cost', { cost: costDisplay.label })}</span>
              <span className={css.costBuckets}>
                {t('stats.costDetail', {
                  input: formatCost(costDisplay.totals.input),
                  cache: formatCost(costDisplay.totals.cache),
                  output: formatCost(costDisplay.totals.output),
                })}
              </span>
              {costDisplay.totals.models.length > 0 && (
                <span className={css.costModels}>
                  {t('stats.costModels', {
                    models: costDisplay.totals.models
                      .map(entry => `${entry.model} ${formatCost(entry.cost)}`)
                      .join(' · '),
                  })}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
})
