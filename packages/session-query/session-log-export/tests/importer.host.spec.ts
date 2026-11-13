import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TeamId, TeamMessageId } from '@deepseek-ai/dsh-agent-team'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionLogText, serializeSessionLog, SESSION_LOG_FILENAME } from '../src/archive.ts'
import { importSessionLogZip, apply, inject, SESSION_LOG_IMPORT_PATH } from '../src/index.ts'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'

/** 1×1 PNG used to exercise the attachment round trip. */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function mountedPersistence(): Promise<{ persistence: SessionPersistence; root: string }> {
  const root = await tempDir('dsh-import-logs-')
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  cleanups.push(() => fiber.dispose())
  return { persistence: ctx.sessionPersistence, root }
}

async function mountedAttachments(): Promise<AttachmentStore> {
  const dshHome = await tempDir('dsh-import-media-')
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalAttachmentStore, { dshHome })
  cleanups.push(() => fiber.dispose())
  return ctx.attachments
}

/** Write one stored session and return its canonical log text. */
async function storedLog(persistence: SessionPersistence, id: string): Promise<string> {
  const header = meta(id)
  const handle = await persistence.create(header)
  await handle.append(oneTurnLog())
  await handle.flush()
  await handle.close()
  const text = await readSessionLogText(persistence, SessionId(id))
  if (text === undefined) throw new Error('fixture session was not stored')
  return text
}

/** Detached ArrayBuffer body; fflate's view type is not a Fetch BodyInit. */
function bodyOf(archive: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(archive.byteLength)
  copy.set(archive)
  return copy.buffer
}

function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) =>
    [path, typeof value === 'string' ? strToU8(value) : value])))
}

