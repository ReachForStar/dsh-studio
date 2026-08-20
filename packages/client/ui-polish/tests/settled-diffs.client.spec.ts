/** Settled file-mutation detection and diff narrowing. */
import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { narrowDiffs, settledDiffCalls } from '../src/client/settled-diffs.ts'

function diffResult(callId: string, name = 'write'): ToolResultNode {
  return {
    kind: 'tool-result', seq: 1, time: 1_000, callId,
    call: { name, argsRaw: '{}' }, callTime: 500,
    content: [], isError: false, callView: null,
    resultView: { card: 'diff', title: 'Write', diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] },
    subCalls: [],
  }
}

function snapshotOf(nodes: readonly unknown[]): ConversationSnapshot {
  return {
    chat: {
      nodes: {
        values: () => nodes.map((root, index) => ({
          key: `t:${index}`, id: String(index), target: 'chat', kind: 'tool-call',
          anchorSeq: index, location: { kind: 'session' }, visibility: 'visible',
          data: { root },
        })),
      },
    },
  } as unknown as ConversationSnapshot
}

/** A store whose values are returned verbatim (for genuinely non-tool nodes). */
function snapshotOfNodes(nodes: readonly unknown[]): ConversationSnapshot {
  return {
    chat: {
      nodes: { values: () => nodes },
    },
  } as unknown as ConversationSnapshot
}

describe('narrowDiffs', () => {
  it('validates well-formed hunks and rejects malformed payloads', () => {
    expect(narrowDiffs([{ path: 'a', oldText: null, newText: 'b' }]))
      .toEqual([{ path: 'a', oldText: null, newText: 'b' }])
    expect(narrowDiffs([])).toBeNull()
    expect(narrowDiffs('nope')).toBeNull()
    expect(narrowDiffs([null])).toBeNull()
    expect(narrowDiffs([{ path: 1, oldText: null, newText: 'b' }])).toBeNull()
    expect(narrowDiffs([{ path: 'a', oldText: 1, newText: 'b' }])).toBeNull()
    expect(narrowDiffs([{ path: 'a', oldText: null, newText: 2 }])).toBeNull()
  })
})

describe('settledDiffCalls', () => {
  it('collects settled diff calls with validated hunks in store order', () => {
    const calls = settledDiffCalls(snapshotOf([diffResult('a', 'write'), diffResult('b', 'edit')]))
    expect(calls).toEqual([
      { callId: 'a', name: 'write', diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] },
      { callId: 'b', name: 'edit', diffs: [{ path: 'a.txt', oldText: null, newText: 'x' }] },
    ])
  })

  it('excludes running calls and settled calls without the diff render intent', () => {
    const running = { callId: 'r', name: 'write', argsRaw: '{}', turn: 1, step: 1, time: 1, callView: null, subCalls: [] }
    const generic = { ...diffResult('g'), resultView: { card: 'generic', title: 'Write', content: [] } }
    const malformed = { ...diffResult('m'), resultView: { card: 'diff', title: 'Write', diffs: 'nope' } }
    expect(settledDiffCalls(snapshotOf([running, generic, malformed]))).toEqual([])
  })

  it('ignores non-tool nodes', () => {
    const user = { kind: 'user', key: 'u', id: '2', target: 'chat', anchorSeq: 2, location: { kind: 'session' }, visibility: 'visible', data: {} }
    const calls = settledDiffCalls(snapshotOfNodes([user, {
      key: 't', id: '3', target: 'chat', kind: 'tool-call', anchorSeq: 3, location: { kind: 'session' },
      visibility: 'visible', data: { root: diffResult('a') },
    }]))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.callId).toBe('a')
  })

  it('falls back to the callId for the tool name when the head left the window', () => {
    const headless = { ...diffResult('w'), call: null }
    const calls = settledDiffCalls(snapshotOf([headless]))
    expect(calls[0]!.name).toBe('w')
  })
})
