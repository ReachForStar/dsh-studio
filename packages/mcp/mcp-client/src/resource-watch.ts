/**
 * Resource update watches for one live MCP connection generation.
 *
 * A watch subscribes to one resource URI, waits for the first
 * `notifications/resources/updated` for that URI or the resolved timeout, and
 * releases the subscription when the wait ends. Modern connections use the
 * SDK's `subscriptions/listen` stream; legacy connections use
 * `resources/subscribe`, which the SDK's era-aware client exposes separately.
 * The server must advertise `resources.subscribe` in either era.
 *
 * @module
 */

import type { Client, McpSubscription } from '@modelcontextprotocol/client'
import { describeError, McpLocalError } from './diagnostic.ts'

/** One open subscription shared by the watchers of the same URI. */
interface OpenSubscription {
  /** Watchers waiting on this URI; the last one out releases it. */
  watchers: number
  /** Modern-era listen handle; absent on a legacy connection. */
  subscription?: McpSubscription
}

/** Completion of one resource-watch wait. */
export type ResourceWatchResult = {
  /** Resource URI the watch subscribed to. */
  uri: string
  /** Whether an update notification arrived before the wait ended. */
  updated: boolean
  /** Milliseconds the watch waited for the first update. */
  waitedMs: number
}

/** Client and resolved limits for one connection generation's resource watches. */
export interface ResourceWatchOptions {
  /** Connected MCP client owned by the generation. */
  client: Client
  /** Instance label used in diagnostics, for example `mcp-client(docs)`. */
  label: string
  /** Budget for the subscribe/listen and release requests, in milliseconds. */
  requestTimeoutMs: number
  /** Wait used when the tool call omits a timeout, in milliseconds. */
  defaultWaitMs: number
  /** Ceiling applied to a tool-requested wait, in milliseconds. */
  maxWaitMs: number
}

/**
 * Resource watches owned by one connection generation. One subscription per
 * URI is shared by concurrent watchers, and subscription transitions for one
 * URI are serialized so a release cannot race a replacement subscribe. The
 * generation's transport closure ends every open subscription with it.
 */
export class ResourceWatchRegistry {
  private readonly subscriptions = new Map<string, OpenSubscription>()
  /** Serialized subscribe/release tails, keyed by URI. */
  private readonly transitions = new Map<string, Promise<void>>()
  private readonly waiters = new Set<(uri: string) => void>()
  /** Whether this generation already routed update notifications to {@link notify}. */
  private handlerRegistered = false

  /**
   * @param options - connected client, instance label, and resolved wait limits.
   */
  constructor(private readonly options: ResourceWatchOptions) {}

  /**
   * Wake every waiter whose resource received an update notification.
   * @param uri - URI carried by `notifications/resources/updated`.
   */
  notify(uri: string): void {
    for (const waiter of this.waiters) waiter(uri)
  }

  /**
   * Wait for one resource's first update or the resolved timeout.
   * @param uri - resource URI to watch.
   * @param requestedMs - tool-requested wait capped by the configured ceiling; omitted uses the configured default.
   * @param generation - generation cancellation.
   * @param caller - tool-call cancellation.
   * @returns whether an update arrived and how long the watch waited.
   * @throws when the server does not advertise resource subscriptions, the
   * subscribe request fails, the server refuses the subscription, or the
   * connection stays live but cannot release the subscription.
   */
  async watch(
    uri: string,
    requestedMs: number | undefined,
    generation: AbortSignal,
    caller: AbortSignal,
  ): Promise<ResourceWatchResult> {
    caller.throwIfAborted()
    this.assertSupported()
    const signal = AbortSignal.any([generation, caller])
    signal.throwIfAborted()
    this.routeUpdates()
    const startedAt = Date.now()
    await this.acquire(uri, generation)
    try {
      const updated = await this.wait(uri, Math.min(requestedMs ?? this.options.defaultWaitMs, this.options.maxWaitMs), signal)
      return { uri, updated, waitedMs: Date.now() - startedAt }
    } finally {
      await this.release(uri, generation, caller)
    }
  }

