import { describe, expect, it } from 'vitest'
import { adaptDshTool } from '@deepseek-ai/dsh-pi-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type ToolRuntime from '@deepseek-ai/dsh-tools'

/** A minimal fake of the dsh ToolRuntime.execute surface. */
function fakeTools(calls: Array<{ name: string; args: unknown; callId: string }>) {
  return {
    async execute(exec: { callId: string; name: string; arguments: unknown }) {
      calls.push({ name: exec.name, args: exec.arguments, callId: exec.callId })
      return { content: [{ type: 'text' as const, text: `ran ${exec.name}` }] }
    },
  } as unknown as ToolRuntime
}

const stubAgent = {} as Agent

describe('adaptDshTool', () => {
  it('adapts a dsh tool into a Pi tool that dispatches through ToolRuntime', async () => {
    const calls: Array<{ name: string; args: unknown; callId: string }> = []
    const tools = fakeTools(calls)
    const tool = adaptDshTool({ name: 'bash', description: 'run a command' }, tools, stubAgent)

    expect(tool.name).toBe('bash')
    expect(tool.description).toBe('run a command')

    const result = await tool.execute('call-7', { command: 'ls' })
    expect(calls).toEqual([{ name: 'bash', args: { command: 'ls' }, callId: 'call-7' }])
    expect(result.content).toEqual([{ type: 'text', text: 'ran bash' }])
  })

  it('mirrors dsh parameter declarations into a TypeBox object schema', () => {
    const tools = fakeTools([])
    const tool = adaptDshTool({
      name: 'bash',
      description: 'run a command',
      parameters: {
        command: { type: 'string', required: true, description: 'command' },
        timeoutMs: { type: 'number' },
      },
    }, tools, stubAgent)

    const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties ?? {})).toEqual(['command', 'timeoutMs'])
    expect(schema.required).toEqual(['command'])
  })

  it('mirrors description and title annotations into TypeBox', () => {
    const tools = fakeTools([])
    const tool = adaptDshTool({
      name: 'any',
      description: 'anything',
      parameters: {
        label: { type: 'string', title: 'Label title', description: 'label text' },
      },
    }, tools, stubAgent)

    const schema = tool.parameters as {
      properties?: Record<string, { description?: string; title?: string }>
    }
    expect(schema.properties?.label?.title).toBe('Label title')
    expect(schema.properties?.label?.description).toBe('label text')
  })
})
