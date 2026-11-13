/** Construction shared by supervised and pooled MCP connections. */

import { Client } from '@modelcontextprotocol/client'

/** Identity this harness reports in the MCP handshake. */
const CLIENT_INFO = Object.freeze({ name: 'dsh-mcp-client', version: '0.0.1' })

/**
 * Create an unconnected SDK client with automatic protocol negotiation.
 *
 * The client never refreshes a changed tool list on its own: `onChanged` runs
 * once per server announcement so the owning supervisor can re-sync its own
 * registrations, and a shared connection can fan the announcement out to every
 * holder.
 * @param onToolsChanged - invoked after the server announces a tool-list change.
 * @returns the unconnected client.
 */
export function createMcpClient(onToolsChanged: () => void): Client {
  return new Client(CLIENT_INFO, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
    listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: onToolsChanged } },
  })
}
