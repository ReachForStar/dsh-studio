import { describe, expect, it } from 'vitest'
import { partitionSdk, renderCompactCatalog } from '@deepseek-ai/dsh-tool-executor-ptc/src/sdk-catalog.ts'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tool-executor-ptc/src/ts-types.ts'

/** Smallest budget that expands exactly one of the schemas, found through the public partition. */
function oneToolBudget(schemas: readonly ToolSdkSchema[]): number {
  for (let budget = 1; budget <= 1000; budget++) {
    if (partitionSdk(schemas, budget).expanded.length === 1) return budget
  }
  throw new Error('no budget expands exactly one tool')
}

const schema = (name: string, overrides: Partial<ToolSdkSchema> = {}): ToolSdkSchema => ({
  name,
  description: `The ${name} tool.`,
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  output: { type: 'string' },
  ...overrides,
})

describe('partitionSdk', () => {
  it('expands every tool when the budget is non-positive', () => {
    const { expanded, compact } = partitionSdk([schema('b'), schema('a')], 0)
    expect(expanded.map(tool => tool.name)).toEqual(['a', 'b'])
    expect(compact).toEqual([])
  })

  it('sorts before selecting, so input order cannot change the partition', () => {
    const budget = oneToolBudget([schema('a'), schema('b')])
    expect(partitionSdk([schema('b'), schema('a')], budget))
      .toEqual(partitionSdk([schema('a'), schema('b')], budget))
  })

  it('keeps the lexicographic prefix that fits and compacts the rest', () => {
    const budget = oneToolBudget([schema('a'), schema('b'), schema('c')])
    const { expanded, compact } = partitionSdk([schema('c'), schema('a'), schema('b')], budget)
    expect(expanded.map(tool => tool.name)).toEqual(['a'])
    expect(compact.map(tool => tool.name)).toEqual(['b', 'c'])
  })

  it('expands nothing when the budget only covers the catalog header', () => {
    const { expanded, compact } = partitionSdk([schema('a')], 1)
    expect(expanded).toEqual([])
    expect(compact.map(tool => tool.name)).toEqual(['a'])
  })

  it('keeps input order for byte-equal names', () => {
    const first = schema('a', { description: 'First.' })
    const second = schema('a', { description: 'Second.' })
    expect(partitionSdk([first, second], 0).expanded).toEqual([first, second])
  })

  it('sizes numeric and boolean schema leaves without string counting', () => {
    const { expanded } = partitionSdk([schema('a', {
      parameters: { type: 'object', properties: { choice: { enum: [1, true] } } },
    })], 1000)
    expect(expanded.map(tool => tool.name)).toEqual(['a'])
  })

  it('sizes an empty description as zero cost', () => {
    const { expanded } = partitionSdk([schema('a', { description: '' })], 1000)
    expect(expanded.map(tool => tool.name)).toEqual(['a'])
  })
})

describe('renderCompactCatalog', () => {
  it('renders nothing when every tool is expanded', () => {
    expect(renderCompactCatalog([], true)).toBe('')
  })

  it('names required and optional parameters and points at tool_search', () => {
    const text = renderCompactCatalog([
      schema('search_docs', {
        description: 'Search the documentation.\nIgnored second line.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query'],
        },
      }),
    ], true)
    expect(text).toContain('- `search_docs(query, limit?)` — Search the documentation.')
    expect(text).toContain('Call `tool_search` for the exact signature')
    expect(text).not.toContain('Ignored second line.')
  })

  it('truncates a long description and omits an absent one', () => {
    const long = 'x'.repeat(200)
    const text = renderCompactCatalog([schema('long', { description: long }), schema('bare', { description: '' })], false)
    expect(text).toContain(`— ${'x'.repeat(117)}...`)
    expect(text.endsWith('- `bare(value)`')).toBe(true)
    expect(text).not.toContain('Call `tool_search`')
    expect(text).toContain('argument schemas are not shown')
  })

  it('omits parameters when the schema is not an object or declares none', () => {
    expect(renderCompactCatalog([schema('scalar', { parameters: { type: 'string', properties: { x: {} } } })], true))
      .toContain('- `scalar()`')
    expect(renderCompactCatalog([schema('nullProperties', { parameters: { type: 'object', properties: null } as unknown as Record<string, unknown> })], true))
      .toContain('- `nullProperties()`')
    expect(renderCompactCatalog([schema('noRequired', {
      parameters: { type: 'object', properties: { a: {}, b: {} } },
    })], true)).toContain('- `noRequired(a?, b?)`')
  })
})
