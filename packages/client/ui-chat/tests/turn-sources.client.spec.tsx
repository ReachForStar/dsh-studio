// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler, type ConversationNodeDefinition, type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNode, ChatSnapshot, TurnSourcesChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { turnSourcesDefinition } from '../src/client/conversation-nodes/turn-sources.ts'
import { TurnSourcesNodeView } from '../src/client/chat/TurnSourcesNodeView.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

function definitions(): readonly ConversationNodeDefinition[] {
  return [turnSourcesDefinition]
}

function views(): readonly ConversationViewDefinition[] {
  return [chatViewDefinition]
}

function at(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionLiveEventEntry {
  return {
    type: 'event',
    event: { seq, time: 1_700_000_000_000 + seq, type, data, ...extra } as unknown as SessionEvent,
  }
}

function assembler(entries: readonly SessionLiveEventEntry[] = []): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    { entries: definitions, fallbackEntry: () => undefined },
    { entries: views },
  )
  value.replaceWindow(entries, false)
  value.activateTarget('chat')
  return value
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

function sourceNodes(value: ChatSnapshot): readonly ChatNode<'turn-sources'>[] {
  return value.nodes.values().filter((node): node is ChatNode<'turn-sources'> => node.kind === 'turn-sources')
}

function turnStart(turn: number, seq: number): SessionLiveEventEntry {
  return at(seq, 'turn/start', { turn })
}

function call(seq: number, turn: number, callId: string, name: string): SessionLiveEventEntry {
  return at(seq, 'tool/call', { turn, step: 1, callId, name, arguments: '{}' })
}

function result(seq: number, turn: number, callId: string, meta: unknown, isError = false): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    turn,
    step: 1,
    message: {
      id: `result-${callId}`,
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text: 'ok' }],
      isError,
    },
    ...meta === undefined ? {} : { meta },
  }, { surfaceOp: 'append' })
}

function searchMeta(sources: readonly { url: string; title?: string; snippet?: string }[]): unknown {
  return { sources, truncated: false }
}

function end(seq: number, turn: number): SessionLiveEventEntry {
  return at(seq, 'turn/end', { turn, reason: { kind: 'completed' } })
}

describe('turn-sources Definition', () => {
  it('folds every web result of one Turn into one row, deduplicated by URL', () => {
    const value = assembler([
      turnStart(1, 1),
      call(2, 1, 'search-1', 'web_search'),
      result(3, 1, 'search-1', searchMeta([
        { url: 'https://a.test/one', title: 'First' },
        { url: 'https://b.test/two', title: 'Second' },
      ])),
      call(4, 1, 'search-2', 'web_search'),
      result(5, 1, 'search-2', searchMeta([
        { url: 'https://a.test/one', title: 'First again' },
        { url: 'https://c.test/three', title: 'Third' },
      ])),
      call(6, 1, 'fetch-1', 'web_fetch'),
      result(7, 1, 'fetch-1', { url: 'https://d.test/four', statusCode: 200, truncated: false }),
      end(8, 1),
    ])
    const nodes = sourceNodes(snapshot(value))
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.data).toEqual({
      turn: 1,
      sources: [
        { url: 'https://a.test/one', title: 'First' },
        { url: 'https://b.test/two', title: 'Second' },
        { url: 'https://c.test/three', title: 'Third' },
        { url: 'https://d.test/four' },
      ],
    } satisfies TurnSourcesChatData)
  })

  it('keeps Turns separate and never shares a URL across them', () => {
    const value = assembler([
      turnStart(1, 1),
      call(2, 1, 'search-1', 'web_search'),
      result(3, 1, 'search-1', searchMeta([{ url: 'https://a.test/one', title: 'First' }])),
      end(4, 1),
      turnStart(2, 5),
      call(6, 2, 'search-2', 'web_search'),
      result(7, 2, 'search-2', searchMeta([{ url: 'https://a.test/one', title: 'Again' }, { url: 'https://b.test/two' }])),
      end(8, 2),
    ])
    const nodes = sourceNodes(snapshot(value))
    expect(nodes.map(node => node.data.turn)).toEqual([1, 2])
    expect(nodes[0]?.data.sources).toEqual([{ url: 'https://a.test/one', title: 'First' }])
    expect(nodes[1]?.data.sources).toEqual([
      { url: 'https://a.test/one', title: 'Again' },
      { url: 'https://b.test/two' },
    ])
  })

  it('renders no row for a Turn without web results', () => {
    const value = assembler([
      turnStart(1, 1),
      call(2, 1, 'read-1', 'read'),
      result(3, 1, 'read-1', { path: '/tmp/a.ts' }),
      end(4, 1),
    ])
    expect(sourceNodes(snapshot(value))).toEqual([])
  })

  it('renders no row for an empty search result', () => {
    const value = assembler([
      turnStart(1, 1),
      call(2, 1, 'search-1', 'web_search'),
      result(3, 1, 'search-1', searchMeta([])),
      end(4, 1),
    ])
    expect(sourceNodes(snapshot(value))).toEqual([])
  })

  it('ignores failed results, unrecorded calls, and malformed metadata without throwing', () => {
    const value = assembler([
      turnStart(1, 1),
      // A result whose tool call is outside the loaded window names no tool.
      result(3, 1, 'orphan', searchMeta([{ url: 'https://orphan.test/' }])),
      call(4, 1, 'search-1', 'web_search'),
      result(5, 1, 'search-1', searchMeta([{ url: 'https://a.test/one' }]), true),
      call(6, 1, 'search-2', 'web_search'),
      result(7, 1, 'search-2', { sources: [null, { url: 42 }, { title: 'no url' }], truncated: false }),
      call(8, 1, 'search-3', 'web_search'),
      result(9, 1, 'search-3', undefined),
      call(10, 1, 'fetch-1', 'web_fetch'),
      result(11, 1, 'fetch-1', { statusCode: 200, truncated: false }),
      end(12, 1),
    ])
    expect(sourceNodes(snapshot(value))).toEqual([])
  })

  it('sits after its newest source while the Turn runs and lands on the Turn end when it closes', () => {
    const value = assembler([
      turnStart(1, 1),
      call(2, 1, 'search-1', 'web_search'),
      result(3, 1, 'search-1', searchMeta([{ url: 'https://a.test/one', title: 'First' }])),
    ])
    expect(sourceNodes(snapshot(value))[0]?.anchorSeq).toBe(3)

    // Later work that adds no source must not drag the row through the process.
    value.append(call(4, 1, 'read-1', 'read'))
    value.append(result(5, 1, 'read-1', { path: '/tmp/a.ts' }))
    value.flush()
    expect(sourceNodes(snapshot(value))[0]?.anchorSeq).toBe(3)

    value.append(end(6, 1))
    value.flush()
    const node = sourceNodes(snapshot(value))[0]
    expect(node?.anchorSeq).toBe(6)
    expect(node?.data.sources).toEqual([{ url: 'https://a.test/one', title: 'First' }])
  })
})

