/**
 * Host-side Session-log import: turn one exported ZIP back into stored
 * Sessions. The archive carries canonical JSONL logs (root and subagents),
 * content-addressed media, and verbatim files. Import validates every log
 * through the installed format catalog, rejects rather than drops events this
 * build cannot interpret, assigns fresh Session ids, restores attachments
 * whose digests still match the log references, and writes all Sessions
 * through the mounted persistence service. A conflict or mid-way failure
 * removes the Sessions created by this call; content-addressed attachment
 * objects may remain, unreferenced.
 * @module @deepseek-ai/dsh-session-log-export/import
 */

import { randomUUID } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { brandString } from '@deepseek-ai/dsh-brand'
import { adoptSessionEvent, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** Stable failure codes callers may map to protocol statuses. */
export type SessionLogImportErrorCode =
  | 'INVALID_ARCHIVE'
  | 'INVALID_LOG'
  | 'TOO_LARGE'
  | 'ATTACHMENT_MISMATCH'
  | 'SESSION_CONFLICT'

/** One rejected import, with a message safe to show a user. */
export class SessionLogImportError extends Error {
  constructor(readonly code: SessionLogImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionLogImportError'
  }
}

/** Services an import needs. */
export interface SessionLogImportDeps {
  readonly sessionPersistence: SessionPersistence
  readonly attachments: AttachmentStore
}

/** Options for one import. */
export interface SessionLogImportOptions {
  /** Replacement id for the root Session; defaults to a fresh id. */
  readonly rootSessionId?: SessionId
  /** Cancellation observed between storage operations. */
  readonly signal?: AbortSignal
}

/** One completed import. */
export interface SessionLogImportResult {
  /** The newly created root Session. */
  readonly rootSessionId: SessionId
  /** Every created Session, root first. */
  readonly sessionIds: readonly SessionId[]
  /** Media objects restored from the archive. */
  readonly images: number
  /** Verbatim files restored from the archive. */
  readonly files: number
}

/** Current-generation and historical log filenames accepted at either archive depth. */
const LOG_FILENAME = /^session(?:\.v\d+)?\.jsonl$/
/** Subagent log member: one directory segment below `subagents/`, then a log filename. */
const SUBAGENT_LOG = /^subagents\/[^/]+\/session(?:\.v\d+)?\.jsonl$/
/** Media entries are content-addressed by attachment id, which may contain a scheme colon. */
const MEDIA_ENTRY = /^media\/(.+)\.(png|jpg|webp|gif)$/
/** File entries preserve the store's digest fan-out and leaf name. */
const FILE_ENTRY = /^files\/[^/]+\/([a-f0-9]{64})\/([^/]+)$/
/** Event payload fields that name a Session; values are remapped to the imported ids. */
const SESSION_REFERENCE_KEYS = new Set(['sessionId', 'parentSessionId', 'targetId', 'childId'])
/** Extension to declared media type for restored images. */
const MEDIA_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

interface ParsedLog {
  readonly oldId: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  /** Delegation depth from the stored header; ordering creates parents first. */
  readonly depth: number
}

/** One recognized archive member. */
type ArchiveMember =
  | { readonly kind: 'root' | 'subagent'; readonly path: string; readonly data: Uint8Array }
  | {
    readonly kind: 'media'
    readonly path: string
    readonly data: Uint8Array
    readonly attachmentId: string
    readonly mediaType: ImageMediaType
  }
  | { readonly kind: 'file'; readonly path: string; readonly data: Uint8Array; readonly digest: string; readonly name: string }

/** One decoded archive log paired with its member. */
interface ParsedEntry {
  readonly member: Extract<ArchiveMember, { kind: 'root' | 'subagent' }>
  readonly log: ParsedLog
}

/**
 * Import one exported Session-log ZIP.
 * @param deps - mounted persistence and attachment services.
 * @param archive - the archive bytes.
 * @param options - optional root id replacement and cancellation.
 * @returns the created Session ids and restored attachment counts.
 * @throws {SessionLogImportError} for unreadable archives, uninterpretable logs, or attachment digest drift.
 * @throws {SessionAlreadyExistsError} when a replacement root id already exists.
 */
export async function importSessionLogZip(
  deps: SessionLogImportDeps,
  archive: Uint8Array,
  options: SessionLogImportOptions = {},
): Promise<SessionLogImportResult> {
  options.signal?.throwIfAborted()
  const members = readArchive(archive)
  const logs = members.filter((member): member is Extract<ArchiveMember, { kind: 'root' | 'subagent' }> =>
    member.kind === 'root' || member.kind === 'subagent')
  const roots = logs.filter(member => member.kind === 'root')
  if (roots.length !== 1) {
    throw new SessionLogImportError('INVALID_ARCHIVE', roots.length === 0
      ? 'the archive contains no root session log'
      : 'the archive contains more than one root session log')
  }
  const parsed: ParsedEntry[] = logs.map(member => ({ member, log: parseLog(member) }))
  const root = parsed.find(entry => entry.member.kind === 'root')
  /* v8 ignore next -- exactly one root member survived the check above. */
  if (root === undefined) throw new Error('missing root archive member')
  assertUniqueIds(parsed.map(entry => entry.log.oldId))

  const idMap = new Map<SessionId, SessionId>()
  for (const entry of parsed) {
    idMap.set(entry.log.oldId,
      entry.member.kind === 'root'
        ? options.rootSessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
        : brandString<SessionId>(`session-${randomUUID()}`))
  }

  options.signal?.throwIfAborted()
  const restored = await restoreAttachments(deps.attachments, members)
  const created: SessionId[] = []
  try {
    for (const entry of orderedForCreation(parsed)) {
      options.signal?.throwIfAborted()
      const id = idMap.get(entry.log.oldId)
      /* v8 ignore next -- every parsed log received an id above. */
      if (id === undefined) throw new Error('missing import id')
      await writeSession(deps.sessionPersistence, entry, id, idMap, options.signal)
      created.push(id)
    }
  } catch (error: unknown) {
    await removeCreated(deps.sessionPersistence, created)
    throw error
  }
  const rootId = idMap.get(root.log.oldId)
  /* v8 ignore next -- every parsed log received an id above. */
  if (rootId === undefined) throw new Error('missing imported root id')
  return {
    rootSessionId: rootId,
    sessionIds: created,
    images: restored.images,
    files: restored.files,
  }
}

/** Read and classify every archive member, rejecting unsafe or unknown paths. */
function readArchive(archive: Uint8Array): ArchiveMember[] {
  if (archive.byteLength === 0) throw new SessionLogImportError('INVALID_ARCHIVE', 'the archive is empty')
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(archive)
  } catch (error: unknown) {
    throw new SessionLogImportError('INVALID_ARCHIVE', 'the archive is not a readable ZIP file', { cause: error })
  }
  const members: ArchiveMember[] = []
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
      throw new SessionLogImportError('INVALID_ARCHIVE', `the archive contains an unsafe path: ${path}`)
    }
    if (path.endsWith('/')) continue
    const root = LOG_FILENAME.test(path)
    if (root) {
      members.push({ kind: 'root', path, data })
      continue
    }
    if (SUBAGENT_LOG.test(path)) {
      members.push({ kind: 'subagent', path, data })
      continue
    }
    const media = MEDIA_ENTRY.exec(path)
    if (media !== null && media[1] !== undefined && media[2] !== undefined) {
      const mediaType = MEDIA_TYPES[media[2]]
      /* v8 ignore next -- the expression enumerates exactly the map's keys. */
      if (mediaType === undefined) throw new SessionLogImportError('INVALID_ARCHIVE', `unsupported media entry: ${path}`)
      members.push({ kind: 'media', path, data, attachmentId: media[1], mediaType })
      continue
    }
    const file = FILE_ENTRY.exec(path)
    if (file !== null && file[1] !== undefined && file[2] !== undefined) {
      members.push({ kind: 'file', path, data, digest: file[1], name: file[2] })
      continue
    }
    if (path === 'README.md' || path === 'manifest.json') continue
    throw new SessionLogImportError('INVALID_ARCHIVE', `the archive contains an unrecognized entry: ${path}`)
  }
  return members
}

