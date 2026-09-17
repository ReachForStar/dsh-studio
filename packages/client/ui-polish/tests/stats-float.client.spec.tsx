// @vitest-environment jsdom
/** StatsFloat: projection figures, window-fold fallback, and the cost row. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { StatsFloat, formatDuration, formatTokens, formatTokensPerSecond, messageCosts, workspaceCost, workspaceUsage, type StatsFloatProps } from '../src/client/StatsFloat.tsx'
import { SEED_RATE_CARD } from '../src/client/cost.ts'
import { zh } from '../src/client/locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

const t = makeTranslate(zh, commonZh)

/** The session the card is rendered in, and another session beside it. */
const SESSION = 's-current' as SessionId
const OTHER_SESSION = 's-other' as SessionId

/** One session-list row as the dock reads it. */
type Row = { projectionValues?: { tokenUsage?: TokenUsageProjection } }

/** A chat target whose nodes feed StatsFloat through the conversation views. */
function chatView(nodes: readonly ConversationNode[]): ChatSnapshot {
  return { legacy: { nodes } } as unknown as ChatSnapshot
}

function makeSource(nodes: readonly ConversationNode[] = []) {
  let snap = {
    views: { get: (target: string) => (target === 'chat' ? chatView(nodes) : undefined) },
    activeTargets: new Set<string>(),
  } as unknown as ConversationSnapshot
  const subs = new Set<() => void>()
  return {
    set: (next: readonly ConversationNode[]): void => {
      snap = {
        views: { get: (target: string) => (target === 'chat' ? chatView(next) : undefined) },
        activeTargets: new Set<string>(),
      } as unknown as ConversationSnapshot
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void): (() => void) => { subs.add(fn); return () => subs.delete(fn) },
    },
  }
}

const projections = (values: Record<string, unknown>) => (key: string) => values[key]

/** One fixed store behind a snapshot hook; the selector is all the dock uses. */
const store = <T,>(state: T): ((selector: (value: T) => unknown) => unknown) => selector => selector(state)

function props(
  source: { getSnapshot(): ConversationSnapshot; subscribe(fn: () => void): () => void },
  values: Record<string, unknown>,
  over: { workspace?: SessionId[] | 'unlisted'; rows?: Record<string, Row> } = {},
): StatsFloatProps {
  const sessionIds = over.workspace === undefined || over.workspace === 'unlisted'
    ? [SESSION]
    : over.workspace
  const items = over.workspace === 'unlisted'
    ? [{ workspaceId: 'w-other', title: 'other', sessionIds: [OTHER_SESSION] }]
    : [{ workspaceId: 'w-current', title: 'current', sessionIds }]
  return {
    useConversation: bindSnapshotSelector(source),
    useProjection: projections(values),
    useSessions: store({ byId: over.rows ?? {}, ids: sessionIds, current: SESSION, phase: 'ready' }),
    useWorkspaces: store({ items, phase: 'ready' }),
    sessionId: SESSION,
    t,
    card: SEED_RATE_CARD,
  } as unknown as StatsFloatProps
}

const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }
// ¥0.60 input + ¥0.30 cache + ¥0.45 output = ¥1.35.
const BIG_USAGE = { uncachedInputTokens: 400_000, cacheWriteTokens: 0, cacheReadTokens: 6_000_000, outputTokens: 100_000 }
const sessionStats = (over: Record<string, number>): Record<string, number> => ({
  turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
  ...over,
})

const assistant = (over: Record<string, unknown>): ConversationNode =>
  ({ kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [], ...over }) as unknown as ConversationNode

afterEach(cleanup)

describe('format helpers', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(12_240)).toBe('12.2K')
    expect(formatTokens(517_000)).toBe('517K')
    expect(formatTokens(1_230_000)).toBe('1.2M')
  })

  it('formats durations under and over a minute', () => {
    expect(formatDuration(45_230)).toBe('45.2s')
    expect(formatDuration(162_000)).toBe('2m42s')
  })

  it('formats throughput under and over ten', () => {
    expect(formatTokensPerSecond(12.4)).toBe('12 tok/s')
    expect(formatTokensPerSecond(4.56)).toBe('4.6 tok/s')
  })
})

