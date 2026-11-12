/** Argument repair runs on the real dispatch path, not as a test-only helper. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { id: SessionId('repair') } as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['tools'] }))
  const controller = new AbortController()
  const received: JsonValue[] = []
  const tool = defineTool({
    name: 'typed',
    description: 'A tool whose parameters exercise the scalar, container, and nested repair paths.',
    parameters: {
      count: { type: 'integer' },
      ratio: { type: 'number' },
      verbose: { type: 'boolean' },
      label: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', additionalProperties: true, properties: { depth: { type: 'number' }, name: { type: 'string' } } },
      anything: { type: 'json' },
      bag: { type: 'object', additionalProperties: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      received.push(args as JsonValue)
      return 'ok'
    },
  })
  ctx.tools.register(tool)
  return {
    tool,
    received,
    execute: (args: unknown): Promise<ToolExecutionResult> => executeToolFixture(ctx, {
      agent, name: tool.name, arguments: args, callId: ToolCallId('call'), signal: controller.signal,
    }),
  }
}

it('repairs uniquely determined scalar, container, and nested argument types', async () => {
  const h = await setup()
  const result = await h.execute({
    count: '12',
    ratio: '1.5',
    verbose: 'true',
    label: 42,
    tags: '["a","b"]',
    nested: '{"depth":"3","name":7}',
  })

  expect(result.isError).toBe(false)
  expect(h.received).toEqual([{
    count: 12,
    ratio: 1.5,
    verbose: true,
    label: '42',
    tags: ['a', 'b'],
    nested: { depth: 3, name: '7' },
  }])
})

it('parses whole-object JSON text and repairs array entries', async () => {
  const h = await setup()
  const result = await h.execute('{"count": "2", "tags": [1, "b"]}')

  expect(result.isError).toBe(false)
  expect(h.received).toEqual([{ count: 2, tags: ['1', 'b'] }])
})

it('leaves ambiguous or invalid values for validation to reject', async () => {
  const h = await setup()
  expect((await h.execute({ count: '2.5' })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ verbose: 'yes' })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ count: '' })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ nested: '[1]' })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute('not json')).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ tags: '{"a":1}' })).error?.info?.code).toBe('INVALID_ARGS')
})

it('returns the original arguments when no value changes', async () => {
  const h = await setup()
  const args = { count: 3, label: 'x', tags: ['y'], nested: { depth: 1, name: 'n' }, anything: 7 }
  const result = await h.execute(args)

  expect(result.isError).toBe(false)
  expect(h.received).toEqual([args])
})

it('leaves values it cannot coerce untouched for the JSON-typed and container branches', async () => {
  const h = await setup()
  expect((await h.execute({ count: 'abc' })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute('{"unclosed')).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ nested: 5 })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ tags: ['keep', 'as'] })).isError).toBe(false)
})

it('parses a JSON object or array text into the declared container', async () => {
  const h = await setup()
  const result = await h.execute({ nested: '{"depth": "4"}', tags: '["x"]' })

  expect(result.isError).toBe(false)
  expect(h.received).toEqual([{ nested: { depth: 4 }, tags: ['x'] }])
})

it('coerces booleans to strings and leaves uncoercible non-strings alone', async () => {
  const h = await setup()
  expect((await h.execute({ label: true })).isError).toBe(false)
  expect(h.received.at(-1)).toEqual({ label: 'true' })
  expect((await h.execute({ verbose: 'false' })).isError).toBe(false)
  expect(h.received.at(-1)).toEqual({ verbose: false })
  expect((await h.execute({ label: { nested: true } })).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute('[1]')).error?.info?.code).toBe('INVALID_ARGS')
  expect((await h.execute({ bag: { custom: 1 } })).isError).toBe(false)
  expect(h.received.at(-1)).toEqual({ bag: { custom: 1 } })
})
