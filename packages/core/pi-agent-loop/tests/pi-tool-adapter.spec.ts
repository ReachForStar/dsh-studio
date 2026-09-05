import { describe, expect, it } from 'vitest'
import { adaptPiTool } from '@deepseek-ai/dsh-pi-agent-loop'
import type { PiToolDefinitionLike, PiRunnerLike } from '@deepseek-ai/dsh-pi-agent-loop'

const runner: PiRunnerLike = { createContext: () => ({ cwd: '/work' }) }

const piTool: PiToolDefinitionLike = {
  name: 'pi_grep',
  description: 'search files',
  parameters: undefined,
  async execute(toolCallId, params, _signal, _onUpdate, ctx) {
    return {
      content: [{ type: 'text', text: `matched ${String(params)} in ${String((ctx as { cwd?: string }).cwd)} (${toolCallId})` }],
      details: undefined,
    }
  },
}

describe('adaptPiTool', () => {
  it('adapts a Pi tool into a dsh tool whose execute delegates back to Pi', async () => {
    const tool = adaptPiTool(piTool, runner)

    expect(tool.name).toBe('pi_grep')
    expect(tool.description).toBe('search files')

    const value = await tool.execute('needle', { signal: new AbortController().signal, callId: 'c1' } as never)
    expect(value).toEqual({ text: 'matched needle in /work (c1)' })
  })

  it('mirrors a TypeBox object schema into dsh required-per-property form', () => {
    const withSchema: PiToolDefinitionLike = { ...piTool, parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    } }
    const tool = adaptPiTool(withSchema, runner)
    const parameters = tool.parameters as { properties?: Record<string, { required?: boolean; type?: string }> }
    expect(parameters.properties?.pattern).toEqual({ type: 'string', required: true })
  })

  it('mirrors null and unconstrained TypeBox shapes into dsh schemas', () => {
    const withNull: PiToolDefinitionLike = { ...piTool, parameters: { type: 'null' } }
    expect((adaptPiTool(withNull, runner).parameters as { type?: string }).type).toBe('null')

    const withAny: PiToolDefinitionLike = { ...piTool, parameters: {} }
    expect((adaptPiTool(withAny, runner).parameters as { type?: string }).type).toBe('json')
  })
})