function chatNodeOf(data: TurnSourcesChatData): ChatNode<'turn-sources'> {
  return {
    key: 'turn-sources:1',
    kind: 'turn-sources',
    id: String(data.turn),
    target: 'chat',
    anchorSeq: 1,
    location: { kind: 'session' },
    visibility: 'visible',
    data,
  }
}

function renderSources(data: TurnSourcesChatData, openExternalLink = vi.fn(() => {})) {
  const view = render(
    <TurnSourcesNodeView
      {...{
        node: chatNodeOf(data), t, openExternalLink, useDisclosure,
        openFile: vi.fn(),
      } as unknown as ChatNodeViewProps<'turn-sources'>}
    />,
  )
  return { view, openExternalLink }
}

afterEach(cleanup)

describe('TurnSourcesNodeView', () => {
  it('stays collapsed until the reader opens it, then lists titles and counts them', () => {
    const { view } = renderSources({
      turn: 1,
      sources: [
        { url: 'https://a.test/one', title: 'First source' },
        { url: 'https://b.test/two', title: 'Second source' },
      ],
    })
    const header = view.getByRole('button')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('来源')
    expect(header.textContent).toContain('2 条来源')
    expect(view.queryByText('First source')).toBeNull()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('First source')).toBeTruthy()
    expect(view.getByText('Second source')).toBeTruthy()
    expect(view.getAllByRole('link')).toHaveLength(2)
  })

  it('delegates each source click to the view external-link handler', () => {
    const { view, openExternalLink } = renderSources({
      turn: 1,
      sources: [{ url: 'https://a.test/one', title: 'First source' }],
    })
    fireEvent.click(view.getByRole('button'))
    fireEvent.click(view.getByText('First source'))
    expect(openExternalLink).toHaveBeenCalledWith('https://a.test/one')
  })

  it('labels a title-less source by its hostname and keeps a non-http URL inert', () => {
    const { view, openExternalLink } = renderSources({
      turn: 1,
      sources: [
        { url: 'https://docs.test/guide' },
        { url: 'javascript:alert(1)', title: 'Unsafe' },
      ],
    })
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText('docs.test')).toBeTruthy()
    fireEvent.click(view.getByText('Unsafe'))
    expect(openExternalLink).not.toHaveBeenCalled()
    expect(view.getAllByRole('link')).toHaveLength(1)
  })
})
