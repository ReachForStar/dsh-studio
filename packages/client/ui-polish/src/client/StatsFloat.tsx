// Session stats float: a composer.dock contribution that positions itself
// with `position: fixed` at the viewport's bottom-right, so it never overlaps
// the conversation header or input. Durable figures ride the sessionStats and
// tokenUsage projections (the window fold below is only the fallback for
// assemblies without the sessionStats unit). Collapsed by default to a compact
// cost capsule; clicking expands the full readout.

import { Fragment, memo, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { accumulateCost, billedInputTokens, estimateCost, formatCost, type RateCardData } from './cost.ts'
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

/** One assistant node's model id, via the plugin's messageId → model index. */
function modelOfNode(
  node: ConversationSnapshot['chat']['legacy']['nodes'][number],
  modelOf: (messageId: string) => string | undefined,
): string | undefined {
  if (node.kind !== 'assistant') return undefined
  if (node.messageId === undefined) return undefined
  return modelOf(String(node.messageId))
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
 * @param nodes - the conversation snapshot's legacy nodes.
 * @param modelOf - the plugin's messageId → model index lookup.
 * @returns per-message cost inputs; empty when no node carries both.
 */
export function messageCosts(
  nodes: readonly ConversationSnapshot['chat']['legacy']['nodes'][number][],
  modelOf: (messageId: string) => string | undefined,
): MessageCostInput[] {
  const messages: MessageCostInput[] = []
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const model = modelOfNode(node, modelOf)
    if (model === undefined) continue
    const usage = projectionFromNodeUsage(node.usage)
    if (usage === null) continue
    messages.push({ usage, model, at: node.time })
  }
  return messages
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

function windowStats(nodes: ConversationSnapshot['chat']['legacy']['nodes']): WindowStats {
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

/** Full component props: session runtime share + the ui-polish locale seat + injected model index. */
export type StatsFloatProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'ui-polish'> & {
  /** Resolve one settled assistant message's model id (plugin-owned index). */
  modelOf: (messageId: string) => string | undefined
  /** The rate card pricing the float (the user card, or the built-in seed). */
  card: RateCardData
}

export const StatsFloat = memo(function StatsFloat({ useSession, useProjection, t, modelOf, card }: StatsFloatProps) {
  const [expanded, setExpanded] = useState(false)
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  const projected = useProjection('sessionStats')
  const stats = useMemo(
    () => projected ?? windowStats(settledNodes),
    [projected, settledNodes],
  )
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
  if (usage !== undefined && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    groups.push(t('stats.tokens', {
      input: formatTokens(billedInputTokens(usage)),
      output: formatTokens(usage.outputTokens),
    }))
  }
  // Cost rides the same billed-activity gate; a sub-cent bill reads as ¥0.00
  // and the row hides, so a fresh or failed session gains no noise. Each
  // settled assistant message is priced at its own model's rate and its own
  // settle time (time-tiered models switch price at peak/off-peak boundaries),
  // accumulated into total + input/output/cache buckets; when no settled node
  // carries attributable usage, fall back to the durable projection at the
  // default card so an estimate still shows.
  const messages = useMemo(() => messageCosts(settledNodes, modelOf), [settledNodes, modelOf])
  const bill = usage !== undefined && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
    ? usage
    : undefined
  const totals = messages.length > 0 ? accumulateCost(messages, card) : null
  let costDisplay: {
    totals: ReturnType<typeof accumulateCost> | null
    label: string
  } | null = null
  if (totals !== null || bill !== undefined) {
    const label = totals !== null
      ? formatCost(totals.total)
      : formatCost(estimateCost(bill as TokenUsageProjection, 'default', Date.now(), card))
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
              {costDisplay.totals !== null && (
                <>
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
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
})