/** Decode one JSONL artifact through the installed format catalog. */
function parseLog(member: Extract<ArchiveMember, { kind: 'root' | 'subagent' }>): ParsedLog {
  const lines = strFromU8(member.data).split('\n')
  if (lines.at(-1) === '') lines.pop()
  const headerLine = lines.shift()
  if (headerLine === undefined || headerLine.length === 0) {
    throw new SessionLogImportError('INVALID_LOG', `${member.path} has no header line`)
  }
  let headerValue: unknown
  try {
    headerValue = JSON.parse(headerLine)
  } catch (error: unknown) {
    throw new SessionLogImportError('INVALID_LOG', `${member.path} starts with invalid JSON`, { cause: error })
  }
  const restore = createRestore(member.path, headerValue)
  const oldId = brandString<SessionId>(restore.header.id)
  const events: SessionEvent[] = []
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch (error: unknown) {
      throw new SessionLogImportError('INVALID_LOG', `${member.path} event ${index + 1} is not valid JSON`, { cause: error })
    }
    try {
      restore.decodeRow(row)
    } catch (error: unknown) {
      throw new SessionLogImportError('INVALID_LOG', `${member.path} event ${index + 1} is not a supported Session event: ${String(error)}`, { cause: error })
    }
  }
  let artifact: ReturnType<typeof restore.finish>
  try {
    artifact = restore.finish()
  } catch (error: unknown) {
    throw new SessionLogImportError('INVALID_LOG', `${member.path} failed format validation: ${String(error)}`, { cause: error })
  }
  // The catalog already validated every event against this build's current
  // vocabulary and message contracts; storage revalidates on append.
  for (const event of artifact.events) events.push(event as SessionEvent)
  return {
    oldId,
    header: importedHeader(artifact.header, oldId),
    events,
    depth: artifact.header.delegationDepth,
  }
}

