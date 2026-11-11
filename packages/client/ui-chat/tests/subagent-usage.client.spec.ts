/** Subagent usage rolls child Sessions into the parent's token total. */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { subagentUsage } from '../src/client/chat/subagent-usage.ts'

const ROOT = 's-root' as SessionId
const CHILD = 's-child' as SessionId
const GRANDCHILD = 's-grandchild' as SessionId
const EXTERNAL = 's-external' as SessionId

const usage = (input: number, output: number, cacheRead = 0): TokenUsageProjection => ({
  uncachedInputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
})

const row = (
  sessionId: SessionId,
  usage?: TokenUsageProjection,
  parentSessionId?: SessionId,
  origin?: 'subagent',
): SessionSummary => ({
  id: sessionId,
  displayTitle: sessionId,
  updatedAt: 0,
  running: false,
  blank: false,
  retainedBy: {},
  ...parentSessionId === undefined ? {} : { parentId: parentSessionId },
  ...origin === undefined ? {} : { origin },
  ...usage === undefined ? {} : { projectionValues: { tokenUsage: usage } },
})

function list(
  rows: readonly SessionSummary[],
  catalog: Record<string, NonNullable<SessionListState['projectionsBySession'][SessionId]['values']['subagentCatalog']>> = {},
): SessionListState {
  return {
    ids: rows.map(entry => entry.id),
    byId: Object.fromEntries(rows.map(entry => [entry.id, entry])),
    phase: 'ready',
    projectionsBySession: Object.fromEntries(Object.entries(catalog).map(([parentId, entries]) => [
      parentId,
      { values: { subagentCatalog: entries }, state: 'ready', error: null },
    ])),
  }
}

describe('subagentUsage', () => {
  it('sums direct and nested descendants from the catalog and listed rows', () => {
    const state = list(
      [
        row(ROOT),
        row(CHILD, usage(1_000, 2_000, 3_000), ROOT, 'subagent'),
        row(GRANDCHILD, usage(100, 200), CHILD, 'subagent'),
      ],
      {
        [ROOT]: [{ id: CHILD, createdAt: 1, mode: 'continuable', label: 'Worker' }],
        [CHILD]: [{ id: GRANDCHILD, createdAt: 2, mode: 'one-shot' }],
      },
    )

    expect(subagentUsage(state, ROOT)).toEqual({
      sessions: 2,
      usage: usage(1_100, 2_200, 3_000),
    })
  })

  it('skips external children, rows without usage, and ordinary parent links', () => {
    const state = list(
      [
        row(ROOT),
        row(CHILD, usage(10, 20), ROOT, 'subagent'),
        row(GRANDCHILD, undefined, CHILD, 'subagent'),
        row('s-empty' as SessionId, usage(0, 0), ROOT, 'subagent'),
        row('s-fork' as SessionId, usage(999, 999), ROOT),
      ],
      {
        [ROOT]: [
          { id: CHILD, createdAt: 1, mode: 'continuable', label: 'Worker' },
          { id: EXTERNAL, createdAt: 2, mode: 'external' },
        ],
      },
    )

    expect(subagentUsage(state, ROOT)).toEqual({ sessions: 1, usage: usage(10, 20) })
  })

  it('reports nothing when the session has no descendants', () => {
    expect(subagentUsage(list([row(ROOT)]), ROOT)).toEqual({
      sessions: 0,
      usage: usage(0, 0),
    })
  })

  it('visits a repeated or cyclic catalog entry once', () => {
    const state = list(
      [row(ROOT), row(CHILD, usage(4, 6), ROOT, 'subagent')],
      {
        [ROOT]: [{ id: CHILD, createdAt: 1, mode: 'continuable', label: 'Worker' }],
        [CHILD]: [
          { id: ROOT, createdAt: 2, mode: 'continuable', label: 'Loop' },
          { id: CHILD, createdAt: 3, mode: 'continuable', label: 'Self' },
        ],
      },
    )

    expect(subagentUsage(state, ROOT)).toEqual({ sessions: 1, usage: usage(4, 6) })
  })
})
