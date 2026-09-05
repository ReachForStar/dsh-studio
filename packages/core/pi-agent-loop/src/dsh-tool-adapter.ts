/**
 * Adapt a dsh tool into a Pi custom tool so a Pi-driven session can call dsh's
 * tool backend through the dsh tool policy pipeline. This is stage 4's
 * dsh-to-Pi tool sharing.
 *
 * The dsh JSON-schema-style parameter declaration is mirrored into a TypeBox
 * schema (what Pi tools use) so the model receives the same parameter contract
 * on both sides. dsh still re-validates inside `ToolRuntime.execute`.
 *
 * @module dsh-pi-agent-loop/dsh-tool-adapter
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import { Type, type TSchema } from 'typebox'

/** The lazy JSON-schema-ish declaration dsh tools publish. */
interface DshSchema {
  readonly type?: string
  readonly required?: boolean
  readonly description?: string
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly oneOf?: readonly DshSchema[]
  readonly properties?: Record<string, DshSchema>
  readonly items?: DshSchema
  readonly additionalProperties?: boolean | DshSchema
}

/** The structural subset of a Pi tool definition this adapter produces. */
export interface AdaptedPiTool {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: TSchema
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: readonly ContentBlock[] }>
}

/** Mirror one dsh parameter declaration into a TypeBox schema. */
function dshSchemaToTypeBox(schema: DshSchema): TSchema {
  if (schema.oneOf !== undefined) {
    return Type.Union(schema.oneOf.map(dshSchemaToTypeBox))
  }
  if (schema.const !== undefined) return Type.Literal(schema.const as never)
  if (schema.enum !== undefined) return Type.Union(schema.enum.map(value => Type.Literal(value as never)))
  switch (schema.type) {
    case 'string':
      return Type.String()
    case 'number':
      return Type.Number()
    case 'integer':
      return Type.Integer()
    case 'boolean':
      return Type.Boolean()
    case 'null':
      return Type.Null()
    case 'array':
      return Type.Array(schema.items === undefined ? Type.Any() : dshSchemaToTypeBox(schema.items))
    case 'object':
      return dshObjectToTypeBox(schema.properties ?? {})
    default:
      return Type.Any()
  }
}

/** Mirror a dsh object declaration, preserving required-ness per property. */
function dshObjectToTypeBox(properties: Record<string, DshSchema>): TSchema {
  const mapped: Record<string, TSchema> = {}
  for (const [key, schema] of Object.entries(properties)) {
    const inner = dshSchemaToTypeBox(schema)
    mapped[key] = schema.required === true ? inner : Type.Optional(inner)
  }
  return Type.Object(mapped)
}

/**
 * Wrap one dsh tool so Pi can invoke it through dsh's `ToolRuntime.execute`.
 * @param tool - the dsh tool to expose (name, description, parameters).
 * @param tools - the dsh tool runtime that owns execution and policy.
 * @param agent - the dsh agent the call runs on behalf of.
 * @returns a Pi-shaped tool definition.
 */
export function adaptDshTool(
  tool: {
    readonly name: string
    readonly description: string
    readonly parameters?: Record<string, unknown>
  },
  tools: ToolRuntime,
  agent: Agent,
): AdaptedPiTool {
  const parameters = dshObjectToTypeBox(
    (tool.parameters ?? {}) as Record<string, DshSchema>,
  )
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (toolCallId, params, signal) => {
      const result = await tools.execute({
        callId: ToolCallId(toolCallId),
        name: tool.name,
        arguments: params,
        agent,
        signal: signal ?? new AbortController().signal,
      })
      return { content: result.content }
    },
  }
}
