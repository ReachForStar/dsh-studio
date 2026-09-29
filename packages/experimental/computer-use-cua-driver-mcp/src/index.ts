/**
 * Exclusive computer use through an installed Cua Driver MCP executable.
 * The MCP client owns discovery, execution, image admission, and reconnection.
 * When the driver is not installed the plugin activates without registering a
 * provider, and check/install fetch routes remain available for setup.
 * @module
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-computer-use'
import { checkDriver, runInstall } from './installer.ts'

/** Cordis plugin identity for the installed Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-mcp'

/** The shared reservation and tool registry must exist before connection. */
export const inject = ['computerUse', 'tools']

/** Fetch route registry shape for the connection service. */
interface ConnectionFetch {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

function connectionOf(ctx: Context): ConnectionFetch {
  return Reflect.get(ctx, 'connection') as ConnectionFetch
}

/** Installed executable and MCP connection overrides. */
export interface Config {
  /** Executable path or PATH command; defaults to `cua-driver`. */
  command: string
  /** Arguments passed without a shell; defaults to `['mcp']`. */
  args: string[]
  /** Per-call timeout in milliseconds; omission uses the MCP client's default. */
  toolCallTimeoutMs?: number
  /** Reconnection overrides; defaults to the MCP client's policy. */
  reconnect: McpClient.ReconnectConfig
}

/** Validate executable options; the MCP client resolves connection defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  command: z.string().pattern(/[^\s]/u).default('cua-driver'),
  args: z.array(String).default(['mcp']),
  toolCallTimeoutMs: z.number().min(1),
  reconnect: z.object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().min(1).default(500),
    maxDelayMs: z.number().min(1).default(30000),
    maxAttempts: z.number().min(1).step(1).default(10),
  }).default({ enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }),
}).default({ command: 'cua-driver', args: ['mcp'], reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } })

/**
 * Reserve computer use and activate the installed Cua Driver's MCP tools.
 * When the driver is not in PATH, check/install routes stay available and
 * the plugin activates without claiming the provider slot.
 * @param ctx - context providing computer use and the tool registry.
 * @param config - validated executable options and optional connection overrides.
 * @returns initial MCP tool-discovery completion, or void when not installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Register check/install routes — always available, even before the driver exists.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const disposeCheck = connectionOf(connectionCtx).fetch.register({
        path: '/api/computer-use/cua-driver/check',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const result = await checkDriver(config.command)
          return Response.json(result)
        },
      })
      const disposeInstall = connectionOf(connectionCtx).fetch.register({
        path: '/api/computer-use/cua-driver/install',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => new Response(runInstall(), {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      })
      return async () => {
        await disposeInstall()
        await disposeCheck()
      }
    }, 'computer-use-cua-driver-mcp.install-routes')
  })

  // Skip MCP connection when the driver is not installed; the install routes
  // above remain active for setup, and no provider slot is claimed.
  const { installed } = await checkDriver(config.command)
  if (!installed) {
    ctx.logger.warn(`computer-use-cua-driver-mcp: "${config.command}" not found in PATH; use POST /api/computer-use/cua-driver/install to set it up`)
    return
  }

  const connection = McpClient.Config({
    command: config.command,
    args: config.args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    reconnect: config.reconnect,
    transport: 'stdio',
    serverName: 'cua-driver-mcp',
    failOnStartupError: true,
  })
  // One effect orders child shutdown before release; separate fiber effects
  // unload concurrently and could otherwise admit another live driver.
  let child!: Fiber
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver-mcp'))
    child = ctx.plugin(McpClient, connection)
    yield child.dispose
  }, 'computer-use-cua-driver-mcp.connection')
  await child.await()
}
