import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CodemodeService, Config } from '../src/index.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'

function stubToolResult(text: string) {
  return { results: [{ result: { content: [{ type: 'text', text }] } }] }
}

async function harness(toolText = 'tool-output') {
  const ctx = new Context()
  const calls: ToolCallBlock[] = []
  ctx.provide('tools', {
    definitions: () => [{ name: 'echo', description: '', parameters: {} }],
    execute: async (input: { calls: readonly ToolCallBlock[] }) => {
      calls.push(...input.calls)
      return stubToolResult(toolText)
    },
  })
  ctx.provide('llm', {
    classify: async () => ({ answers: {}, stopReason: 'stop' }),
    generateImages: async () => ({ output: [], stopReason: 'stop' }),
  })
  const service = new CodemodeService(ctx, Config({ timeoutMs: 30_000, maxOutputChars: 16_000 }))
  const agent = { id: 'agent-1' } as never
  return { ctx, service, calls, agent }
}

describe('CodemodeService.run', () => {
  it('returns a top-level value as output', async () => {
    const { ctx, service, agent } = await harness()
    const output = await service.run(agent, 'return 1 + 1', new AbortController().signal)
    expect(output).toContain('Script completed')
    expect(output).toContain('2')
    await ctx.fiber.dispose()
  })

  it('collects text() items in order', async () => {
    const { ctx, service, agent } = await harness()
    const output = await service.run(agent, "text('a')\ntext('b')", new AbortController().signal)
    expect(output).toContain('a\nb')
    await ctx.fiber.dispose()
  })

  it('calls an injected tool through the executor', async () => {
    const { ctx, service, calls, agent } = await harness('hello from tool')
    const output = await service.run(agent, "const r = await tools.echo({ text: 'x' })\ntext(r)", new AbortController().signal)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('echo')
    expect(output).toContain('hello from tool')
    await ctx.fiber.dispose()
  })

  it('keeps store values across calls', async () => {
    const { ctx, service, agent } = await harness()
    await service.run(agent, "store('k', { n: 1 })", new AbortController().signal)
    const output = await service.run(agent, "text(JSON.stringify(load('k')))", new AbortController().signal)
    expect(output).toContain('{"n":1}')
    await ctx.fiber.dispose()
  })

  it('reports a script error with partial output', async () => {
    const { ctx, service, agent } = await harness()
    const output = await service.run(agent, "text('before')\nthrow new Error('boom')", new AbortController().signal)
    expect(output).toContain('Script failed')
    expect(output).toContain('before')
    expect(output).toContain('boom')
    await ctx.fiber.dispose()
  })
})
