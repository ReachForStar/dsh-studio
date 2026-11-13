/**
 * Shared MCP connections, held by a Cordis service.
 *
 * Each instance still owns its supervisor, reconnect budget, tool
 * registrations, status cell, and resource watches; only the transport and its
 * handshake are shared. A lease joins the connection already open under the
 * same {@link poolKey}, or opens it, and every holder releases independently —
 * the last release closes the transport. A shared handshake that fails marks
 * its key unshareable for the life of the process: the failing instance and
 * every later one connect on their own, exactly as they would without a pool.
 *
 * The pool never reconnects. Holders observe the connection closing through
 * their lease and run their own backoff, so two holders of one configuration
 * each retry on their own schedule and rejoin a fresh connection.
 *
 * @module @deepseek-ai/dsh-mcp-client/pool
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Client, OAuthClientProvider } from '@modelcontextprotocol/client'
import { createMcpClient } from './client.ts'
import { describeError } from './diagnostic.ts'
import { McpGeneration } from './generation.ts'
import type { Config } from './index.ts'
import { poolKey } from './pool-key.ts'
import type { McpCloseResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared MCP connections; present only when the composition mounts this plugin. */
    mcpPool: McpPool
  }
}

/** One holder's view of a shared connection. */
export interface McpLease {
  /** Connected SDK client shared by every holder of this connection. */
  readonly client: Client
  /**
   * Observe the shared connection closing.
   * @param callback - invoked once when the transport closes or the pool disposes.
   * @returns the disposer removing this observer.
   */
  onClose(callback: () => void): () => void
  /**
   * Observe a server tool-list change.
   * @param callback - invoked for each announcement while this lease is held.
   * @returns the disposer removing this observer.
   */
  onToolsChanged(callback: () => void): () => void
  /**
   * Observe a resource update notification for any URI. The shared connection
   * installs the client's notification handler and forwards each update here.
   * @param callback - invoked with the updated resource URI.
   * @returns the disposer removing this observer.
   */
  onResourceUpdated(callback: (uri: string) => void): () => void
  /**
   * Leave the shared connection. The last holder closes the transport.
   * @returns the connection's cleanup result; a non-last holder reports confirmed closure.
   */
  release(): Promise<McpCloseResult>
}

/** Options for one {@link McpPool.acquire} call. */
export interface McpAcquireOptions {
  /** Cancels this holder's wait; the connection keeps running for the other holders. */
  signal: AbortSignal
  /** Replaces expanded credential values in diagnostics. Defaults to identity. */
  redact?: (text: string) => string
  /** OAuth client the shared transport presents and refreshes tokens with. */
  authProvider?: OAuthClientProvider
}

/** Removal of one connection from the pool's table. */
interface ConnectionRegistry {
  /**
   * Stop sharing one connection.
   * @param connection - the connection to forget.
   */
  forget(connection: SharedConnection): void
}

/** One holder's callbacks on a shared connection. */
interface Holder {
  readonly close: Set<() => void>
  readonly tools: Set<() => void>
  readonly resources: Set<(uri: string) => void>
}

/**
 * Add one callback to a holder set.
 * @param callbacks - the holder's callback set.
 * @param callback - the callback to add.
 * @returns the disposer removing it.
 */
function observe<T>(callbacks: Set<T>, callback: T): () => void {
  callbacks.add(callback)
  return () => { callbacks.delete(callback) }
}

/** One transport and handshake shared by the holders registered right now. */
class SharedConnection {
  readonly client: Client
  readonly wire: McpGeneration
  readonly holders = new Set<Holder>()
  readonly settled: Promise<void>
  /** Whether the transport already closed; a lease registered afterwards replays the notice. */
  closed = false

  /**
   * Open the connection; {@link settled} reports the handshake.
   * @param registry - owner that forgets this connection when it closes.
   * @param key - sharing key computed by {@link poolKey}.
   * @param config - resolved configuration the connection dials.
   * @param redact - diagnostic filter for expanded credential values.
   * @param authProvider - OAuth client the transport presents and refreshes tokens with.
   */
  constructor(
    private readonly registry: ConnectionRegistry,
    readonly key: string,
    config: Config,
    redact: (text: string) => string,
    authProvider?: OAuthClientProvider,
  ) {
    this.client = createMcpClient(() => { this.toolsChanged() })
    this.client.onclose = () => { this.drop() }
    this.client.setNotificationHandler('notifications/resources/updated', (notification) => {
      for (const holder of [...this.holders]) {
        for (const callback of [...holder.resources]) callback(notification.params.uri)
      }
    })
    this.wire = new McpGeneration(this.client, config.closeTimeoutMs, error => redact(describeError(error)))
    this.settled = this.wire.connect(config, config.startupTimeoutMs, authProvider)
  }

