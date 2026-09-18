/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `load` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Client Remote face: the tree keys
 * every level by absolute path and hands the endpoint that same absolute path;
 * the endpoint answers with the directory's workspace-relative path as well,
 * which the tree has no use for and drops.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileDeletion } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './paths.ts'
import type { DirLevel, createFilesStore } from './store.ts'

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * One deletion, bound to a Remote face.
 *
 * The endpoint takes the same session-scoped scope as a listing, so a path
 * means the same entry here as it does in the tree that listed it.
 */
export type DeleteWorkspaceEntry = (
  sessionId: SessionId,
  path: string,
  recursive: boolean,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileDeletion>>

/**
 * The slice of the Client Remote face this package calls: the
 * `workspaceFiles` namespace's `list` and `delete`, exactly as the Host's
 * generated client declares them.
 */
export type WorkspaceFilesTreeRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'delete'>
}

/** The listing half of the tree's Remote slice. */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/** The deletion half of the tree's Remote slice. */
export type WorkspaceFilesDeleteRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'delete'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying `workspaceFiles.list`.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/**
 * Bind the deletion to one Remote face, passing the directory flag the endpoint
 * needs to take a directory's contents with it.
 * @param remote - the Client Remote face carrying `workspaceFiles.delete`.
 * @returns the deletion the tree's face performs.
 */
export function createDelete(remote: WorkspaceFilesDeleteRemote): DeleteWorkspaceEntry {
  return (sessionId, path, recursive, signal) => remote.workspaceFiles.delete(sessionId, path, { recursive }, signal)
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, listing it the first time it opens.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param loaded - whether this level already has state.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, path: string, loaded: boolean, signal: AbortSignal) => void
  /**
   * Delete one listed entry, then re-list the level it came from.
   *
   * The confirmation dialog is the one caller that reads this result: every
   * other writer reports through the store.
   * @param tabId - the tab being drawn.
   * @param parent - absolute path of the directory the entry was listed in.
   * @param name - the entry's basename.
   * @param recursive - whether a directory is deleted with its contents.
   * @param signal - the tab record's lifetime.
   * @returns the failure to carry into the dialog, or null once the entry is gone.
   */
  readonly deleteEntry: (
    tabId: TabId,
    parent: string,
    name: string,
    recursive: boolean,
    signal: AbortSignal,
  ) => Promise<RemoteFailure | null>
}

/**
 * Bind the tree's face to one directory listing and one deletion.
 * @param list - the bound `workspaceFiles.list` call.
 * @param removeEntry - the bound `workspaceFiles.delete` call.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  removeEntry: DeleteWorkspaceEntry,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = (tabId: TabId, path: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      void list(sessionId, path, signal).then((result) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
      })
    }
    return {
      start(tabId, root, signal) {
        actions.start(tabId, root)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        load(tabId, root, signal)
      },
      load,
      toggle(tabId, path, loaded, signal) {
        actions.toggled(tabId, path)
        if (!loaded) load(tabId, path, signal)
      },
      deleteEntry(tabId, parent, name, recursive, signal) {
        // A record that already ended has no dialog left to answer: the tab is
        // unmounted and its bucket forgotten, so there is nothing to report.
        if (signal.aborted) return Promise.resolve(null)
        return removeEntry(sessionId, childPath(parent, name), recursive, signal).then((result) => {
          if (!result.ok) return result.error
          actions.removed(tabId, parent, name)
          // The listing is the Host's, so the dropped row is confirmed against
          // the directory itself: another writer may have changed it meanwhile.
          load(tabId, parent, signal)
          return null
        })
      },
    }
  }
}
