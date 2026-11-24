import type { AddressInfo } from 'node:net'

/**
 * One log line naming a background failure.
 * @param message - what failed.
 * @param error - the thrown value, which need not be an Error.
 * @returns the message followed by the failure's own text.
 */
export function failureLine(message: string, error: unknown): string {
  return `${message}: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * The endpoint a configuration selects, with the deployment defaults applied.
 * @param config - host and port as configured; either may be absent.
 * @returns the interface and port this deployment binds.
 */
export function endpointOf(config: { host?: string; port?: number }): { host: string; port: number } {
  return { host: config.host ?? '127.0.0.1', port: config.port ?? 9310 }
}

/**
 * The TCP address a listening HTTP server holds.
 * @param server - server, or any outward face exposing its bound address.
 * @returns the bound address, which carries the OS-assigned port when one was asked for.
 */
export function boundAddress(server: { address(): string | AddressInfo | null }): AddressInfo {
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('the A2A listener did not bind a TCP socket')
  }
  return address
}

/**
 * The endpoint a peer can reach for one bound address.
 * @param address - address the listener bound.
 * @returns the URL this deployment advertises for that listener.
 */
export function advertisedUrl(address: AddressInfo): string {
  const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address
  return `http://${host}:${String(address.port)}/`
}
