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
})
