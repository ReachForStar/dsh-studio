/** The two Remote calls the tree makes, each settled by hand: one deferred result per call. */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileDeletion } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { DeleteWorkspaceEntry, ListWorkspaceDirectory } from '../src/client/face.ts'
import type { DirLevel } from '../src/client/store.ts'

/** The scripted listing: the mock the face receives, and the hand that settles it. */
export interface ScriptedList {
  readonly list: Mock<ListWorkspaceDirectory>
  /**
   * Settle the oldest outstanding call and let its store write land.
   * @param result - what the endpoint answers.
   */
  readonly settle: (result: RemoteResult<DirLevel>) => Promise<void>
  /**
   * Settle the newest outstanding call first, so an older one can arrive after it.
   * @param result - what the endpoint answers.
   */
  readonly settleLatest: (result: RemoteResult<DirLevel>) => Promise<void>
  /** Paths of calls not yet settled, oldest first. */
  readonly outstanding: () => readonly string[]
}

/**
 * Build a listing whose every call stays pending until the spec settles it.
 * @returns the scripted listing.
 */
/** One listing awaiting the spec's answer. */
interface PendingList {
  readonly path: string
  resolve(result: RemoteResult<DirLevel>): void
}

export function scriptedList(): ScriptedList {
  const pending: PendingList[] = []
  const list = vi.fn<ListWorkspaceDirectory>((_sessionId, path) =>
    new Promise((resolve) => { pending.push({ path, resolve }) }))
  const land = async (call: PendingList | undefined, result: RemoteResult<DirLevel>): Promise<void> => {
    if (call === undefined) throw new Error('no outstanding listing to settle')
    call.resolve(result)
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    list,
    settle: result => land(pending.shift(), result),
    settleLatest: result => land(pending.pop(), result),
    outstanding: () => pending.map(call => call.path),
  }
}

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
