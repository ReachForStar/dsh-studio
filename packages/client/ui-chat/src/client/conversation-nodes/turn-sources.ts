import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNode, TurnSourceEntry, TurnSourcesChatData } from '../contract/chat-nodes.ts'
import { chatNode, contextLocation } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Turn-level web sources collected from search and fetch results. */
    'turn-sources': TurnSourcesChatData
  }
}

/** Root tool name whose settled result cites several browsable URLs. */
const WEB_SEARCH = 'web_search'
/** Root tool name whose settled result cites the one fetched URL. */
const WEB_FETCH = 'web_fetch'

interface TurnSourcesState {
  readonly turn: number
  /** Sequence of the result that added the newest source; 0 before any. */
  readonly sourceSeq: number
  /** Closing `turn/end` sequence, once recorded. */
  readonly endSeq?: number
  /** Recorded names of this Turn's web calls, so each result names its own tool. */
  readonly webCalls: ReadonlyMap<string, string>
  readonly seen: ReadonlySet<string>
  readonly sources: readonly TurnSourceEntry[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Source entries recorded by one `web_search` presentation meta. */
function searchEntries(meta: unknown): readonly TurnSourceEntry[] {
  if (!isRecord(meta) || !Array.isArray(meta.sources)) return []
  const entries: TurnSourceEntry[] = []
  for (const value of meta.sources) {
    if (!isRecord(value) || typeof value.url !== 'string' || value.url.trim() === '') continue
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    entries.push({ url: value.url, ...title === '' ? {} : { title } })
  }
  return entries
}

/** The URL recorded by one `web_fetch` presentation meta; a fetch carries no title. */
function fetchEntries(meta: unknown): readonly TurnSourceEntry[] {
  if (!isRecord(meta) || typeof meta.url !== 'string' || meta.url.trim() === '') return []
  return [{ url: meta.url }]
}

function resultEntries(name: string, meta: unknown): readonly TurnSourceEntry[] {
  switch (name) {
    case WEB_SEARCH: return searchEntries(meta)
    case WEB_FETCH: return fetchEntries(meta)
    default: return []
  }
}

function isWebTool(name: string): boolean {
  return name === WEB_SEARCH || name === WEB_FETCH
}

/** Turn number from one durable event, or undefined for a Session-scoped event. */
function eventTurn(event: SessionEvent): number | undefined {
  switch (event.type) {
    case 'turn/start':
    case 'turn/end':
    case 'tool/call':
    case 'tool/result':
      return event.data.turn
    default:
      return undefined
  }
}

function emptyState(event: SessionEvent): TurnSourcesState | undefined {
  const turn = eventTurn(event)
  return turn === undefined ? undefined : {
    turn,
    sourceSeq: 0,
    webCalls: new Map(),
    seen: new Set(),
    sources: [],
  }
}

/** Fold one accepted event into the Turn's sources, keeping State identity when nothing changed. */
function applyEvent(state: TurnSourcesState, event: SessionEvent): TurnSourcesState {
  switch (event.type) {
    case 'turn/end':
      return state.endSeq === undefined ? { ...state, endSeq: event.seq } : state
    case 'tool/call': {
      if (!isWebTool(event.data.name)) return state
      const webCalls = new Map(state.webCalls)
      webCalls.set(String(event.data.callId), event.data.name)
      return { ...state, webCalls }
    }
    case 'tool/result': {
      if (event.data.message.isError === true) return state
      const name = state.webCalls.get(String(event.data.message.source.callId))
      if (name === undefined) return state
      const added = resultEntries(name, event.data.meta).filter(entry => !state.seen.has(entry.url))
      if (added.length === 0) return state
      const seen = new Set(state.seen)
      for (const entry of added) seen.add(entry.url)
      return { ...state, sourceSeq: event.seq, seen, sources: [...state.sources, ...added] }
    }
    default:
      return state
  }
}

/**
 * Fold a Context whose initial event is outside the loaded window. The
 * Turn-scoped Context id still scopes these matches to one Turn, so no
 * neighbouring Turn can contribute.
 */
function fallbackState(context: ConversationNodeContext<TurnSourcesState>): TurnSourcesState | undefined {
  let state: TurnSourcesState | undefined
  for (const match of context.matches) {
    if (match.event.type === 'assistant/live-chunk') continue
    state = state === undefined ? emptyState(match.event) : applyEvent(state, match.event)
    if (state === undefined) return undefined
  }
  return state
}

/**
 * Append one disclosure row to a Turn when its web search or fetch results
 * cite sources. The row reads only this Context's own events and is replayable
 * from them; it stands at the Turn level, outside the process disclosure, so
 * folding the work keeps the sources visible.
 */
export const turnSourcesDefinition: ConversationNodeDefinition<TurnSourcesState> = {
  kind: 'turn-sources',
  target: 'chat',
  match: (event) => {
    if (event.type === 'assistant/live-chunk') return null
    const turn = eventTurn(event)
    if (turn === undefined) return null
    if (event.type === 'tool/result' && !isAppendSurfaceEvent(event)) return null
    // Every durable Turn event is a start candidate: the earliest loaded one
    // opens the Context, later ones fold as updates, so a window that starts
    // mid-Turn still shows the sources of its loaded results.
    return { id: String(turn), role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type === 'assistant/live-chunk') throw new Error('turn-sources start requires a durable event')
    const state = emptyState(match.event)
    if (state === undefined) throw new Error('turn-sources start requires a turn-scoped event')
    return applyEvent(state, match.event)
  },
  update: (context, match) => match.event.type === 'assistant/live-chunk'
    ? context.state
    : applyEvent(context.state, match.event),
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined || state.sources.length === 0) return null
    const location = contextLocation(context)
    if (location.kind !== 'turn' && location.kind !== 'step') return null
    const anchorSeq = state.endSeq ?? state.sourceSeq
    const current = context.current.get('chat') as ChatNode<'turn-sources'> | null | undefined
    const data: TurnSourcesChatData = current != null
      && current.data.turn === state.turn
      && current.data.sources === state.sources
      ? current.data
      : { turn: state.turn, sources: state.sources }
    if (current != null && current.data === data && current.anchorSeq === anchorSeq
      && current.location === location) return current
    return chatNode(context, 'turn-sources', anchorSeq, data, { groupTree: 'turn' })
  },
}

/**
 * Register the Turn sources row contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnSourcesConversationNode(ctx: Context): void {
  const match = turnSourcesDefinition.match.bind(turnSourcesDefinition)
  ctx.uiConversation.events.register({
    ...turnSourcesDefinition,
    match: {
      'turn/start': match,
      'turn/end': match,
      'tool/call': match,
      'tool/result': match,
    },
  })
}
