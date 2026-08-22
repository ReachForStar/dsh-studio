/**
 * SSH connection-management page store: one snapshot of the saved definitions
 * served by the ssh Remote gateway. The host stays the single fact source —
 * every mutation writes through the wire and the page refreshes from the next
 * list response.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// The ssh Remote payload vocabulary is re-exported by the assembly: this is
// the one place both planes legitimately meet, so the page never imports a
// Host package.
import type {
  SshRemoteDefinition,
  SshRemoteSaveRequest,
  SshRemoteTestResult,
} from '@deepseek-ai/dsh-api-remotes/client'

/** The wire face of the ssh Remote gateway. */
export interface SshRemoteFace {
  list(): Promise<{ connections: SshRemoteDefinition[] }>
  save(request: SshRemoteSaveRequest): Promise<SshRemoteDefinition>
  remove(id: string): Promise<{ removed: boolean }>
  test(id: string): Promise<SshRemoteTestResult>
}

/** Page snapshot. */
export interface SshConnectionsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  connections: readonly SshRemoteDefinition[]
}

/**
 * Human text for a rejected wire call.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The connection-management controller (one per settings surface). */
export class SshConnectionsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<SshConnectionsState> = createSnapshotStore<SshConnectionsState>({
    status: 'idle',
    error: null,
    connections: [],
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0
  /** Disposed controllers refuse further loads. */
  private disposed = false

  constructor(private readonly remote: SshRemoteFace) {}

  /** Refresh the whole page snapshot from the gateway. */
  async load(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const response = await this.remote.list()
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.connections = response.connections
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Save one definition through the wire, then refresh the list.
   * @param request - the validated editor payload (secrets write-only).
   * @returns the saved definition.
   */
  async save(request: SshRemoteSaveRequest): Promise<SshRemoteDefinition> {
    const saved = await this.remote.save(request)
    await this.load()
    return saved
  }

  /**
   * Remove one definition through the wire, then refresh the list.
   * @param id - the connection id to remove.
   */
  async remove(id: string): Promise<void> {
    await this.remote.remove(id)
    await this.load()
  }

  /**
   * Probe one connection; the outcome is the result, never a throw.
   * @param id - the connection id to probe.
   * @returns the probe outcome.
   */
  test(id: string): Promise<SshRemoteTestResult> {
    return this.remote.test(id)
  }

  /** Drop the controller and its store (HMR-safe teardown). */
  dispose(): void {
    this.generation += 1
    this.disposed = true
  }
}
