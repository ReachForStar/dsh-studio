/** The tree's deletion call, settled by hand so the dialog's in-flight state is observable. */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileDeletion } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { DeleteWorkspaceEntry } from '../src/client/face.ts'

/** The scripted deletion: the mock the face receives, and the hand that settles it. */
export interface ScriptedDelete {
  readonly remove: Mock<DeleteWorkspaceEntry>
  /**
   * Settle the oldest outstanding call and let its store writes land.
   * @param result - what the endpoint answers.
   */
  readonly settle: (result: RemoteResult<WorkspaceFileDeletion>) => Promise<void>
  /** One call's arguments, oldest first. */
  readonly calls: () => readonly { path: string; recursive: boolean }[]
  /** Paths of calls not yet settled, oldest first. */
  readonly outstanding: () => readonly string[]
}

/** One removal awaiting the spec's answer. */
interface PendingDelete {
  readonly path: string
  resolve(result: RemoteResult<WorkspaceFileDeletion>): void
}

/**
 * Build a deletion whose every call stays pending until the spec settles it, so
 * the dialog's in-flight state is observable.
 * @returns the scripted deletion.
 */
export function scriptedDelete(): ScriptedDelete {
  const pending: PendingDelete[] = []
  const calls: { path: string; recursive: boolean }[] = []
  const remove = vi.fn<DeleteWorkspaceEntry>((_sessionId, path, recursive) =>
    new Promise((resolve) => {
      calls.push({ path, recursive })
      pending.push({ path, resolve })
    }))
  return {
    remove,
    settle: async (result) => {
      const call = pending.shift()
      if (call === undefined) throw new Error('no outstanding deletion to settle')
      call.resolve(result)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    calls: () => calls,
    outstanding: () => pending.map(call => call.path),
  }
}
