/**
 * Agent Plugins v1 MCP component (root `mcp.json`). Each entry becomes one
 * managed MCP server registered for the package's lifetime; an invalid entry is
 * skipped on its own, and an invalid top-level file disables MCP for that
 * package only.
 * @module @deepseek-ai/dsh-agent-plugins/mcp
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { resolveContainedOrUnusable } from './paths.ts'

/** File name of the MCP component inside an Agent Plugins v1 package. */
export const PLUGIN_MCP_FILE = 'mcp.json'

/** Canonical `$schema` value of an Agent Plugins v1 `mcp.json`. */
export const PLUGIN_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

/** Registered server names must satisfy the MCP client namespace pattern. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Request headers the MCP client owns; a package cannot override them. */
const CLIENT_OWNED_HEADERS = new Set([
  'accept',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'host',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
])

const McpEntrySchema = z.object({
  type: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

const McpFileSchema = z.object({
  $schema: z.string(),
  mcpServers: z.record(z.string(), McpEntrySchema),
})

/** One MCP server a package contributes. */
export interface AgentPluginMcpServer {
  /** Namespaced server key, already normalized to the MCP client pattern. */
  readonly serverName: string
  /** Registration entry for `ctx.mcpManager.register()`. */
  readonly registration: McpServerRegistration
}

/** Package fields used to resolve its MCP component. */
export interface AgentPluginMcpSource {
  /** Resolved package root. */
  readonly root: string
  /** Package name from the manifest. */
  readonly name: string
  /** Per-package directory exposed as `PLUGIN_DATA`. */
  readonly dataRoot: string
}

/**
 * Read the MCP component of one package.
 * @param source - package paths and name.
 * @returns one registration per valid entry; an absent, unparsable, or
 *   unsupported component yields none.
 */
export async function loadPluginMcpServers(source: AgentPluginMcpSource): Promise<AgentPluginMcpServer[]> {
  const mcpFile = await resolveContainedOrUnusable(source.root, join(source.root, PLUGIN_MCP_FILE))
  if (mcpFile === undefined) return []
  const parsed = McpFileSchema.safeParse(parseMcpJson(await readFile(mcpFile, 'utf8'), mcpFile))
  if (!parsed.success || parsed.data.$schema !== PLUGIN_MCP_SCHEMA) return []
  const servers: AgentPluginMcpServer[] = []
  for (const [entryName, entry] of Object.entries(parsed.data.mcpServers)) {
    const registration = registrationOf(entry, source)
    if (registration === undefined) continue
    servers.push({ serverName: serverKey(source.name, entryName), registration })
  }
  return servers
}

function parseMcpJson(raw: string, mcpFile: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Agent Plugins MCP file "${mcpFile}" is not valid JSON: ${String(error)}`)
  }
}

interface McpEntry {
  readonly type: string
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly cwd?: string | undefined
  readonly url?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
}

function registrationOf(entry: McpEntry, source: AgentPluginMcpSource): McpServerRegistration | undefined {
  if (entry.type === 'stdio') return stdioRegistration(entry, source)
  if (entry.type === 'streamable-http') return httpRegistration(entry)
  return undefined
}

function stdioRegistration(entry: McpEntry, source: AgentPluginMcpSource): McpServerRegistration | undefined {
  const command = expandVariables(entry.command ?? '', source).trim()
  if (command === '') return undefined
  const cwd = expandVariables(entry.cwd ?? '${PLUGIN_ROOT}', source)
  if (!isAbsolute(cwd)) return undefined
  return {
    transport: 'stdio',
    command,
    args: (entry.args ?? []).map(arg => expandVariables(arg, source)),
    env: {
      ...Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, expandVariables(value, source)])),
      PLUGIN_ROOT: source.root,
      PLUGIN_DATA: source.dataRoot,
    },
    cwd,
  }
}

function httpRegistration(entry: McpEntry): McpServerRegistration | undefined {
  const url = entry.url ?? ''
  if (!url.startsWith('http://') && !url.startsWith('https://')) return undefined
  const headers = entry.headers ?? {}
  if (Object.keys(headers).some(key => CLIENT_OWNED_HEADERS.has(key.toLowerCase()))) return undefined
  return { transport: 'streamable-http', url, headers: { ...headers } }
}

/**
 * Resolve the two portable variables a package may embed in its entries.
 * @param value - raw string from the entry.
 * @param source - package paths used for the substitution.
 * @returns the string with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` replaced.
 */
export function expandVariables(value: string, source: Pick<AgentPluginMcpSource, 'root' | 'dataRoot'>): string {
  return value
    .replaceAll('${PLUGIN_ROOT}', source.root)
    .replaceAll('${PLUGIN_DATA}', source.dataRoot)
}

/**
 * Derive the registered server key from the package and entry names.
 * @param pluginName - package name from the manifest.
 * @param entryName - key of the entry inside `mcpServers`.
 * @returns a name that satisfies the MCP client pattern; overlong names keep a
 *   stable hash suffix so two long entries cannot collide silently.
 */
export function serverKey(pluginName: string, entryName: string): string {
  const raw = `${pluginName}-${entryName}`.replaceAll(/[^A-Za-z0-9_-]/g, '-')
  if (SERVER_NAME_PATTERN.test(raw)) return raw
  return `${raw.slice(0, 23)}-${createHash('sha1').update(raw).digest('hex').slice(0, 8)}`
}