  /** Fail loud when the connected server cannot deliver resource updates at all. */
  private assertSupported(): void {
    if (this.options.client.getServerCapabilities()?.resources?.subscribe === true) return
    throw new McpLocalError(
      `${this.options.label}: the server does not advertise resource subscriptions (resources.subscribe)`,
    )
  }

  /** Route update notifications to {@link notify} once per generation. */
  private routeUpdates(): void {
    if (this.handlerRegistered) return
    this.options.client.setNotificationHandler('notifications/resources/updated', (notification) => {
      this.notify(notification.params.uri)
    })
    this.handlerRegistered = true
  }

  /** Join or open the shared subscription for one URI. */
  private async acquire(uri: string, generation: AbortSignal): Promise<void> {
    await this.serialize(uri, async () => {
      const existing = this.subscriptions.get(uri)
      if (existing !== undefined) {
        existing.watchers++
        return
      }
      this.subscriptions.set(uri, { watchers: 1, ...await this.open(uri, generation) })
    })
  }

  /** Open one server-side subscription for the generation's negotiated era. */
  private async open(uri: string, generation: AbortSignal): Promise<Pick<OpenSubscription, 'subscription'>> {
    const { client, label, requestTimeoutMs } = this.options
    const options = { signal: generation, timeout: requestTimeoutMs }
    if (client.getProtocolEra() !== 'modern') {
      await client.subscribeResource({ uri }, options)
      return {}
    }
    const subscription = await client.listen({ resourceSubscriptions: [uri] }, options)
    if (subscription.honoredFilter.resourceSubscriptions?.includes(uri) === true) return { subscription }
    try {
      await subscription.close()
    } catch {
      // The generation's transport close ends a listen stream that refused this filter.
    }
    throw new McpLocalError(`${label}: the server did not accept a subscription for resource "${uri}"`)
  }

  /** Leave the shared subscription, closing it when the last watcher exits. */
  private async release(uri: string, generation: AbortSignal, caller: AbortSignal): Promise<void> {
    await this.serialize(uri, async () => {
      const entry = this.subscriptions.get(uri)
      if (entry === undefined) return
      entry.watchers--
      if (entry.watchers > 0) return
      this.subscriptions.delete(uri)
      try {
        await this.close(uri, entry, generation)
      } catch (error) {
        // A closing generation ended the subscription with its transport.
        if (generation.aborted || caller.aborted) return
        throw new McpLocalError(
          `${this.options.label}: failed to release the resource subscription for "${uri}": ${describeError(error)}`,
        )
      }
    })
  }

  /** Close the exact subscription form that `open` created. */
  private async close(uri: string, entry: OpenSubscription, generation: AbortSignal): Promise<void> {
    if (entry.subscription !== undefined) {
      await entry.subscription.close()
      return
    }
    await this.options.client.unsubscribeResource(
      { uri },
      { signal: generation, timeout: this.options.requestTimeoutMs },
    )
  }

  /** Wait for a matching notification, the timeout, or cancellation. */
  private wait(uri: string, waitMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const settle = (updated: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', abort)
        resolve(updated)
      }
      const waiter = (changed: string): void => {
        if (changed === uri) settle(true)
      }
      const abort = (): void => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      }
      const timer = setTimeout(() => { settle(false) }, waitMs)
      timer.unref()
      this.waiters.add(waiter)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  /** Run one subscribe/release transition after every earlier one for the same URI. */
  private serialize(uri: string, operation: () => Promise<void>): Promise<void> {
    const run = (this.transitions.get(uri) ?? Promise.resolve()).then(operation, operation)
    const settled = run.then(() => undefined, () => undefined)
    this.transitions.set(uri, settled)
    void settled.then(() => {
      if (this.transitions.get(uri) === settled) this.transitions.delete(uri)
    })
    return run
  }
}