  /**
   * Announce a tool-list change to every holder.
   */
  toolsChanged(): void {
    for (const holder of [...this.holders]) for (const callback of [...holder.tools]) callback()
  }

  /**
   * Leave this connection, closing it when no holder remains.
   * @param holder - the releasing holder.
   * @returns the cleanup result of the shared transport.
   */
  async release(holder: Holder): Promise<McpCloseResult> {
    this.holders.delete(holder)
    if (this.holders.size > 0) return { closeConfirmed: true }
    this.registry.forget(this)
    return this.wire.close()
  }

  /** The transport closed: stop sharing it and tell every holder. */
  private drop(): void {
    if (this.closed) return
    this.closed = true
    this.registry.forget(this)
    void this.wire.close()
    for (const holder of [...this.holders]) for (const callback of [...holder.close]) callback()
  }
}

/**
 * Shared MCP connections. Mount this plugin once per composition; every
 * `dsh-mcp-client` instance reads it through `ctx.get('mcpPool')` and connects
 * on its own when the service is absent.
 */
export default class McpPool extends Service {
  private readonly connections = new Map<string, SharedConnection>()
  /** Keys whose shared handshake failed. Kept for the life of the process. */
  private readonly unpoolable = new Set<string>()
  private readonly registry: ConnectionRegistry = {
    forget: (connection) => {
      if (this.connections.get(connection.key) === connection) this.connections.delete(connection.key)
    },
  }

  /**
   * @param ctx - composition context that owns the shared connections.
   */
  constructor(ctx: Context) {
    super(ctx, 'mcpPool')
  }

  /**
   * Join or open the connection for one resolved configuration.
   *
   * The returned lease keeps the connection open until `release()`. A failed
   * shared handshake rejects this call, logs once, and stops sharing that key;
   * callers then connect on their own. Cancelling `options.signal` removes only
   * this holder's wait.
   * @param config - configuration after credential expansion.
   * @param options - cancellation for this wait and the diagnostic filter.
   * @returns the lease, or `undefined` when this configuration is not shared.
   */
  async acquire(config: Config, options: McpAcquireOptions): Promise<McpLease | undefined> {
    const key = poolKey(config)
    if (this.unpoolable.has(key)) return undefined
    options.signal.throwIfAborted()
    let connection = this.connections.get(key)
    if (connection === undefined) {
      try {
        connection = new SharedConnection(this.registry, key, config, options.redact ?? (text => text), options.authProvider)
      } catch (error) {
        this.unpoolable.add(key)
        this.logFailure(config.serverName, error, options.redact)
        throw error
      }
      this.connections.set(key, connection)
      // A connection whose last holder leaves during the handshake rejects
      // without a waiter; settle that here so it cannot surface as unhandled.
      void connection.settled.catch(() => {})
    }
    const holder: Holder = { close: new Set(), tools: new Set(), resources: new Set() }
    connection.holders.add(holder)
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('MCP pool wait aborted'))
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([connection.settled, aborted.promise])
    } catch (error) {
      connection.holders.delete(holder)
      if (connection.holders.size === 0) {
        this.registry.forget(connection)
        void connection.wire.close()
      }
      if (!options.signal.aborted) {
        this.unpoolable.add(key)
        this.logFailure(config.serverName, error, options.redact)
      }
      throw error
    } finally {
      options.signal.removeEventListener('abort', onAbort)
    }
    return {
      client: connection.client,
      onClose: (callback) => {
        // A close that landed before this lease existed still reaches the holder.
        if (connection.closed) {
          callback()
          return () => {}
        }
        return observe(holder.close, callback)
      },
      onToolsChanged: callback => observe(holder.tools, callback),
      onResourceUpdated: callback => observe(holder.resources, callback),
      release: () => connection.release(holder),
    }
  }

  /**
   * Close every shared connection when the service is disposed. Holders observe
   * their lease closing and reconnect on their own.
   */
  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    yield async () => {
      const connections = [...this.connections.values()]
      this.connections.clear()
      await Promise.all(connections.map(connection => connection.wire.close()))
    }
  }

  /** Report a failed shared handshake once, without expanded credential values. */
  private logFailure(server: string, error: unknown, redact?: (text: string) => string): void {
    const text = (redact ?? (value => value))(describeError(error))
    this.ctx.logger.warn(`mcp-pool(${server}): shared connection failed; this and later instances connect privately: ${text}`)
  }
}
