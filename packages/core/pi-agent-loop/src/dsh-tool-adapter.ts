/**
 * Adapt a dsh tool into a Pi custom tool so a Pi-driven session can call dsh's
 * tool backend through the dsh tool policy pipeline. This is stage 4's
 * dsh-to-Pi tool sharing.
 *
 * The parameter schema is deliberately left empty for now: dsh owns schema
 * validation inside `ToolRuntime.execute`, so Pi's TypeBox schema is a pass-
 * through. mirroring the exact JSON Schema into TypeBox is deferred.
 *
 * @module dsh-pi-agent-loop/dsh-tool-adapter
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type ToolRuntime from '@deepseek-ai/dsh-tools'

/** The structural subset of a Pi tool definition this adapter produces. */
export interface AdaptedPiTool {
  readonly name: string
  readonly label: string
  readonly description: string
  /** Pass-through schema; dsh re-validates the real contract. */
  readonly parameters: unknown
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: readonly ContentBlock[] }>
}

/**
 * Wrap one dsh tool so Pi can invoke it through dsh's `ToolRuntime.execute`.
 * @param tool - the dsh tool to expose (name + description are model-visible).
 * @param tools - the dsh tool runtime that owns execution and policy.
 * @param agent - the dsh agent the call runs on behalf of.
 * @returns a Pi-shaped tool definition.
 */
export function adaptDshTool(
  tool: Pick<ToolDefinition, 'name' | 'description'>,
  tools: ToolRuntime,
  agent: Agent,
): AdaptedPiTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: {},
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
