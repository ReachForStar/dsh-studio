import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, createToolSearchTool, renderCatalog, searchTools } from '../src/index.ts'


function definition(name: string, description: string): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: { path: { type: 'string', required: true, description: 'Path' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'ok',
  })
}

function options(extra: Partial<{ name: string; query: string; maxResults: number; descriptionMaxLength: number }> = {}) {
  return { maxResults: 8, descriptionMaxLength: 240, ...extra }
}

const DEFINITIONS = [
  definition('read_file', 'Read a file from disk.'),
  definition('edit_file', 'Edit an existing file in place.'),
  definition('grep_files', 'Search file contents with a pattern.'),
]

describe('searchTools', () => {
  it('returns no entry without a query or an exact name', () => {
    expect(searchTools(DEFINITIONS, options())).toEqual([])
  })

  it('matches every term against the name or description', () => {
    expect(searchTools(DEFINITIONS, options({ query: 'file' })).map(entry => entry.name))
      .toEqual(['read_file', 'edit_file', 'grep_files'])
    expect(searchTools(DEFINITIONS, options({ query: 'edit file' })).map(entry => entry.name)).toEqual(['edit_file'])
  })

  it('ranks name matches before description-only matches', () => {
    expect(searchTools(DEFINITIONS, options({ query: 'grep' })).map(entry => entry.name)).toEqual(['grep_files'])
    const ranked = searchTools(
      [...DEFINITIONS, definition('search_helper', 'A helper that greps quickly.')],
      options({ query: 'grep' }),
    )
    expect(ranked.map(entry => entry.name)).toEqual(['grep_files', 'search_helper'])
  })

  it('prefers an exact name over the query', () => {
    expect(searchTools(DEFINITIONS, options({ name: 'edit_file', query: 'read' })).map(entry => entry.name))
      .toEqual(['edit_file'])
  })

  it('returns nothing for an unknown exact name', () => {
    expect(searchTools(DEFINITIONS, options({ name: 'missing_tool' }))).toEqual([])
  })

  it('caps the result count', () => {
    expect(searchTools(DEFINITIONS, options({ query: 'file', maxResults: 2 }))).toHaveLength(2)
  })

  it('truncates long descriptions', () => {
    const long = definition('long_tool', 'x'.repeat(100))
    expect(searchTools([long], options({ name: 'long_tool', descriptionMaxLength: 40 }))[0]?.description).toHaveLength(40)
  })

  it('carries the parameter schema of each match', () => {
    const [entry] = searchTools(DEFINITIONS, options({ name: 'read_file' }))
    expect(entry?.parameters).toMatchObject({ type: 'object', properties: { path: { type: 'string' } } })
  })
})

describe('renderCatalog', () => {
  it('states that nothing matched', () => {
    expect(renderCatalog([])).toContain('No tool matched')
  })

  it('renders one block per entry with its schema', () => {
    const text = renderCatalog(searchTools(DEFINITIONS, options({ name: 'read_file' })))
    expect(text).toContain('## read_file')
    expect(text).toContain('Read a file from disk.')
    expect(text).toContain('"type":"string"')
  })
})

/** Minimal run context: the search tool reads only the agent scope and the signal. */
const EXEC: ToolRunContext = {
  callId: ToolCallId('tool-search'), rootCallId: ToolCallId('tool-search'), name: 'tool_search', arguments: {},
  token: Symbol('tool-search') as ToolExecutionToken, signal: new AbortController().signal,
  deferContext() {}, concludeTurn() {},
}

/** Catalog one search call returns; the tool's declared output schema fixes this shape. */
type CatalogResult = { tools: { name: string }[] }

function contextWith(definitions: readonly ToolDefinition[]): Context {
  return { tools: { definitions: () => definitions } } as Context
}

describe('createToolSearchTool', () => {
  it('returns the matching tools for a query', async () => {
    const tool = createToolSearchTool(contextWith(DEFINITIONS), {})
    const result = await tool.execute({ query: 'read' }, EXEC) as CatalogResult
    expect(result).toMatchObject({ tools: [{ name: 'read_file' }] })
  })

  it('renders its catalog through the declared presentation', async () => {
    const tool = createToolSearchTool(contextWith(DEFINITIONS), {})
    const value = await tool.execute({ name: 'read_file' }, EXEC)
    const blocks = tool.output.render({ name: 'read_file' }, value as JsonValue)
    expect(JSON.stringify(blocks)).toContain('## read_file')
  })

  it('honours the configured caps', async () => {
    const tool = createToolSearchTool(contextWith(DEFINITIONS), { maxResults: 1, descriptionMaxLength: 40 })
    const result = await tool.execute({ query: 'file' }, EXEC) as CatalogResult
    expect(result.tools).toHaveLength(1)
  })

  it.each([
    ['maxResults', 0],
    ['descriptionMaxLength', 39],
  ])('rejects an out-of-range %s', (field, value) => {
    expect(() => createToolSearchTool(contextWith([]), { [field]: value })).toThrow(new RegExp(field))
  })
})

describe('apply', () => {
  it('registers the search tool on the calling context', () => {
    const registered: ToolDefinition[] = []
    const ctx = { tools: { register: (definition: ToolDefinition) => { registered.push(definition); return () => {} } } } as Context
    apply(ctx)
    expect(registered.map(definition => definition.name)).toEqual(['tool_search'])
  })
})
