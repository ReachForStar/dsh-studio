/**
 * Budget-driven split of the generated PTC SDK: fully typed declarations for
 * the tools that fit, one-line catalog entries for the rest. Both language
 * renderers consume the same partition, so the selected set does not depend on
 * the loaded runtime's language.
 * @module @deepseek-ai/dsh-tool-executor-ptc/src/sdk-catalog
 */

import type { ToolSdkSchema } from './ts-types.ts'

/** Fixed cost of one expanded declaration beyond its schema bytes. */
const DECLARATION_TOKENS = 40
/** Fixed cost of one catalog entry beyond its rendered text. */
const CATALOG_ENTRY_TOKENS = 12
/** Fixed cost of the catalog heading and its search hint. */
const CATALOG_HEADER_TOKENS = 60
/** Rough characters per model token; matches the catalog budget used by comparable generators. */
const CHARACTERS_PER_TOKEN = 4
/** Approximate tokens one schema node adds when expanded into a declaration. */
const NODE_TOKENS = 6
/** Catalog descriptions stop at one short line. */
const DESCRIPTION_LIMIT = 120

/** Expanded and compact tool sets for one SDK rendering. */
export interface SdkPartition {
  /** Tools rendered with their complete argument and output declarations. */
  readonly expanded: readonly ToolSdkSchema[]
  /** Tools named in the compact catalog, bound with untyped arguments and results. */
  readonly compact: readonly ToolSdkSchema[]
}

/**
 * Split lexicographically sorted tool schemas at an approximate token budget.
 * The estimate counts schema bytes rather than rendered text so the same tools
 * stay expanded under every runtime language. A non-positive budget expands
 * every tool.
 * @param schemas - tools to declare, excluding `run_code` itself.
 * @param budgetTokens - approximate token budget for expanded declarations.
 * @returns the expanded prefix and the compact remainder.
 */
export function partitionSdk(schemas: readonly ToolSdkSchema[], budgetTokens: number): SdkPartition {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (budgetTokens <= 0) return { expanded: sorted, compact: [] }
  const expanded: ToolSdkSchema[] = []
  const compact: ToolSdkSchema[] = []
  let remaining = budgetTokens - CATALOG_HEADER_TOKENS
  for (const schema of sorted) {
    const cost = estimateDeclarationTokens(schema)
    if (remaining - cost >= 0) {
      expanded.push(schema)
      remaining -= cost
      continue
    }
    compact.push(schema)
  }
  // The header is only spent when a catalog exists; returning it keeps a
  // borderline tool expanded instead of leaving an unused reserve.
  return { expanded, compact }
}

/** Approximate token cost of one tool's expanded argument and output declarations. */
function estimateDeclarationTokens(schema: ToolSdkSchema): number {
  return DECLARATION_TOKENS + CATALOG_ENTRY_TOKENS + schemaTokens(schema.parameters) + schemaTokens(schema.output)
    + Math.ceil(schema.description.length / CHARACTERS_PER_TOKEN)
}

/**
 * Size a schema without recursion: deeply nested output schemas overflow a
 * recursive serializer long before the renderer, which walks them iteratively.
 */
function schemaTokens(schema: unknown): number {
  let nodes = 0
  let characters = 0
  const pending: unknown[] = [schema]
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item)
      continue
    }
    if (typeof value === 'object' && value !== null) {
      nodes += 1
      for (const item of Object.values(value as Record<string, unknown>)) pending.push(item)
      continue
    }
    if (typeof value === 'string') characters += value.length
  }
  return NODE_TOKENS * nodes + Math.ceil(characters / CHARACTERS_PER_TOKEN)
}

/**
 * Render the markdown catalog of compact tools. The lines carry parameter
 * names and requiredness only; the full signature stays with the discovery
 * tool, so a large tool surface costs a few tokens per tool.
 * @param compact - tools rendered compactly by the SDK declarations.
 * @param hasSearchBinding - whether a `tool_search` binding is declared, which the catalog can name.
 * @returns the catalog block, or an empty string when every tool is expanded.
 */
export function renderCompactCatalog(compact: readonly ToolSdkSchema[], hasSearchBinding: boolean): string {
  if (compact.length === 0) return ''
  const hint = hasSearchBinding
    ? ' Call `tool_search` for the exact signature of any entry before you use it.'
    : ' Their argument schemas are not shown; use the project documentation or a declared search binding when you need exact fields.'
  const lines = compact.map(schema => `- \`${schema.name}(${parameterSummary(schema.parameters)})\`${describe(schema)}`)
  return `\n\nThe declarations above expand the tools that fit the SDK budget. These tools are bound the same way but shown compactly.${hint}\n\n${lines.join('\n')}`
}

/** One-line parameter names with `?` on optional fields. */
function parameterSummary(parameters: Record<string, unknown>): string {
  if (parameters.type !== 'object' || parameters.properties === undefined || parameters.properties === null) return ''
  const required = new Set(Array.isArray(parameters.required) ? parameters.required as string[] : [])
  return Object.keys(parameters.properties)
    .map(name => `${name}${required.has(name) ? '' : '?'}`)
    .join(', ')
}

/** A truncated single-line description, or nothing when the tool has none. */
function describe(schema: ToolSdkSchema): string {
  const newline = schema.description.indexOf('\n')
  const description = (newline === -1 ? schema.description : schema.description.slice(0, newline)).trim()
  if (description.length === 0) return ''
  return ` — ${description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT - 3)}...` : description}`
}
