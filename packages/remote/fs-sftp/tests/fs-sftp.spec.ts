/**
 * SftpFileSystem over a REAL in-process ssh2 server (SFTP subsystem mapped
 * onto a temp directory, exec through the local shell). Remote paths are
 * POSIX absolute strings rooted at the server root (`/` maps to the temp
 * directory), so the suite is POSIX-shell-bound and skips on Windows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import LocalSshService from '@reachforstar/dsh-ssh-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import { SftpFileSystem } from '../src/index.ts'
import { TEST_SSH_PASSWORD, TEST_SSH_USERNAME, TestSshServer } from '../../ssh-local/tests/test-server.ts'

const posixSuite = process.platform === 'win32' ? describe.skip : describe

/** One booted provider + its remote (test-server-root) file helpers. */
interface RemoteFs {
  fs: SftpFileSystem
  /** Write one file under the SFTP root (the "remote disk"). */
  remoteWrite: (rel: string, content: string | Uint8Array) => Promise<void>
  remoteExists: (rel: string) => Promise<boolean>
  remoteRead: (rel: string) => Promise<string>
  dispose: () => Promise<void>
}

async function boot(mode: SandboxMode, workspaceRoot: string = '/ws'): Promise<RemoteFs> {
  const server = await TestSshServer.start()
  await mkdir(join(server.root, 'ws'), { recursive: true })
  await mkdir(join(server.root, 'tmp'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(LocalSshService, { defaultExecTimeoutMs: 60_000, maxExecTimeoutMs: 300_000, outputMaxBytes: 65_536 })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot })
  const saved = await ctx.sshSftp.save({
    name: 'sftp-box',
    host: '127.0.0.1',
    port: server.port,
    username: TEST_SSH_USERNAME,
    auth: { kind: 'password', password: TEST_SSH_PASSWORD },
    connectTimeoutMs: 5000,
  })
  const fiber = await ctx.plugin(SftpFileSystem, { connection: saved.name, cwd: '/' })
  const fs = ctx.fs as SftpFileSystem
  return {
    fs,
    remoteWrite: async (rel, content) => {
      const path = join(server.root, ...rel.split('/'))
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    },
    remoteExists: async (rel) => {
      try {
        await stat(join(server.root, ...rel.split('/')))
        return true
      } catch {
        return false
      }
    },
    remoteRead: rel => readFile(join(server.root, ...rel.split('/')), 'utf8'),
    dispose: async () => {
      await fiber.dispose()
      await server.stop()
    },
  }
}

