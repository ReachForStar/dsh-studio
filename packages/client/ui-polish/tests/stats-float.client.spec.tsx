// @vitest-environment jsdom
/** StatsFloat: projection figures, window-fold fallback, and the cost row. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  createSnapshotStore, type AssistantMessageNode, type ConversationSnapshot,
  type SessionId, type SessionListState, type ToolResultNode, type UserMessageNode,
  type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { StatsFloat, formatDuration, formatTokens, formatTokensPerSecond, type StatsFloatProps } from '../src/client/StatsFloat.tsx'
import { SEED_RATE_CARD } from '../src/client/cost.ts'
import { zh } from '../src/client/locales.ts'

const SID = 's1' as SessionId
const t = makeTranslate(zh, commonZh)

function makeSource(nodes: readonly unknown[] = []) {
  let snap = { sessionId: SID, chat: { legacy: { nodes } } } as unknown as ConversationSnapshot
  const subs = new Set<() => void>()
  return {
    set: (next: readonly unknown[]): void => {
      snap = { sessionId: SID, chat: { legacy: { nodes: next } } } as unknown as ConversationSnapshot
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void): (() => void) => { subs.add(fn); return () => subs.delete(fn) },
    },
  }
}

function projections(values: Record<string, unknown>): StatsFloatProps['useProjection'] {
  return (key: string) => values[key]
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function props(
  source: { getSnapshot(): ConversationSnapshot; subscribe(fn: () => void): () => void },
  values: Record<string, unknown>,
  modelOf: (messageId: string) => string | undefined = () => undefined,
): StatsFloatProps {
  return {
    useSession: bindSnapshotSelector(source),
    sessionId: SID,
    useProjection: projections(values),
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    t,
    session: {} as ConversationSnapshot,
    input: {} as never,
    modelOf,
    card: SEED_RATE_CARD,
  }
}

const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }
// ¥0.60 input + ¥0.30 cache + ¥0.45 output = ¥1.35.
const BIG_USAGE = { uncachedInputTokens: 400_000, cacheWriteTokens: 0, cacheReadTokens: 6_000_000, outputTokens: 100_000 }
const sessionStats = (over: Record<string, number>): Record<string, number> => ({
  turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
  ...over,
})

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

  it('bills each assistant step at its own model rate from node provenance', () => {
    const flash: AssistantMessageNode = {
      kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'a' }],
      messageId: 'm-flash' as never,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
    const pro: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 2, step: 1, blocks: [{ kind: 'text', text: 'b' }],
      messageId: 'm-pro' as never,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
    const modelOf = (messageId: string): string | undefined =>
      messageId === 'm-flash' ? 'deepseek-v4-flash' : messageId === 'm-pro' ? 'deepseek-v4-pro' : undefined
    const { source } = makeSource([flash, pro])
    // flash input ¥1.5 + pro input ¥4.5 = ¥6.00; node usage wins over the projection.
    const view = render(<StatsFloat {...props(source, {
      tokenUsage: { uncachedInputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      sessionStats: sessionStats({ turns: 2, steps: 2 }),
    }, modelOf)} />)
    expect(view.container.textContent).toContain('费用 ¥6.00')
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    // The cost block shows input/cache/output buckets and per-model subtotals.
    expect(view.container.textContent).toContain('输入 ¥6.00 · 缓存命中 ¥0.00 · 输出 ¥0.00')
    expect(view.container.textContent).toContain('模型 deepseek-v4-flash ¥1.50 · deepseek-v4-pro ¥4.50')
  })

  it('falls back to the default card when no settled node carries model usage', () => {
    const unmodeled: AssistantMessageNode = {
      kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'a' }],
      messageId: 'm-unknown' as never,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
    const { source } = makeSource([unmodeled])
    const view = render(<StatsFloat {...props(source, {
      tokenUsage: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      sessionStats: sessionStats({ turns: 1, steps: 1 }),
    })} />)
    // No model in the index → projection at the default card: ¥1.50.
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
    const timed: AssistantMessageNode = {
      kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'x' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
    }
    const tool: ToolResultNode = {
      kind: 'tool-result', seq: 2, time: 7_000, callId: 'c', call: null, callTime: 4_000, content: [],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
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

  it('window fold tolerates tool results without call time, non-assistant nodes, and untimed assistants', () => {
    const bareTool: ToolResultNode = {
      kind: 'tool-result', seq: 2, time: 7_000, callId: 'c', call: null, callTime: null, content: [],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const user: UserMessageNode = {
      kind: 'user', seq: 3, time: 3_000, content: [{ type: 'text', text: 'hi' }] as never, source: null,
    }
    const untimed: AssistantMessageNode = {
      kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 1, blocks: [{ kind: 'text', text: 'y' }],
    }
    const noTtft: AssistantMessageNode = {
      kind: 'assistant', seq: 5, time: 5_000, turn: 3, step: 1, blocks: [{ kind: 'text', text: 'z' }],
      timing: { stepStartTime: 5_000, firstTokenTime: null, completedTime: 8_000 },
    }
    const { source } = makeSource([bareTool, user, untimed, noTtft])
    const view = render(<StatsFloat {...props(source, { tokenUsage: USAGE })} />)
    // Two timed-assistant steps, LLM wall time 3s, no tool or TTFT groups.
    expect(view.container.textContent).toContain('2 轮 · 2 步')
    fireEvent.click(view.container.querySelector('[data-ui-polish-stats]') as HTMLElement)
    expect(view.container.textContent).toContain('LLM 3s')
  })
})