/** Create the catalog restore for one untrusted header value. */
function createRestore(path: string, headerValue: unknown): ReturnType<typeof sessionFormatCatalog.createRestore> {
  try {
    return sessionFormatCatalog.createRestore(headerValue, { recovery: 'strict', validation: 'current' })
  } catch (error: unknown) {
    throw new SessionLogImportError('INVALID_LOG', `${path} has an unsupported Session header: ${String(error)}`, { cause: error })
  }
}

/** Header fields an import keeps; ids and lineage are assigned below. */
function importedHeader(source: ReturnType<typeof createRestore>['header'], oldId: SessionId): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: oldId,
    createdAt: source.createdAt,
    ...source.cwd === undefined ? {} : { cwd: source.cwd },
    ...source.parentSession === undefined ? {} : { parentSession: brandString<SessionId>(source.parentSession) },
    isSeeded: false,
    ...source.origin === undefined ? {} : { origin: source.origin },
    delegationDepth: source.delegationDepth,
    ...source.agentPreset === undefined ? {} : { agentPreset: source.agentPreset },
  }
}

/** Refuse duplicate source identities before any storage work. */
function assertUniqueIds(ids: readonly SessionId[]): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(String(id))) throw new SessionLogImportError('INVALID_LOG', `the archive repeats session id ${id}`)
    seen.add(String(id))
  }
}

/** Restore content-addressed attachments, verifying every digest still matches its log reference. */
async function restoreAttachments(
  attachments: AttachmentStore,
  members: readonly ArchiveMember[],
): Promise<{ readonly images: number; readonly files: number }> {
  let images = 0
  let files = 0
  for (const member of members) {
    if (member.kind === 'media') {
      const [stored] = await attachments.saveImages([{ data: member.data, mediaType: member.mediaType }])
      /* v8 ignore next -- a batch of one returns exactly one reference. */
      if (stored === undefined) throw new Error('image save returned no reference')
      if (String(stored.attachmentId) !== member.attachmentId) {
        throw new SessionLogImportError('ATTACHMENT_MISMATCH', `image ${member.attachmentId} does not match its recorded digest`)
      }
      images += 1
      continue
    }
    if (member.kind !== 'file') continue
    const stored = await attachments.saveFile({ data: member.data, name: member.name })
    if (String(stored.attachmentId) !== `sha256:${member.digest}`) {
      throw new SessionLogImportError('ATTACHMENT_MISMATCH', `file ${member.name} does not match its recorded digest`)
    }
    files += 1
  }
  return { images, files }
}

/** Write one imported log under its new id after remapping lineage and Session references. */
async function writeSession(
  persistence: SessionPersistence,
  entry: ParsedEntry,
  id: SessionId,
  idMap: ReadonlyMap<SessionId, SessionId>,
  signal?: AbortSignal,
): Promise<void> {
  const sourceParent = entry.log.header.parentSession
  const parent = sourceParent === undefined ? undefined : idMap.get(sourceParent)
  const header: SessionHeader = {
    ...entry.log.header,
    id,
    ...parent === undefined ? {} : { parentSession: parent },
  }
  const options = signal === undefined ? {} : { signal }
  const handle = await persistence.create(header, options)
  try {
    const events = entry.log.events.map(event => withRemappedReferences(event, idMap))
    if (events.length > 0) await handle.append(events, options)
    await handle.flush(options)
  } finally {
    await handle.close()
  }
}

/** Return a copy of one event whose Session-id references point at the imported ids. */
function withRemappedReferences(event: SessionEvent, idMap: ReadonlyMap<SessionId, SessionId>): SessionEvent {
  const clone = structuredClone(event)
  if (!rewriteReferences(clone.data, idMap)) return event
  return adoptSessionEvent(clone)
}

/** Replace exact Session-id references in one payload; reports whether anything changed. */
function rewriteReferences(value: unknown, idMap: ReadonlyMap<SessionId, SessionId>): boolean {
  if (Array.isArray(value)) {
    let changed = false
    for (const item of value) changed = rewriteReferences(item, idMap) || changed
    return changed
  }
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  let changed = false
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string' && SESSION_REFERENCE_KEYS.has(key)) {
      const mapped = idMap.get(brandString<SessionId>(child))
      if (mapped !== undefined) {
        record[key] = mapped
        changed = true
        continue
      }
    }
    changed = rewriteReferences(child, idMap) || changed
  }
  return changed
}

/** Remove sessions created by a failed import, newest first. */
async function removeCreated(persistence: SessionPersistence, created: readonly SessionId[]): Promise<void> {
  for (const id of [...created].reverse()) {
    try {
      await persistence.delete(id)
    } catch {
      // Cleanup must not replace the failure the caller needs to see.
    }
  }
}

/** Order logs so a parent always precedes its children. */
function orderedForCreation(entries: readonly ParsedEntry[]): ParsedEntry[] {
  return [...entries].sort((left, right) => left.member.kind === 'root' ? -1
    : right.member.kind === 'root' ? 1
      : left.log.depth - right.log.depth)
}
