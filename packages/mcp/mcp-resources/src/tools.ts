/**
 * Four shared tools adapt model arguments to scoped resource operations.
 *
 * @module @deepseek-ai/dsh-mcp-resources
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { McpResourceRequest } from './index.ts'
import { renderResourceResult, renderResourceWatchResult } from './render.ts'

type RequestResource = (server: string, request: McpResourceRequest, exec: ToolExecution) => Promise<JsonValue>

const listParameters = {
  server: { type: 'string', required: true, description: 'Configured MCP server name.' },
  cursor: { type: 'string', description: 'Continuation cursor returned by this server.' },
} as const

const output = {
  schema: { type: 'json' } as const,
  render: (args: { server: string }, value: JsonValue) => renderResourceResult(args.server, value),
}

/**
 * Register resource operations in the consumer's tool scope.
 * @param ctx - context owning the tool registrations.
 * @param request - caller-aware resource operation.
 * @returns the effect disposer that removes all four tools synchronously.
 */
export function registerResourceTools(ctx: Context, request: RequestResource): () => void {
  // All four tools are read-only and parallel-safe; `McpResourceProvider.request` settles concurrent requests independently.
  const dispose = ctx.effect(function* () {
    yield ctx.tools.register(defineTool({
      name: 'list_mcp_resources',
      description: 'List resources available from an MCP server.',
      parameters: listParameters,
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => request(args.server, {
        method: 'resources/list', ...args.cursor === undefined ? {} : { cursor: args.cursor },
      }, exec),
    }))
    yield ctx.tools.register(defineTool({
      name: 'list_mcp_resource_templates',
      description: 'List parameterized resource URI templates from an MCP server.',
      parameters: listParameters,
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => request(args.server, {
        method: 'resources/templates/list', ...args.cursor === undefined ? {} : { cursor: args.cursor },
      }, exec),
    }))
    yield ctx.tools.register(defineTool({
      name: 'read_mcp_resource',
      description: 'Read an MCP resource by URI from the named server. Use a listed URI or an expanded resource template.',
      parameters: {
        server: listParameters.server,
        uri: { type: 'string', required: true, description: 'Resource URI to read.' },
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => request(args.server, { method: 'resources/read', uri: args.uri }, exec),
    }))
    yield ctx.tools.register(defineTool({
      name: 'watch_mcp_resource',
      description: 'Wait for an MCP server to report that a resource changed. Subscribes first and unsubscribes when the wait ends. '
        + 'Returns updated: true after the first change, or updated: false when the wait times out; read the resource again to get its content. '
        + 'The server must support resource subscriptions.',
      parameters: {
        server: listParameters.server,
        uri: { type: 'string', required: true, description: 'Resource URI to watch.' },
        timeoutMs: {
          type: 'integer',
          description: 'Milliseconds to wait for the first change. Omit to use the default wait; larger values are capped.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            uri: { type: 'string', required: true },
            updated: { type: 'boolean', required: true },
            waitedMs: { type: 'integer', required: true },
          },
        },
        render: (args, value) => renderResourceWatchResult(args.server, value),
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1)) {
          throw new Error('watch_mcp_resource: timeoutMs must be a positive integer number of milliseconds')
        }
        return watchResult(await request(args.server, {
          method: 'resources/watch',
          uri: args.uri,
          ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
        }, exec))
      },
    }))
  }, 'mcpResources.resourceTools')
  // oxlint-disable-next-line typescript/no-misused-promises -- all collected tool disposers are synchronous
  return dispose
}

/**
 * Narrow the provider's lossless-JSON watch result to the tool's declared output.
 * @param value - provider result under the shared resource contract.
 * @returns the watch URI, update flag, and wait duration.
 */
function watchResult(value: JsonValue): { uri: string; updated: boolean; waitedMs: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof value.uri !== 'string' || typeof value.updated !== 'boolean' || typeof value.waitedMs !== 'number') {
    throw new Error('watch_mcp_resource: the server returned an invalid watch result')
  }
  return { uri: value.uri, updated: value.updated, waitedMs: value.waitedMs }
}
