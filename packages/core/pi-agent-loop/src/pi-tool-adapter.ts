/**
 * Adapt a Pi tool into a dsh tool so dsh's own tool surface can also invoke
 * Pi-registered tools (extensions/skills). This is stage 4's Pi-to-dsh tool
 * sharing, the reverse direction of {@link adaptDshTool}.
 *
 * Pi tools declare TypeBox parameters and return `AgentToolResult`; dsh tools
 * declare a per-property schema and return a canonical JSON value. The adapter
 * mirrors the common TypeBox shapes into dsh's schema form and folds the Pi
 * result's text content into a JSON object so the dsh pipeline can materialize
 * it.
 *
 * @module dsh-pi-agent-loop/pi-tool-adapter
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** A narrowing of the Pi tool surface this adapter consumes. */
export interface PiToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters?: unknown
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<{ content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown }>
}

/** A narrowing of the Pi extension runner the adapter asks for tool context. */
export interface PiRunnerLike {
  createContext(): unknown
}

/** A minimal dsh-style parameter declaration. */
interface DshSpec {
  readonly type?: string
  readonly required?: boolean
  readonly description?: string
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly oneOf?: readonly DshSpec[]
  readonly properties?: Record<string, DshSpec>
  readonly items?: DshSpec
}

/** Mirror one TypeBox schema (via its JSON form) into a dsh spec. */
function typeBoxToDshSpec(schema: unknown): DshSpec {
  if (schema === null || typeof schema !== 'object') return {}
  const raw = JSON.parse(JSON.stringify(schema)) as {
    readonly type?: string
    readonly enum?: readonly unknown[]
    readonly const?: unknown
    readonly oneOf?: readonly unknown[]
    readonly properties?: Record<string, unknown>
    readonly required?: readonly string[]
    readonly items?: unknown
  }
  if (raw.oneOf !== undefined) return { oneOf: raw.oneOf.map(value => typeBoxToDshSpec(value)) }
  if (raw.const !== undefined) return { const: raw.const }
  if (raw.enum !== undefined) return { type: 'string', enum: raw.enum }
  switch (raw.type) {
    case 'object': {
      const properties: Record<string, DshSpec> = {}
      for (const [key, value] of Object.entries(raw.properties ?? {})) {
        const spec = typeBoxToDshSpec(value)
        if (raw.required?.includes(key)) (spec as { required?: boolean }).required = true
        properties[key] = spec
      }
      return { type: 'object', properties }
    }
    case 'array':
      return { type: 'array', ...raw.items === undefined ? {} : { items: typeBoxToDshSpec(raw.items) } }
    case 'string':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'integer':
      return { type: 'integer' }
    case 'boolean':
      return { type: 'boolean' }
    default:
      return {}
  }
}

/** Flatten Pi content blocks into dsh content blocks. */
function piContentToBlocks(content: ReadonlyArray<{ type: string; text?: string }>): ContentBlock[] {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => ({ type: 'text', text: block.text as string }))
}

/**
 * Wrap one Pi tool so dsh can register and invoke it.
 * @param piTool - the Pi tool (definition + execute).
 * @param piRunner - the Pi extension runner that supplies the tool context.
 * @returns a dsh registry-ready tool definition.
 */
export function adaptPiTool(piTool: PiToolDefinitionLike, piRunner: PiRunnerLike): ToolDefinition {
  return {
    name: piTool.name,
    description: piTool.description,
    parameters: typeBoxToDshSpec(piTool.parameters) as unknown as ToolDefinition['parameters'],
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: JsonValue): ContentBlock[] =>
        piContentToBlocks([{ type: 'text', text: JSON.stringify(value ?? '') }]),
    },
    execute: async (args: unknown, exec: { signal: AbortSignal; callId?: unknown }): Promise<unknown> => {
      const callId = typeof exec.callId === 'string' ? exec.callId : ''
      const result = await piTool.execute(
        callId,
        args,
        exec.signal,
        undefined,
        piRunner.createContext(),
      )
      const blocks = piContentToBlocks(result.content)
      return { text: blocks.map(block => (block.type === 'text' ? block.text : '')).join('') }
    },
  } as unknown as ToolDefinition
}
