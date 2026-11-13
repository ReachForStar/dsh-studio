/** Session export command and Host-owned ZIP download and Markdown copy routes. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'
import { formatSessionMarkdown } from './markdown.ts'
import { importSessionLogZip, SessionLogImportError } from './importer.ts'
import { SESSION_LOG_EXPORT_PATH, SESSION_LOG_IMPORT_PATH, SESSION_MARKDOWN_EXPORT_PATH } from './routes.ts'

export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'
export { formatSessionMarkdown } from './markdown.ts'
export {
  importSessionLogZip,
  SessionLogImportError,
} from './importer.ts'
export type {
  SessionLogImportDeps,
  SessionLogImportErrorCode,
  SessionLogImportOptions,
  SessionLogImportResult,
} from './importer.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

export { SESSION_LOG_EXPORT_PATH, SESSION_LOG_IMPORT_PATH } from './routes.ts'

/** Largest Session-log ZIP accepted by the import route. */
export const DEFAULT_SESSION_LOG_IMPORT_MAX_BYTES = 256 * 1024 * 1024

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
  /** Largest accepted import archive in bytes. @default 268435456 */
  readonly maxImportBytes?: number
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
  maxImportBytes: Schema.number().step(1).min(1).default(DEFAULT_SESSION_LOG_IMPORT_MAX_BYTES),
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the `/export` command and authenticated ZIP download and Markdown copy routes.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-session-log-export'),
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
  connectionOf(ctx).fetch.register({
    path: SESSION_MARKDOWN_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionMarkdownResponse(ctx, request)
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_IMPORT_PATH,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async request => sessionLogImportResponse(
      ctx,
      request,
      config.maxImportBytes ?? DEFAULT_SESSION_LOG_IMPORT_MAX_BYTES,
    ),
  })
}

/**
 * Accept one exported Session-log ZIP and create the Sessions it contains.
 * @param ctx - host context carrying Connection, persistence, and attachments.
 * @param request - authenticated POST whose body is the archive.
 * @param maxBytes - largest accepted archive size.
 * @returns the created root id as JSON, or a sanitized status.
 */
async function sessionLogImportResponse(ctx: Context, request: Request, maxBytes: number): Promise<Response> {
  const sessionPersistence = ctx.get('sessionPersistence')
  const attachments = ctx.get('attachments')
  if (sessionPersistence === undefined || attachments === undefined) {
    return new Response('session log import is unavailable: missing session-persistence or attachments service', { status: 500 })
  }
  let archive: Uint8Array
  try {
    archive = await readBoundedBody(request, maxBytes)
  } catch (error: unknown) {
    if (error instanceof SessionLogImportError) return new Response(error.message, { status: 413 })
    request.signal.throwIfAborted()
    return new Response('session log import failed to read the request body', { status: 400 })
  }
  try {
    const result = await importSessionLogZip({ sessionPersistence, attachments }, archive, {
      signal: request.signal,
    })
    return Response.json({ rootSessionId: result.rootSessionId }, { status: 201 })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    if (error instanceof SessionLogImportError) return new Response(error.message, { status: 400 })
    // Storage and provider failures stay opaque: the message may carry absolute host paths.
    return new Response('session log import failed', { status: 500 })
  }
}

/** Read one request body, refusing to accumulate more than `maxBytes`. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new SessionLogImportError('TOO_LARGE', `the archive exceeds the ${maxBytes}-byte import limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const archive = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }
  return archive
}



function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

/**
 * Produce one complete Session transcript as Markdown from one Session
 * observation. The read is a detached export observation through
 * session-query's live-preferred corpus, so it creates no Agent, retains no
 * Session, and writes no Session data. The formatter reads the latest title from
 * the same event snapshot as the body. Abort is observed before and after the
 * read; the corpus read itself has no cancellation parameter.
 * @param ctx - host context carrying Connection and session-query.
 * @param request - authenticated Fetch request with a required `sessionId` query.
 * @returns the Markdown response, or a sanitized status for invalid, missing, or unavailable reads.
 */
async function sessionMarkdownResponse(ctx: Context, request: Request): Promise<Response> {
  const sessionIdValue = new URL(request.url).searchParams.get('sessionId')
  if (sessionIdValue === null || sessionIdValue.length === 0) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined) {
    return new Response('session markdown export is unavailable: missing session-query service', { status: 500 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  try {
    request.signal.throwIfAborted()
    const snapshot = await sessionQuery.readSession(sessionId)
    request.signal.throwIfAborted()
    const metadata = await ctx.get('sessionPersistence')?.stat(sessionId, { signal: request.signal })
    request.signal.throwIfAborted()
    return new Response(formatSessionMarkdown(snapshot.events, metadata?.location?.path), {
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    // Absence is session-query's decision: match its stable error code rather
    // than adding a Host value dependency on the session-query error class.
    if (isSessionNotFound(error)) return new Response('session not found', { status: 404 })
    // Every other failure stays opaque: the message may carry absolute host
    // paths into the browser toast.
    return new Response('session markdown export failed to read the stored log', { status: 500 })
  }
}

/**
 * Identify the session-query "not found" failure by its stable machine code.
 * @param error - an arbitrary rejection from the query service.
 * @returns whether the error reports a missing Session.
 */
function isSessionNotFound(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      request.signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}
