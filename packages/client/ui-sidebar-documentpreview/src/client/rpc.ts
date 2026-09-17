/**
 * The paged read this type performs, bound to the Client Remote.
 *
 * Content is the consumer's business: the `file` resource carries metadata only,
 * and the text arrives here one page of lines at a time. The endpoint takes a
 * session and a workspace path while a tab carries a `dsh-resource://file/`
 * session address, so this module also owns that translation.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileBytes, WorkspaceFileRange, WorkspaceFileStat, WorkspaceFileText } from '@deepseek-ai/dsh-api-workspace-files/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** The slice of the Client Remote this package calls. */
export interface WorkspaceFilesReadRemote {
  readonly workspaceFiles: {
    /**
     * Read one page of lines.
     * @param sessionId - the session whose workspace resolves `path`.
     * @param path - workspace path, absolute or relative to the workspace root.
     * @param range - 1-based start line; the Host's page cap applies when `limit` is absent.
     * @param signal - cancels the call.
     * @returns the page, or the failure the Host declares.
     */
    read(
      sessionId: SessionId,
      path: string,
      range: WorkspaceFileRange,
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileText>>
    /**
     * Replace one file's complete text.
     * @param sessionId - the session whose workspace resolves `path`.
     * @param path - workspace path, absolute or relative to the workspace root.
     * @param text - the complete next content.
     * @param guard - the version the editor read, so a newer file is not overwritten.
     * @param signal - cancels the call.
     * @returns the file's identity and the version this write produced.
     */
    write(
      sessionId: SessionId,
      path: string,
      text: string,
      guard: { expectedVersion?: string },
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileStat>>
    /**
     * Replace one file's complete bytes.
     * @param sessionId - the session whose workspace resolves `path`.
     * @param path - workspace path, absolute or relative to the workspace root.
     * @param data - the complete next content, base64 encoded.
     * @param guard - the version the editor read, so a newer file is not overwritten.
     * @param signal - cancels the call.
     * @returns the file's identity and the version this write produced.
     */
    writeBytes(
      sessionId: SessionId,
      path: string,
      data: string,
      guard: { expectedVersion?: string },
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileStat>>
  }
}

/**
 * The read one page performs, injected so the face stays host-free.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different files in different sessions. A
 * Remote call does not reject: the result carries the failure.
 */
export type ReadWorkspaceFilePage = (
  sessionId: SessionId,
  path: string,
  offset: number,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileText>>

/** The file one tab reads: the session the read runs under and the path handed to the Host. */
export interface SessionFile {
  /** The Session whose workspace resolves relative paths. */
  readonly sessionId: SessionId
  /** The path the Host receives, absolute or relative to the addressed Session's workspace. */
  readonly path: string
}

/**
 * The session and path one `dsh-resource://file/…` address names.
 *
 * A `session` address names its own session and a relative or absolute path, so
 * a tab addressed into another session reads from that session. An `absolute`
 * address carries no session and cannot be read here. The registry routes only
 * session-scoped `file` addresses to this type, so an address `parseFileAddress`
 * rejects or that carries no session is a programming error and throws.
 * @param address - a tab's `dsh-resource://file/…` address.
 * @returns the session and the path to hand the endpoint.
 */
export function hostFileOf(address: string): SessionFile {
  const parsed = parseFileAddress(address)
  if (parsed?.scope !== 'session') throw new Error(`ui-sidebar-documentpreview: not a session file address "${address}"`)
  // The address is a string boundary: its id segment is the Session id it names.
  return { sessionId: parsed.sessionId as SessionId, path: parsed.path }
}

/**
 * Bind the paged read to one Remote face. The page length is the Host's
 * configured cap, so no `limit` travels.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @returns the read the face performs.
 */
export function createReadPage(remote: WorkspaceFilesReadRemote): ReadWorkspaceFilePage {
  return (sessionId, path, offset, signal) => remote.workspaceFiles.read(sessionId, path, { offset }, signal)
}

/**
 * Write one complete text through the Host endpoint. The version the editor
 * read travels as the guard, so a write based on stale content is refused
 * instead of silently discarding another writer's change.
 * @param file - Session and path decoded from the tab address.
 * @param text - the complete next content.
 * @param expectedVersion - version the editor read, when it read one.
 * @param signal - owning tab lifetime.
 * @returns the committed file's identity and version, including declared failures.
 */
export type WriteWorkspaceFile = (
  file: SessionFile,
  text: string,
  expectedVersion: string | undefined,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileStat>>

/**
 * Bind the complete-text write to one Remote face.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @returns the write the editor performs.
 */
export function createWriteFile(remote: WorkspaceFilesReadRemote): WriteWorkspaceFile {
  return (file, text, expectedVersion, signal) => remote.workspaceFiles.write(
    file.sessionId,
    file.path,
    text,
    expectedVersion === undefined ? {} : { expectedVersion },
    signal,
  )
}

/**
 * Write one complete byte array through the Host endpoint, for formats the
 * browser cannot express as text: an edited office document is still a zip.
 * @param file - Session and path decoded from the tab address.
 * @param data - the complete next content.
 * @param expectedVersion - version the editor read, when it read one.
 * @param signal - owning tab lifetime.
 * @returns the committed file's identity and version, including declared failures.
 */
export type WriteWorkspaceFileBytes = (
  file: SessionFile,
  data: Uint8Array,
  expectedVersion: string | undefined,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileStat>>

/**
 * Bind the complete-byte write to one Remote face. The bytes travel base64,
 * exactly as a byte read returns them.
 * @param remote - the Client Remote carrying the `workspaceFiles` namespace.
 * @returns the write a binary editor performs.
 */
export function createWriteFileBytes(remote: WorkspaceFilesReadRemote): WriteWorkspaceFileBytes {
  return (file, data, expectedVersion, signal) => remote.workspaceFiles.writeBytes(
    file.sessionId,
    file.path,
    bytesToBase64(data),
    expectedVersion === undefined ? {} : { expectedVersion },
    signal,
  )
}

/** Encode bytes for the wire without spreading a large array into an argument list. */
function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Complete document bytes borrowed read-only by renderers; copy before transferring to a Worker. */
export type DocumentFileBytes = Omit<WorkspaceFileBytes, 'data'> & { readonly data: Uint8Array<ArrayBuffer> }

/**
 * Read a complete file through the Host endpoint.
 * @param file - Session and path decoded from the tab address.
 * @param signal - owning tab lifetime.
 * @returns complete wire bytes, including declared failures.
 */
export type ReadDocumentBytes = (file: SessionFile, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileBytes>>

/**
 * Decode one successful Remote byte result for document renderers.
 * @param file - Host byte result with base64 data.
 * @returns the same metadata with native bytes; malformed base64 throws.
 */
export function documentFileBytes(file: WorkspaceFileBytes): DocumentFileBytes {
  return { ...file, data: Uint8Array.from(atob(file.data), character => character.charCodeAt(0)) }
}