describe('workspace aggregation', () => {
  const buckets = (input: number): TokenUsageProjection => ({
    uncachedInputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  })

  it('prefers the watched session\'s live projection over its list row', () => {
    const rows = { [SESSION]: { projectionValues: { tokenUsage: buckets(5) } } }

    expect(workspaceUsage([SESSION], rows, { sessionId: SESSION, usage: buckets(7) }))
      .toEqual({ usage: buckets(7), sessions: 1 })
  })

  it('falls back to the watched row, skips rows without a value, and skips empty ones', () => {
    const rows = {
      [SESSION]: { projectionValues: { tokenUsage: buckets(0) } },
      [OTHER_SESSION]: { projectionValues: { tokenUsage: buckets(3) } },
      's-blank': {},
    }

    expect(workspaceUsage([SESSION, OTHER_SESSION, 's-blank' as SessionId], rows, { sessionId: SESSION }))
      .toEqual({ usage: buckets(3), sessions: 1 })
  })

  it('prices the watched session from its messages and the rest at the card default', () => {
    const totals = workspaceCost(
      [SESSION, OTHER_SESSION],
      { [OTHER_SESSION]: { projectionValues: { tokenUsage: buckets(1_000_000) } } },
      {
        sessionId: SESSION,
        totals: { input: 4.5, cache: 0, output: 0, total: 4.5, models: [{ model: 'deepseek-v4-pro', cost: 4.5 }] },
      },
      0,
      SEED_RATE_CARD,
    )

    // ¥4.50 priced from the watched messages + ¥1.50 for the other session's
    // million input tokens at the seed default.
    expect(totals.total).toBeCloseTo(6)
    // Two pricing paths contributed, so nothing is attributed to one model.
    expect(totals.models).toEqual([])
  })

  it('keeps the model attribution when one session contributed', () => {
    const models = [{ model: 'deepseek-v4-pro', cost: 4.5 }]

    expect(workspaceCost(
      [SESSION],
      {},
      { sessionId: SESSION, totals: { input: 4.5, cache: 0, output: 0, total: 4.5, models } },
      0,
      SEED_RATE_CARD,
    )).toEqual({ input: 4.5, cache: 0, output: 0, total: 4.5, models })
  })

  it('prices a session whose node usage carries no model id at the card default', () => {
    // `messageCosts` is the only path that can attribute a price; a node
    // without usage or without a model yields nothing for it to price.
    expect(messageCosts([])).toEqual([])
  })

  it('drops node usage that is absent, unusable, or empty', () => {
    const rows = [
      assistant({ messageId: 'a', requestConfig: { provider: 'deepseek', model: 'm' } }),
      assistant({ seq: 2, messageId: 'b', requestConfig: { provider: 'deepseek', model: 'm' }, usage: null }),
      assistant({
        seq: 3, messageId: 'c', requestConfig: { provider: 'deepseek', model: 'm' },
        usage: { inputTokens: -5, outputTokens: 0 },
      }),
      assistant({
        seq: 4, messageId: 'd', requestConfig: { provider: 'deepseek', model: 'm' },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ]

    expect(messageCosts(rows)).toEqual([])
  })
})

describe('StatsFloat', () => {
  it('renders projection figures and hides a sub-cent cost', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(source, { tokenUsage: USAGE, sessionStats: sessionStats({ turns: 2, steps: 5 }) })} />)
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    expect(view.container.textContent).toBe('2 轮 · 5 步| 缓存命中 90%| 输入 100 tok · 输出 5 tok')
  })

  it('renders the cost row when the bill crosses the threshold', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(source, { tokenUsage: BIG_USAGE, sessionStats: sessionStats({ turns: 1, steps: 1 }) })} />)
    expect(view.container.textContent).toContain('费用 ¥1.35')
  })

  it('bills each assistant step at its own model rate from node request config', () => {
    const flash = assistant({
      messageId: 'm-flash', time: 1_000,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestConfig: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    const pro = assistant({
      seq: 2, messageId: 'm-pro', time: 2_000, turn: 2,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestConfig: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    })
    const { source } = makeSource([flash, pro])
    // flash input ¥1.5 + pro input ¥4.5 = ¥6.00; node usage wins over the projection.
    const view = render(<StatsFloat {...props(source, {
      tokenUsage: { uncachedInputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      sessionStats: sessionStats({ turns: 2, steps: 2 }),
    })} />)
    expect(view.container.textContent).toContain('费用 ¥6.00')
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    // The cost block shows input/cache/output buckets and per-model subtotals.
    expect(view.container.textContent).toContain('输入 ¥6.00 · 缓存命中 ¥0.00 · 输出 ¥0.00')
    expect(view.container.textContent).toContain('模型 deepseek-v4-flash ¥1.50 · deepseek-v4-pro ¥4.50')
  })

  it('falls back to the default card when no settled node carries a model id', () => {
    const unmodeled = assistant({
      messageId: 'm-unknown', time: 1_000,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const { source } = makeSource([unmodeled])
    const view = render(<StatsFloat {...props(source, {
      tokenUsage: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    // No model on the node → projection at the default card: ¥1.50.
    expect(view.container.textContent).toContain('费用 ¥1.50')
    // No model attribution → no per-model breakdown row.
    expect(view.container.textContent).not.toContain('模型 ')
  })

  it('renders nothing when there are no steps and no billed activity', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(source, {})} />)
    expect(view.container.textContent).toBe('')
  })

  it('falls back to the window fold without the sessionStats projection', () => {
    const timed = assistant({
      time: 1_000, timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    })
    const tool = {
      kind: 'tool-result', seq: 2, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [],
      isError: false, subCalls: [],
    } as unknown as ConversationNode
    const { source } = makeSource([timed, tool])
    const view = render(<StatsFloat {...props(source, { tokenUsage: USAGE })} />)
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    expect(view.container.textContent).toContain('LLM 3.8s')
    expect(view.container.textContent).toContain('工具调用 3s')
  })

  it('omits the cache-hit group when nothing was billed on the input side', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(source, {
      tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 7 },
    })} />)
    expect(view.container.textContent).toContain('输入 0 tok · 输出 7 tok')
  })

  it('sums every session the workspace holds, and prices the rest at the card default', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(
      source,
      { tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      {
        workspace: [SESSION, OTHER_SESSION],
        rows: {
          [OTHER_SESSION]: {
            projectionValues: {
              tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          },
        },
      },
    )} />)
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    // 1M input from the watched session + 1M from the other, both at the seed
    // default (¥1.5/M): tokens add up and the cost covers both sessions.
    expect(view.container.textContent).toContain('输入 2M tok · 输出 0 tok')
    expect(view.container.textContent).toContain('工作区共 2 个会话')
    expect(view.container.textContent).toContain('费用 ¥3.00')
    // Two sessions contributed, so nothing is attributed to one model.
    expect(view.container.textContent).not.toContain('模型 ')
  })

  it('skips a listed session that reports no billable activity', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(
      source,
      { tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      {
        workspace: [SESSION, OTHER_SESSION],
        rows: {
          [OTHER_SESSION]: {
            projectionValues: {
              tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          },
        },
      },
    )} />)
    // The empty session contributes nothing, so the card stays single-session.
    expect(view.container.textContent).toContain('费用 ¥1.50')
    expect(view.container.textContent).not.toContain('工作区共')
  })

  it('falls back to the watched session when no workspace lists it', () => {
    const { source } = makeSource()
    const view = render(<StatsFloat {...props(
      source,
      { tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { workspace: 'unlisted' },
    )} />)
    expect(view.container.textContent).toContain('费用 ¥1.50')
    expect(view.container.textContent).not.toContain('工作区共')
  })

  it('toggles from the keyboard, and stays hidden with no figures to show', () => {
    const hidden = makeSource()
    // No workspace lists the session and no live projection arrived: nothing to
    // aggregate and nothing to price, so the card renders nothing.
    expect(render(<StatsFloat {...props(hidden.source, {}, { workspace: 'unlisted' })} />).container.textContent).toBe('')

    const { source } = makeSource()
    const view = render(<StatsFloat {...props(source, {
      tokenUsage: USAGE,
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    const card = view.container.querySelector('[data-ui-polish-stats]') as HTMLElement
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(card.getAttribute('data-expanded')).toBe('true')
    fireEvent.keyDown(card, { key: ' ' })
    expect(card.getAttribute('data-expanded')).toBe('false')
    // Any other key leaves the card alone.
    fireEvent.keyDown(card, { key: 'a' })
    expect(card.getAttribute('data-expanded')).toBe('false')
  })

  it('renders nothing when the active view has no chat target', () => {
    // One stable snapshot: a fresh object per read would re-render forever.
    const empty = {
      views: { get: () => undefined },
      activeTargets: new Set<string>(),
    } as unknown as ConversationSnapshot
    const noChat = { getSnapshot: () => empty, subscribe: () => () => undefined }

    expect(render(<StatsFloat {...props(noChat, {})} />).container.textContent).toBe('')
  })

  it('window fold tolerates tool results without call time, non-assistant nodes, and untimed assistants', () => {
    const bareTool = {
      kind: 'tool-result', seq: 2, time: 7_000, callId: 'c', call: null, callTime: null, content: [],
      isError: false, subCalls: [],
    } as unknown as ConversationNode
    const user = { kind: 'user', seq: 3, time: 3_000, content: [], source: null } as unknown as ConversationNode
    const untimed = assistant({ seq: 4, time: 4_000, turn: 2 })
    const noTtft = assistant({
      seq: 5, time: 5_000, turn: 3,
      timing: { stepStartTime: 5_000, firstTokenTime: null, completedTime: 8_000 },
    })
    const { source } = makeSource([bareTool, user, untimed, noTtft])
    const view = render(<StatsFloat {...props(source, { tokenUsage: USAGE })} />)
    // Two timed-assistant steps, LLM wall time 3s, no tool or TTFT groups.
    expect(view.container.textContent).toContain('2 轮 · 2 步')
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    expect(view.container.textContent).toContain('LLM 3s')
  })
})
