/**
 * Star-domain conversation flow: the graph the 3D view draws. Pure data — no
 * three.js, no React — so the mapping stays unit-testable apart from the
 * renderer. Activities are produced by `flow-definition.ts` from Session
 * events; this module turns them into the node and edge sets the view renders.
 */

import type {
  ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Node class, deciding colour and geometry in the 3D view. */
export type FlowKind =
  | 'human' | 'agent' | 'seat' | 'command' | 'tool' | 'mcp' | 'skill' | 'subagent' | 'notice'

/** Run state of one flow node. */
export type FlowState = 'idle' | 'running' | 'ok' | 'error'

/** One activity folded from Session events, before the graph is assembled. */
export interface FlowActivity {
  /** Stable node identity, shared with the Conversation Context id. */
  readonly id: string
  /** Log sequence of the newest event folded into this activity. */
  readonly seq: number
  readonly kind: FlowKind
  readonly label: string
  readonly state: FlowState
  readonly text: string
}

/** One graph node. */
export interface FlowNode {
  readonly id: string
  readonly kind: FlowKind
  readonly label: string
  readonly state: FlowState
  readonly text: string
}

/** One directed edge; `state` drives the light band's colour. */
export interface FlowEdge {
  readonly from: string
  readonly to: string
  readonly state: FlowState
}

/** Complete graph for one conversation. */
export interface FlowGraph {
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
}

/** The centre node every activity hangs off. */
export const FLOW_HUB_ID = 'hub'

/** Centre node label: the human-facing router. */
export const FLOW_HUB_LABEL = '启明'

/** Empty graph used before a Session has any activity. */
export const EMPTY_FLOW_GRAPH: FlowGraph = { nodes: [], edges: [] }

/** Longest tail kept per node so the graph stays readable and cheap to diff. */
export const TEXT_LIMIT = 160

/**
 * Star-domain command → seat name. Mirrors the router's own table
 * (`packages/xingchen/xingchen/src/route.ts`); the client cannot import the
 * host package, and the pairing is part of the command contract.
 */
const SEAT_OF_COMMAND: Readonly<Record<string, string>> = {
  review: '天权',
  bug: '瑶光',
  planning: '天梁',
}

/** @param name - slash-command name. @returns the seat it dispatches to, when it is a star-domain command. */
export function seatOfCommand(name: string): string | undefined {
  return SEAT_OF_COMMAND[name]
}

/** Keep the newest tail of one text so node payloads stay bounded. */
export function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TEXT_LIMIT ? `…${trimmed.slice(-TEXT_LIMIT)}` : trimmed
}

/** Concatenate one message's text blocks, keeping only the newest tail. */
export function textOf(blocks: readonly { readonly type?: string; readonly text?: string }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return tail(parts.join(''))
}

/** Classify a tool call by its name; MCP servers encode the server in the name. */
export function toolKind(name: string): FlowKind {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name === 'skill') return 'skill'
  if (name === 'subagent' || name === 'subagent_pi') return 'subagent'
  return 'tool'
}

/** Short label for a tool call: MCP splits into server·tool, skill shows its name. */
export function toolLabel(name: string, argsRaw: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__')
    return `${server ?? ''}·${tool ?? ''}`
  }
  if (name === 'skill') {
    try {
      const parsed: unknown = JSON.parse(argsRaw)
      if (typeof parsed === 'object' && parsed !== null) {
        const skill = (parsed as { name?: unknown }).name
        if (typeof skill === 'string') return skill
      }
    } catch {
      // Malformed arguments keep the tool name; the card shows the raw text.
    }
  }
  return name
}

/** Map an A2A task state onto the flow's run state. */
export function stateOfTask(state: string | undefined): FlowState {
  if (state === undefined) return 'running'
  if (state.endsWith('COMPLETED')) return 'ok'
  if (state.endsWith('FAILED') || state.endsWith('CANCELED') || state.endsWith('REJECTED')) return 'error'
  return 'running'
}

/**
 * Assemble the rendered graph from one conversation's activities.
 * @param activities - activities in log order; `agent` activities fold into the hub.
 * @returns hub-first node set with one edge per activity.
 */
export function buildFlowGraph(activities: readonly FlowActivity[]): FlowGraph {
  let hub: FlowNode = { id: FLOW_HUB_ID, kind: 'agent', label: FLOW_HUB_LABEL, state: 'idle', text: '' }
  const byId = new Map<string, FlowNode>()
  for (const activity of activities) {
    if (activity.kind === 'agent') {
      hub = { ...hub, state: 'ok', text: activity.text === '' ? hub.text : activity.text }
      continue
    }
    byId.set(activity.id, {
      id: activity.id,
      kind: activity.kind,
      label: activity.label,
      state: activity.state,
      text: activity.text,
    })
  }
  const nodes = [...byId.values()]
  return {
    nodes: [hub, ...nodes],
    edges: nodes.map(node => ({ from: FLOW_HUB_ID, to: node.id, state: node.state })),
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Star-domain flow graph assembled for the 3D view. */
    flow: FlowGraph
  }
}

/** Target builder: the graph is re-assembled from the activity Nodes' payloads. */
class FlowSnapshotBuilder implements ConversationViewBuilder<ConversationViewNode, FlowGraph> {
  readonly empty: FlowGraph = EMPTY_FLOW_GRAPH
  /** Every activity seen so far: `apply` carries only changed Nodes. */
  private activities: readonly FlowActivity[] = []

  /**
   * @param input - complete activity Node set for this target.
   * @returns the graph those activities describe.
   */
  replace(input: { nodes: readonly ConversationViewNode[]; timeline: unknown }): FlowGraph {
    this.activities = activitiesOf(input.nodes)
    return buildFlowGraph(this.activities)
  }

  /**
   * @param input - changed activity Nodes, merged into the retained set.
   * @returns the graph the merged activity set describes.
   */
  apply(input: { upserts: readonly ConversationViewNode[]; timeline: unknown }): FlowGraph {
    const byId = new Map(this.activities.map(activity => [activity.id, activity]))
    for (const activity of activitiesOf(input.upserts)) byId.set(activity.id, activity)
    this.activities = [...byId.values()]
    return buildFlowGraph(this.activities)
  }
}

/** Read the flow activities carried by this target's Nodes. */
function activitiesOf(nodes: readonly ConversationViewNode[]): readonly FlowActivity[] {
  return nodes.map(node => node.data as FlowActivity)
}

/** Flow target registration. The hub alone is not activity: a session shows as
 * active once at least one thing happened in it, which is what makes
 * command-only sessions visible instead of falling back to the hero. */
export const flowViewDefinition: ConversationViewDefinition<ConversationViewNode, FlowGraph> = {
  target: 'flow',
  create: () => new FlowSnapshotBuilder(),
  isActive: graph => graph.nodes.length > 1,
}