posixSuite('sftp filesystem provider', () => {
  let remote: RemoteFs

  beforeEach(async () => {
    remote = await boot('workspace-write')
  })

  afterEach(async () => {
    await remote.dispose()
  })

  it('resolves existing and missing paths to the remote identity', async () => {
    await remote.remoteWrite('ws/a.txt', 'hello')
    const existing = await remote.fs.resolve('ws/a.txt')
    expect(existing.displayPath).toBe('/ws/a.txt')
    expect(String(existing.targetKey)).toBe('/ws/a.txt')
    const missing = await remote.fs.resolve('ws/new/deep.txt')
    expect(String(missing.targetKey)).toBe('/ws/new/deep.txt')
  })

  it('resolves a path whose parent segment is a file as missing', async () => {
    await remote.remoteWrite('ws/blocker', 'not a directory')
    await expect(remote.fs.resolve('ws/blocker/child.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('stats files, directories, and missing paths', async () => {
    await remote.remoteWrite('ws/a.txt', '12345')
    const file = await remote.fs.stat(await remote.fs.resolve('ws/a.txt'))
    expect(file).toMatchObject({ type: 'file', size: 5 })
    expect(typeof file?.version).toBe('string')
    const dir = await remote.fs.stat(await remote.fs.resolve('ws'))
    expect(dir?.type).toBe('directory')
    expect(await remote.fs.stat(await remote.fs.resolve('ws/nope.txt'))).toBeUndefined()
  })

  it('reads text and rejects binary content', async () => {
    await remote.remoteWrite('ws/t.txt', 'line one\nline two')
    expect(await remote.fs.readText(await remote.fs.resolve('ws/t.txt'))).toBe('line one\nline two')
    await remote.remoteWrite('ws/b.bin', Buffer.from([0, 1, 2, 3]))
    await expect(remote.fs.readText(await remote.fs.resolve('ws/b.bin'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('reads bytes with a size limit and byte ranges', async () => {
    await remote.remoteWrite('ws/data.bin', Buffer.from('abcdefghij'))
    const target = await remote.fs.resolve('ws/data.bin')
    const full = Buffer.from(await remote.fs.readBytes(target, undefined, 1024))
    expect(full.toString('utf8')).toBe('abcdefghij')
    await expect(remote.fs.readBytes(target, undefined, 4)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const range = Buffer.from(await remote.fs.readByteRange(target, { offset: 2, length: 3 }))
    expect(range.toString('utf8')).toBe('cde')
  })

  it('lists directory children in stable name order with metadata', async () => {
    await remote.remoteWrite('ws/b.txt', 'bb')
    await remote.remoteWrite('ws/a.txt', 'a')
    await remote.remoteWrite('ws/sub/x.txt', 'x')
    const entries = await remote.fs.listDir(await remote.fs.resolve('ws'))
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'b.txt', 'sub'])
    const a = entries.find(entry => entry.name === 'a.txt')
    expect(a).toMatchObject({ type: 'file', size: 1 })
    expect(a?.target.targetKey).toBe(FsTargetKey('/ws/a.txt'))
    expect(entries.find(entry => entry.name === 'sub')?.type).toBe('directory')
    await expect(remote.fs.listDir(await remote.fs.resolve('ws/a.txt'))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    await expect(remote.fs.listDir(await remote.fs.resolve('ws/nope'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('writes text with create/update outcomes and a diff basis', async () => {
    const create = await remote.fs.writeText(await remote.fs.resolve('ws/w.txt'), 'first')
    expect(create.operation).toBe('create')
    expect(create.before).toBeNull()
    expect(create.after).toBe('first')
    expect(await remote.remoteRead('ws/w.txt')).toBe('first')
    const update = await remote.fs.writeText(await remote.fs.resolve('ws/w.txt'), 'second')
    expect(update.operation).toBe('update')
    expect(update.before).toBe('first')
    expect(update.after).toBe('second')
  })

  it('enforces replaceIfVersion staleness', async () => {
    await remote.remoteWrite('ws/v.txt', 'v1')
    const target = await remote.fs.resolve('ws/v.txt')
    const version = (await remote.fs.stat(target))!.version
    await expect(remote.fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version: '0:0:0' as FsVersion }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    // Re-read the version AFTER an out-of-band change; the guard must reject.
    await remote.remoteWrite('ws/v.txt', 'v1.5')
    await expect(remote.fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('enforces createIfAbsent against an existing file', async () => {
    await remote.remoteWrite('ws/c.txt', 'existing')
    await expect(remote.fs.writeText(await remote.fs.resolve('ws/c.txt'), 'new', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    const created = await remote.fs.writeText(await remote.fs.resolve('ws/c2.txt'), 'new', { kind: 'createIfAbsent' })
    expect(created.operation).toBe('create')
  })

  it('writes bytes through the SFTP temp-file + rename publish', async () => {
    const outcome = await remote.fs.writeBytes(await remote.fs.resolve('ws/bin.bin'), Uint8Array.from([1, 2, 3, 0, 254]))
    expect(outcome.operation).toBe('create')
    const back = Buffer.from(await remote.fs.readBytes(await remote.fs.resolve('ws/bin.bin'), undefined, 1024))
    expect([...back]).toEqual([1, 2, 3, 0, 254])
  })

  it('edits literal text with a version guard and line-ending preservation', async () => {
    await remote.remoteWrite('ws/e.txt', 'alpha\r\nbeta\r\n')
    const target = await remote.fs.resolve('ws/e.txt')
    const version = (await remote.fs.stat(target))!.version
    await expect(remote.fs.editText(target, { oldString: 'alpha', newString: 'gamma', replaceAll: false }, { version: 'bogus' as FsVersion }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    const outcome = await remote.fs.editText(target, { oldString: 'alpha', newString: 'gamma', replaceAll: false }, { version })
    expect(outcome.before).toBe('alpha\nbeta\n')
    expect(outcome.after).toBe('gamma\nbeta\n')
    expect(await remote.remoteRead('ws/e.txt')).toBe('gamma\r\nbeta\r\n')
  })

  it('denies writes outside the writable roots under workspace-write', async () => {
    await expect(remote.fs.writeText(await remote.fs.resolve('/else.txt'), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(remote.fs.writeText(await remote.fs.resolve('/ws/..'), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await remote.remoteExists('else.txt')).toBe(false)
    await expect(remote.fs.writeText(await remote.fs.resolve('/tmp/temp.txt'), 't')).resolves.toMatchObject({ operation: 'create' })
    expect(await remote.remoteExists('tmp/temp.txt')).toBe(true)
  })

  it('denies every mutation under read-only but allows reads', async () => {
    const ro = await boot('read-only')
    try {
      await ro.remoteWrite('ws/r.txt', 'keep')
      expect(await ro.fs.readText(await ro.fs.resolve('ws/r.txt'))).toBe('keep')
      await expect(ro.fs.writeText(await ro.fs.resolve('ws/d.txt'), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(ro.fs.writeBytes(await ro.fs.resolve('ws/d.bin'), Uint8Array.from([1]))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(ro.fs.editText(await ro.fs.resolve('ws/r.txt'), { oldString: 'keep', newString: 'x', replaceAll: false }))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally {
      await ro.dispose()
    }
  })

  it('passes every mutation through under danger-full-access', async () => {
    const full = await boot('danger-full-access')
    try {
      await expect(full.fs.writeText(await full.fs.resolve('/else2.txt'), 'y')).resolves.toMatchObject({ operation: 'create' })
    } finally {
      await full.dispose()
    }
  })

  it('reports the deployment default mode through the capability fact', async () => {
    expect(remote.fs.sandboxMode).toBe('workspace-write')
  })

  it('resolves through the shell probe when both worlds agree, and falls back when they diverge', async () => {
    // /proc exists on the real local fs the test server's exec runs in: seed
    // the SFTP world with the same path so the probe answer verifies.
    await remote.remoteWrite('proc/1/self', 'x')
    const agreed = await remote.fs.resolve('/proc')
    expect(String(agreed.targetKey)).toBe('/proc')
    // A real-fs path absent from the SFTP world: the probe answer must be
    // rejected and the lexical identity kept.
    const diverged = await remote.fs.resolve('/bin')
    expect(String(diverged.targetKey)).toBe('/bin')
    expect(await remote.fs.stat(diverged)).toBeUndefined()
  })

  it('rejects an empty path and a resolve abort', async () => {
    await expect(remote.fs.resolve('')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const abort = new AbortController()
    abort.abort()
    await expect(remote.fs.resolve('ws/a.txt', { signal: abort.signal })).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('resolves through the sandboxed write fence without a temp-file residue', async () => {
    await remote.fs.writeText(await remote.fs.resolve('ws/res.txt'), 'res')
    const stray = (await remote.fs.listDir(await remote.fs.resolve('ws')))
      .filter(entry => entry.name.includes('.tmp'))
    expect(stray).toEqual([])
  })
})
