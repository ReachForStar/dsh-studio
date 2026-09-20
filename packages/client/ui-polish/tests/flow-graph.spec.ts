import { describe, expect, it } from 'vitest'
import {
  buildFlowGraph, FLOW_HUB_ID, flowViewDefinition, seatOfCommand, stateOfTask, toolKind, toolLabel,
  type FlowActivity,
} from '../src/client/flow/flow-graph.ts'

function activity(over: Partial<FlowActivity> & { id: string }): FlowActivity {
  return { seq: 1, kind: 'tool', label: 'read', state: 'ok', text: '', ...over }
}

describe('buildFlowGraph', () => {
  it('leads with an idle hub and no edges when the session has no activity', () => {
    const graph = buildFlowGraph([])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ id: FLOW_HUB_ID, kind: 'agent', state: 'idle' })
    expect(graph.edges).toEqual([])
  })

  it('folds agent activity into the hub instead of drawing it as a ring node', () => {
    const graph = buildFlowGraph([
      activity({ id: 'agent-1-1', kind: 'agent', label: '启明', text: '在想了' }),
      activity({ id: 'human-3', kind: 'human', label: '人', text: '帮我看看' }),
    ])
    expect(graph.nodes.map(node => node.id)).toEqual([FLOW_HUB_ID, 'human-3'])
    expect(graph.nodes[0]).toMatchObject({ state: 'ok', text: '在想了' })
    expect(graph.edges).toEqual([{ from: FLOW_HUB_ID, to: 'human-3', state: 'ok' }])
  })

  it('keeps the newest tail of the hub text and one edge per activity', () => {
    const graph = buildFlowGraph([
      activity({ id: 'agent-1-1', kind: 'agent', text: '旧' }),
      activity({ id: 'call-a', label: 'read' }),
      activity({ id: 'call-b', label: 'bash', state: 'error' }),
    ])
    expect(graph.nodes[0]?.text).toBe('旧')
    expect(graph.edges).toEqual([
      { from: FLOW_HUB_ID, to: 'call-a', state: 'ok' },
      { from: FLOW_HUB_ID, to: 'call-b', state: 'error' },
    ])
  })

  it('reports the session as active once anything happened, and idle when only the hub is drawn', () => {
    expect(flowViewDefinition.isActive?.(buildFlowGraph([]))).toBe(false)
    expect(flowViewDefinition.isActive?.(buildFlowGraph([
      activity({ id: 'command-cmd-1', kind: 'seat', label: '天梁', state: 'ok' }),
    ]))).toBe(true)
  })
})

describe('flow classification', () => {
  it('separates MCP servers, skills, and subagents from plain tools', () => {
    expect(toolKind('mcp__playwright-mcp__browser_navigate')).toBe('mcp')
    expect(toolKind('skill')).toBe('skill')
    expect(toolKind('subagent')).toBe('subagent')
    expect(toolKind('read')).toBe('tool')
  })

  it('labels MCP calls as server·tool and skills by their requested name', () => {
    expect(toolLabel('mcp__codegraph__codegraph_search', '{}')).toBe('codegraph·codegraph_search')
    expect(toolLabel('skill', '{"name": "gh-ops"}')).toBe('gh-ops')
    expect(toolLabel('skill', 'not json')).toBe('skill')
    expect(toolLabel('read', '{}')).toBe('read')
  })

  it('maps star-domain commands onto their seats', () => {
    expect(seatOfCommand('review')).toBe('天权')
    expect(seatOfCommand('bug')).toBe('瑶光')
    expect(seatOfCommand('planning')).toBe('天梁')
    expect(seatOfCommand('clear')).toBeUndefined()
  })

  it('reads an A2A task state as running until a terminal state lands', () => {
    expect(stateOfTask(undefined)).toBe('running')
    expect(stateOfTask('TASK_STATE_SUBMITTED')).toBe('running')
    expect(stateOfTask('TASK_STATE_WORKING')).toBe('running')
    expect(stateOfTask('TASK_STATE_COMPLETED')).toBe('ok')
    expect(stateOfTask('TASK_STATE_FAILED')).toBe('error')
    expect(stateOfTask('TASK_STATE_CANCELED')).toBe('error')
  })
})
