/**
 * Model-facing tool discovery. The model asks for tools by keyword, or fetches
 * one by exact name, when the schemas it needs are not in view; it then calls
 * the tool directly through the normal executor. A tool stays registered and
 * callable whether or not this package is mounted.
 * @module @deepseek-ai/dsh-tool-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const name = 'tool-search'
export const inject = ['tools']

/** Default cap on tools returned by one search. */
const DEFAULT_MAX_RESULTS = 8

/** One tool entry a search returns. */
export interface ToolCatalogEntry {
  /** Tool name the model passes to the tool call. */
  readonly name: string
  /** Tool description, trimmed to the configured catalog length. */
  readonly description: string
  /** Parameter schema of the tool. */
  readonly parameters: Record<string, JsonValue>
}

/** Tool discovery configuration. */
export interface Config {
  /** Maximum entries one search returns; minimum 1. */
  maxResults?: number
  /** Maximum description length kept per entry; minimum 40. */
  descriptionMaxLength?: number
}

/** Schemastery configuration for tool discovery. */
export const Config: z<Config> = z.object({
  maxResults: z.number().default(DEFAULT_MAX_RESULTS),
  descriptionMaxLength: z.number().default(240),
})

/**
 * Select the tools one query matches.
 * @param definitions - tools visible to the calling agent.
 * @param options - exact name, keywords, and result cap.
 * @returns matching entries; an exact name yields at most that tool, keywords
 *   match every term against the name or the description, and name matches rank
 *   first.
 */
export function searchTools(
  definitions: readonly ToolDefinition[],
  options: {
    readonly name?: string | undefined
    readonly query?: string | undefined
    readonly maxResults: number
    readonly descriptionMaxLength: number
  },
): ToolCatalogEntry[] {
  const exact = options.name === undefined
    ? undefined
    : definitions.find(definition => definition.name === options.name)
  const matched = exact === undefined ? rankByQuery(definitions, options.query) : [exact]
  return matched.slice(0, options.maxResults).map(definition => ({
    name: definition.name,
    description: definition.description.slice(0, options.descriptionMaxLength),
    // projectToolSchema already proves the parameters are lossless JSON.
    parameters: projectToolSchema(definition, true).parameters as Record<string, JsonValue>,
  }))
}

/**
 * Rank definitions against a keyword query.
 * @param definitions - visible tools.
 * @param query - whitespace-separated terms; an absent or blank query matches nothing.
 * @returns tools whose name matches at least one term first, then the rest, each
 *   group in registry order.
 */
function rankByQuery(definitions: readonly ToolDefinition[], query: string | undefined): ToolDefinition[] {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(term => term.length > 0)
  if (terms.length === 0) return []
  const hits = definitions.filter((definition) => {
    const haystack = `${definition.name} ${definition.description}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
  const named = hits.filter(definition => terms.some(term => definition.name.toLowerCase().includes(term)))
  return [...named, ...hits.filter(definition => !named.includes(definition))]
}

/**
 * Render a catalog for the model.
 * @param entries - search result entries.
 * @returns one Markdown block; an empty result states that no tool matched.
 */
export function renderCatalog(entries: readonly ToolCatalogEntry[]): string {
  if (entries.length === 0) return 'No tool matched. Try a different keyword, or omit the query to list tools by name only.'
  return entries.map(entry => [
    `## ${entry.name}`,
    entry.description,
    '```json',
    JSON.stringify(entry.parameters),
    '```',
  ].join('\n')).join('\n\n')
}

/**
 * Register the model-facing tool search.
 * @param ctx - context carrying `ctx.tools`.
 * @param config - result cap and description length cap.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(createToolSearchTool(ctx, config))
}

/**
 * Build the search tool for one context.
 * @param ctx - context whose `ctx.tools` supplies the agent's visible surface.
 * @param config - result cap and description length cap.
 * @returns the model-facing tool definition.
 * @throws when a cap is out of range.
 */
export function createToolSearchTool(ctx: Context, config: Config = {}): ToolDefinition {
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  const descriptionMaxLength = config.descriptionMaxLength ?? 240
  assertPositiveInteger('maxResults', maxResults, 1)
  assertPositiveInteger('descriptionMaxLength', descriptionMaxLength, 40)

  return defineTool({
    name: 'tool_search',
    description: 'Find tools this session can call when their schemas are not in view. Search by keyword, or pass an exact name to fetch one tool; the answer lists each match with its parameter schema, and you then call that tool directly.',
    parameters: {
      query: { type: 'string', description: 'Keywords matched against tool names and descriptions.' },
      name: { type: 'string', description: 'Exact tool name; wins over query.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                parameters: { type: 'object', additionalProperties: true, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCatalog(value.tools) }],
    },
    execute(args, exec) {
      return Promise.resolve({
        tools: searchTools(ctx.tools.definitions(exec.agent), {
          name: args.name,
          query: args.query,
          maxResults,
          descriptionMaxLength,
        }),
      })
    },
  })
}

function assertPositiveInteger(field: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name}: "${field}" must be an integer of at least ${String(minimum)}, received ${String(value)}.`)
  }
}
