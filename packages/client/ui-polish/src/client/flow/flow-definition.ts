/**
 * Flow event Definition: folds the Session events the star-domain view draws
 * into activity Nodes on the `flow` target. One Definition owns every activity
 * family because the view renders them uniformly; per-family Definitions would
 * each need their own Node kind for no rendering benefit.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the xingchen SessionEventMap members (`xingchen/dispatch-progress`)
// into this program, which is what widens `SessionEvent`'s type union here.
import type {} from '@reachforstar/dsh-xingchen/client'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, ConversationStartMatch,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  flowViewDefinition,
  seatOfCommand, stateOfTask, tail, textOf, toolKind, toolLabel,
  type FlowActivity, type FlowKind, type FlowState,
} from './flow-graph.ts'

/** One activity's fold state; the Node payload is derived from it on publication. */
interface FlowDefinitionState {
  /** Node identity, stable across the activity's events. */
  readonly id: string
  /** Log sequence of the newest folded event. */
  seq: number
  kind: FlowKind
  label: string
  state: FlowState
  text: string
}

/** Event types that start an activity; every other matched event updates one. */
const ACTIVITY_START_TYPES: ReadonlySet<string> = new Set([
  'user/message', 'command/run', 'tool/call', 'assistant/message',
])

/** Node identity for one event, or null when the flow view ignores that event. */
function identityOf(event: { readonly type: string; readonly seq: number; readonly data: unknown }): string | null {
  const data = event.data as Record<string, unknown>
  switch (event.type) {
    case 'user/message':
      return (data['source'] as { kind?: unknown } | undefined)?.kind === 'user'
        ? `human-${String(event.seq)}`
        : null
    case 'command/run':
    case 'command/done':
      return `command-${String(data['commandId'])}`
    case 'xingchen/dispatch-progress': {
      const commandId = data['commandId']
      const callId = data['callId']
      if (commandId !== undefined) return `command-${String(commandId)}`
      return callId === undefined ? null : `call-${String(callId)}`
    }
    case 'tool/call':
      return `call-${String(data['callId'])}`
    case 'tool/result': {
      const message = data['message'] as { source?: { callId?: unknown } } | undefined
      const callId = message?.source?.callId
      return callId === undefined ? null : `call-${String(callId)}`
    }
    case 'assistant/message':
      return `agent-${String(data['turn'])}-${String(data['step'])}`
    default:
      return null
  }
}

/** Identity and lifecycle role for one event; null when the flow view ignores it. */
function matchFlowEvent(event: { readonly type: string; readonly seq: number; readonly data: unknown }): { id: string; role: 'start' | 'update' } | null {
  const id = identityOf(event)
  if (id === null) return null
  return { id, role: ACTIVITY_START_TYPES.has(event.type) ? 'start' : 'update' }
}

/** State for a matched start event. */
function startState(match: ConversationStartMatch): FlowDefinitionState {
  const data = match.event.data as Record<string, unknown>
  const base = { id: identityOf(match.event) ?? `activity-${String(match.event.seq)}`, seq: match.event.seq }
  switch (match.event.type) {
    case 'user/message':
      return {
        ...base,
        kind: 'human',
        label: '人',
        state: 'ok',
        text: textOf((data['content'] ?? []) as readonly { type?: string; text?: string }[]),
      }
    case 'command/run': {
      const name = typeof data['name'] === 'string' ? data['name'] : ''
      const seat = seatOfCommand(name)
      return {
        ...base,
        kind: seat === undefined ? 'command' : 'seat',
        label: seat ?? `/${name === '' ? '命令' : name}`,
        state: 'running',
        text: '',
      }
    }
    case 'tool/call': {
      const name = typeof data['name'] === 'string' ? data['name'] : ''
      const argsRaw = typeof data['arguments'] === 'string' ? data['arguments'] : ''
      return { ...base, kind: toolKind(name), label: toolLabel(name, argsRaw), state: 'running', text: '' }
    }
    case 'assistant/message': {
      const message = data['message'] as { content?: readonly { type?: string; text?: string }[] } | undefined
      return { ...base, kind: 'agent', label: '启明', state: 'ok', text: textOf(message?.content ?? []) }
    }
    default:
      return { ...base, kind: 'notice', label: match.event.type, state: 'ok', text: '' }
  }
}

/** State after one update event. */
function updatedState(state: FlowDefinitionState, match: ConversationMatch): FlowDefinitionState {
  const data = match.event.data as Record<string, unknown>
  const seq = match.event.seq
  switch (match.event.type) {
    case 'command/done':
      return {
        ...state,
        seq,
        state: data['kind'] === 'error' ? 'error' : 'ok',
        text: typeof data['text'] === 'string' ? tail(data['text']) : state.text,
      }
    case 'xingchen/dispatch-progress': {
      const text = typeof data['text'] === 'string' ? tail(data['text']) : ''
      return {
        ...state,
        seq,
        state: stateOfTask(typeof data['state'] === 'string' ? data['state'] : undefined),
        text: text === '' ? state.text : text,
      }
    }
    case 'tool/result': {
      const message = data['message'] as { content?: readonly { isError?: unknown }[] } | undefined
      const failed = message?.content?.[0]?.isError === true
      return { ...state, seq, state: failed ? 'error' : 'ok' }
    }
    default:
      return { ...state, seq }
  }
}

/** Publish one activity Node for the flow target. */
function buildNode(context: ConversationNodeContext<FlowDefinitionState>): ConversationViewNode | null {
  const state = context.state
  if (state === undefined) return null
  const activity: FlowActivity = {
    id: state.id,
    seq: state.seq,
    kind: state.kind,
    label: state.label,
    state: state.state,
    text: state.text,
  }
  return { key: context.key, kind: 'flow-activity', id: context.id, target: 'flow', data: activity }
}

/** The single Definition owning every star-domain flow activity. */
export const flowActivityDefinition: ConversationNodeDefinition<FlowDefinitionState> = {
  kind: 'flow-activity',
  target: 'flow',
  match: matchFlowEvent,
  start: (_context, match) => startState(match),
  update: (context, match) => updatedState(context.state, match),
  buildViewNode: buildNode,
}

/**
 * Register the flow activity Definition.
 * @param ctx - owning UI Conversation context.
 */
export function registerFlowConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(flowActivityDefinition)
}

/**
 * Register the flow view target.
 * @param ctx - owning UI Conversation context.
 */
export function registerFlowConversationView(ctx: Context): void {
  ctx.uiConversation.views.register(flowViewDefinition)
}