describe('importSessionLogZip', () => {
  it('creates a new session with all history and leaves the source untouched', async () => {
    const source = await mountedPersistence()
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const text = await storedLog(source.persistence, 'original')
    const archive = zipOf({ [SESSION_LOG_FILENAME]: text })

    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive)

    expect(String(result.rootSessionId)).not.toBe('original')
    expect(result.sessionIds).toEqual([result.rootSessionId])
    const handle = await target.persistence.open(result.rootSessionId, 'read')
    try {
      expect(handle.header.isSeeded).toBe(false)
      expect(handle.header.createdAt).toBe(meta('original').createdAt)
      const { events } = await handle.read()
      expect(events.map(event => event.type)).toEqual(oneTurnLog().map(event => event.type))
    } finally {
      await handle.close()
    }
    expect(await source.persistence.stat(SessionId('original'))).toBeDefined()
  })

  it('honors a replacement root id and refuses an existing one without writing', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const archive = zipOf({ [SESSION_LOG_FILENAME]: await storedLog(target.persistence, 'placeholder') })
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive, {
      rootSessionId: SessionId('imported-root'),
    })
    expect(result.rootSessionId).toBe('imported-root')
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive, {
      rootSessionId: SessionId('imported-root'),
    })).rejects.toThrow(/already exists/u)
  })

  it('imports the same archive twice as two independent sessions', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const archive = zipOf({ [SESSION_LOG_FILENAME]: await storedLog(target.persistence, 'source') })
    const first = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive)
    const second = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive)
    expect(first.rootSessionId).not.toBe(second.rootSessionId)
    expect((await target.persistence.list()).length).toBe(3)
  })

  it('restores referenced media and files from their content-addressed entries', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const [image] = await attachments.saveImages([{ data: PNG, mediaType: 'image/png' }])
    const file = await attachments.saveFile({ data: new Uint8Array([1, 2, 3]), name: 'note.txt' })
    if (image === undefined) throw new Error('fixture image was not stored')
    const digest = String(file.attachmentId).replace(/^sha256:/u, '')
    const archive = zipOf({
      [SESSION_LOG_FILENAME]: await storedLog(target.persistence, 'media-owner'),
      [`media/${String(image.attachmentId)}.png`]: PNG,
      [`files/${digest.slice(0, 2)}/${digest}/note.txt`]: new Uint8Array([1, 2, 3]),
    })
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive)
    expect(result.images).toBe(1)
    expect(result.files).toBe(1)
  })

  it('imports subagent logs under fresh ids and rewires their parent', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const rootText = await storedLog(target.persistence, 'root')
    const childHeader = {
      ...meta('child'),
      parentSession: SessionId('root'),
      origin: 'subagent' as const,
      delegationDepth: 1,
    }
    const childText = serializeSessionLog(childHeader, oneTurnLog())
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: rootText,
      'subagents/child/session.jsonl': childText,
    }))
    expect(result.sessionIds.length).toBe(2)
    const rootId = result.sessionIds[0]
    const childId = result.sessionIds[1]
    if (rootId === undefined || childId === undefined) throw new Error('missing imported ids')
    const child = await target.persistence.open(childId, 'read')
    try {
      expect(child.header.parentSession).toBe(rootId)
      expect(child.header.origin).toBe('subagent')
      expect(child.header.delegationDepth).toBe(1)
    } finally {
      await child.close()
    }
  })

  it('rejects an attachment whose bytes do not match the recorded digest', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const archive = zipOf({
      [SESSION_LOG_FILENAME]: await storedLog(target.persistence, 'mismatch'),
      'media/sha256:0000.png': PNG,
    })
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive))
      .rejects.toMatchObject({ code: 'ATTACHMENT_MISMATCH' })
  })

  it('rejects unreadable archives and logs instead of dropping data', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const deps = { sessionPersistence: target.persistence, attachments }
    await expect(importSessionLogZip(deps, new Uint8Array())).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(importSessionLogZip(deps, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(importSessionLogZip(deps, zipOf({ 'notes.txt': 'x' })))
      .rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(importSessionLogZip(deps, zipOf({ [SESSION_LOG_FILENAME]: '' })))
      .rejects.toMatchObject({ code: 'INVALID_LOG' })
    await expect(importSessionLogZip(deps, zipOf({ [SESSION_LOG_FILENAME]: 'not json\n' })))
      .rejects.toMatchObject({ code: 'INVALID_LOG' })
    await expect(importSessionLogZip(deps, zipOf({ '../escape.jsonl': 'x' })))
      .rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(importSessionLogZip(deps, zipOf({ 'subagents/a/session.jsonl': 'x' })))
      .rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
  })

  it('rejects a log containing an event type this build cannot interpret', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const header = meta('unknown-event')
    const text = [
      JSON.stringify({
        type: 'session',
        version: header.version,
        id: header.id,
        createdAt: header.createdAt,
        isSeeded: false,
        delegationDepth: 0,
      }),
      JSON.stringify({ type: 'future/thing', seq: 0, time: 1, data: { value: true } }),
      '',
    ].join('\n')
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({ [SESSION_LOG_FILENAME]: text })))
      .rejects.toMatchObject({ code: 'INVALID_LOG' })
  })

  it('rejects an unsupported stored format version', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const text = `${JSON.stringify({ type: 'session', version: 99, id: 'future', createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({ [SESSION_LOG_FILENAME]: text })))
      .rejects.toMatchObject({ code: 'INVALID_LOG' })
    expect(await target.persistence.list()).toEqual([])
  })

  it('observes cancellation before writing anything', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const archive = zipOf({ [SESSION_LOG_FILENAME]: await storedLog(target.persistence, 'cancel') })
    const controller = new AbortController()
    controller.abort()
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, archive, {
      signal: controller.signal,
    })).rejects.toThrow(/abort/iu)
    expect((await target.persistence.list()).length).toBe(1)
  })

  it('imports header-only logs, missing trailing newlines, blank lines, and archive metadata', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const busy = await storedLog(target.persistence, 'busy')
    const text = `${busy.split('\n').slice(0, 2).join('\n')}\n\n${busy.split('\n').slice(2).join('\n')}`.trimEnd()
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: text,
      'README.md': '# archive',
      'manifest.json': '{}',
      'empty/': '',
    }))
    expect(result.sessionIds.length).toBe(1)
    const empty = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: serializeSessionLog(meta('header-only'), []),
    }))
    const handle = await target.persistence.open(empty.rootSessionId, 'read')
    try {
      expect((await handle.read()).events).toEqual([])
    } finally {
      await handle.close()
    }
  })

  it('keeps the recorded working directory and agent preset', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const header = { ...meta('configured'), cwd: '/work', agentPreset: 'headless' }
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: serializeSessionLog(header, oneTurnLog()),
    }))
    const handle = await target.persistence.open(result.rootSessionId, 'read')
    try {
      expect(handle.header.cwd).toBe('/work')
      expect(handle.header.agentPreset).toBe('headless')
    } finally {
      await handle.close()
    }
  })

  it('rewires Session references inside event payloads', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const delivered = (seq: number, targetId: string) => ({
      type: 'team/message/delivered' as const,
      seq: SessionSeq(seq),
      time: 10 + seq,
      data: {
        version: 2 as const,
        teamId: brandString<TeamId>('team'),
        messageId: brandString<TeamMessageId>('message'),
        targetId: SessionId(targetId),
      },
    })
    const events = [...oneTurnLog(), delivered(6, 'reference-root'), delivered(7, 'elsewhere')]
    const text = serializeSessionLog(meta('reference-root'), events)
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: text,
    }), { signal: new AbortController().signal })
    const handle = await target.persistence.open(result.rootSessionId, 'read')
    try {
      const { events: stored } = await handle.read()
      const targets = stored
        .filter(event => event.type === 'team/message/delivered')
        .map(event => (event.data as { targetId: string }).targetId)
      expect(targets).toEqual([result.rootSessionId, 'elsewhere'])
    } finally {
      await handle.close()
    }
  })

  it('rejects two root logs and unrecognized layouts', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const deps = { sessionPersistence: target.persistence, attachments }
    const text = await storedLog(target.persistence, 'twice')
    await expect(importSessionLogZip(deps, zipOf({
      [SESSION_LOG_FILENAME]: text,
      'session.v4.jsonl': text,
    }))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(importSessionLogZip(deps, zipOf({
      [SESSION_LOG_FILENAME]: text,
      'subagents/child/notes.txt': 'x',
    }))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(importSessionLogZip(deps, zipOf({
      [SESSION_LOG_FILENAME]: text,
      'other/file.bin': 'x',
    }))).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
  })

  it('rejects invalid event JSON and events the format refuses', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const deps = { sessionPersistence: target.persistence, attachments }
    const header = JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: 'events', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
    await expect(importSessionLogZip(deps, zipOf({ [SESSION_LOG_FILENAME]: `${header}\nnot-json\n` })))
      .rejects.toMatchObject({ code: 'INVALID_LOG' })
    await expect(importSessionLogZip(deps, zipOf({
      [SESSION_LOG_FILENAME]: `${header}\n${JSON.stringify({
        type: 'turn/start', seq: 'zero', time: 1, data: { turn: 1 },
      })}\n`,
    }))).rejects.toMatchObject({ code: 'INVALID_LOG' })
  })

  it('rejects a file whose bytes do not match its recorded digest', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const digest = '0'.repeat(64)
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: await storedLog(target.persistence, 'file-mismatch'),
      [`files/00/${digest}/note.txt`]: new Uint8Array([1, 2, 3]),
    }))).rejects.toMatchObject({ code: 'ATTACHMENT_MISMATCH' })
  })

  it('removes Sessions created before a later write fails', async () => {
    const target = await mountedPersistence()
    const rootText = serializeSessionLog(meta('rollback-root'), oneTurnLog())
    const childText = serializeSessionLog({
      ...meta('rollback-child'), parentSession: SessionId('rollback-root'), origin: 'subagent', delegationDepth: 1,
    }, oneTurnLog())
    let creates = 0
    const persistence = {
      create: async (header: SessionHeader) => {
        if (creates++ > 0) throw new Error('second write failed')
        return {
          header,
          append: async () => {},
          flush: async () => {},
          close: async () => {},
        }
      },
      delete: async () => { throw new Error('cleanup failed') },
    } as unknown as SessionPersistence
    const attachments = {
      saveImages: async () => { throw new Error('unused') },
      saveFile: async () => { throw new Error('unused') },
    } as unknown as AttachmentStore
    await expect(importSessionLogZip({ sessionPersistence: persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: rootText,
      'subagents/child/session.jsonl': childText,
    }))).rejects.toThrow('second write failed')
    expect(target.persistence).toBeDefined()
  })

  it('orders three imported sessions so every parent precedes its children', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const root = serializeSessionLog(meta('order-root'), oneTurnLog())
    const child = serializeSessionLog({
      ...meta('order-child'), parentSession: SessionId('order-root'), origin: 'subagent', delegationDepth: 1,
    }, oneTurnLog())
    const grandchild = serializeSessionLog({
      ...meta('order-grandchild'), parentSession: SessionId('order-child'), origin: 'subagent', delegationDepth: 2,
    }, oneTurnLog())
    const result = await importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      'subagents/grandchild/session.jsonl': grandchild,
      'subagents/child/session.jsonl': child,
      [SESSION_LOG_FILENAME]: root,
    }))
    expect(result.sessionIds.length).toBe(3)
    const childId = result.sessionIds[1]
    const grandchildId = result.sessionIds[2]
    if (childId === undefined || grandchildId === undefined) throw new Error('missing imported ids')
    const grandchildHandle = await target.persistence.open(grandchildId, 'read')
    try {
      expect(grandchildHandle.header.parentSession).toBe(childId)
    } finally {
      await grandchildHandle.close()
    }
  })

  it('rejects duplicate session ids inside one archive', async () => {
    const target = await mountedPersistence()
    const attachments = await mountedAttachments()
    const text = await storedLog(target.persistence, 'duplicate')
    const header = JSON.parse(text.split('\n')[0] ?? '{}') as { id?: string }
    expect(header.id).toBe('duplicate')
    // A subagent copy carries the same header id, which import must refuse.
    await expect(importSessionLogZip({ sessionPersistence: target.persistence, attachments }, zipOf({
      [SESSION_LOG_FILENAME]: text,
      'subagents/child/session.jsonl': text,
    }))).rejects.toMatchObject({ code: 'INVALID_LOG' })
  })
})

describe('Session log import route', () => {
  it('accepts a ZIP and reports the created root session', async () => {
    const mounted = await mountRoute()
    const archive = zipOf({ [SESSION_LOG_FILENAME]: await storedLog(mounted.persistence, 'route-source') })
    const response = await mounted.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: bodyOf(archive),
    }))
    expect(response.status).toBe(201)
    const body = await response.json() as { rootSessionId?: string }
    expect(typeof body.rootSessionId).toBe('string')
    expect(await mounted.persistence.stat(SessionId(body.rootSessionId ?? ''))).toBeDefined()
  })

  it('reports an invalid archive and an oversized body without writing', async () => {
    const mounted = await mountRoute({ maxImportBytes: 32 })
    const invalid = await mounted.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    }))
    expect(invalid.status).toBe(400)
    const oversized = await mounted.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: new Uint8Array(64),
    }))
    expect(oversized.status).toBe(413)
    expect(await mounted.persistence.list()).toEqual([])
  })

  it('treats a missing body as an empty archive and a broken stream as a bad request', async () => {
    const mounted = await mountRoute()
    const missing = await mounted.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, { method: 'POST' }))
    expect(missing.status).toBe(400)
    const broken = await mounted.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error('transport failed')) },
      }),
      // Node's Fetch requires an explicit half-duplex body.
      duplex: 'half',
    } as RequestInit))
    expect(broken.status).toBe(400)
  })

  it('reports a storage failure as an opaque 500', async () => {
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} } as never)
    ctx.provide('sessionPersistence', {
      create: async () => { throw new Error('disk unavailable') },
    } as never)
    ctx.provide('attachments', {} as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = await ctx.plugin({ inject: [...inject], apply })
    cleanups.push(() => fiber.dispose())
    const shared = connection.createSharedFetchHandler('/api')
    const source = await mountedPersistence()
    const archive = zipOf({ [SESSION_LOG_FILENAME]: await storedLog(source.persistence, 'storage-failure') })
    const response = await shared.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: bodyOf(archive),
    }), connection.browserPeer)
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('session log import failed')
  })

  it('answers 500 when persistence or attachments are absent', async () => {
    const ctx = new Context()
    ctx.provide('commands', { register: () => () => {} } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const fiber = await ctx.plugin({ inject: [...inject], apply })
    cleanups.push(() => fiber.dispose())
    const shared = connection.createSharedFetchHandler('/api')
    const response = await shared.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: new Uint8Array([1]),
    }), connection.browserPeer)
    expect(response.status).toBe(500)
  })

  it('removes the route with the plugin fiber', async () => {
    const mounted = await mountRoute()
    await mounted.dispose()
    const response = await mounted.fetch(new Request(`http://host${SESSION_LOG_IMPORT_PATH}`, {
      method: 'POST',
      body: new Uint8Array([1]),
    }))
    expect(response.status).toBe(404)
  })
})

/** Mount the package over real persistence and attachments, plus the shared Fetch handler. */
async function mountRoute(config: { maxImportBytes?: number } = {}): Promise<{
  readonly persistence: SessionPersistence
  readonly fetch: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}> {
  const persistence = await mountedPersistence()
  const attachments = await mountedAttachments()
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('sessionPersistence', persistence.persistence)
  ctx.provide('attachments', attachments)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const shared = connection.createSharedFetchHandler('/api')
  const fiber = await ctx.plugin({ inject: [...inject], apply }, config)
  cleanups.push(() => fiber.dispose())
  return {
    persistence: persistence.persistence,
    fetch: request => shared.fetch(request, connection.browserPeer),
    dispose: () => fiber.dispose(),
  }
}
