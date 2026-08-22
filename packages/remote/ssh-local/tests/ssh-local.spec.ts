/**
 * Provider behavior over a REAL in-process ssh2 server: password and key
 * authentication, foreground exec with exit codes, timeouts, and truncation,
 * the shared connection cache, and the full SFTP operation surface mapped
 * onto a temp directory.
 */

import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { SshConnectionId } from '@deepseek-ai/dsh-ssh'
import LocalSshService, { shellQuote } from '../src/index.ts'
import { TEST_SSH_PASSWORD, TEST_SSH_USERNAME, TestSshServer } from './test-server.ts'

let server: TestSshServer | undefined
let context: Context | undefined
let localRoot: string | undefined

async function startServer(): Promise<TestSshServer> {
  server = await TestSshServer.start()
  return server
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(MemorySettings)
  await ctx.plugin(LocalSshService, { defaultExecTimeoutMs: 60_000, maxExecTimeoutMs: 300_000, outputMaxBytes: 65_536 })
  return ctx
}

function saveInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const active = server!
  return {
    name: 'test-box',
    host: '127.0.0.1',
    port: active.port,
    username: TEST_SSH_USERNAME,
    auth: { kind: 'password', password: TEST_SSH_PASSWORD },
    connectTimeoutMs: 5000,
    ...overrides,
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.stop()
  server = undefined
  if (localRoot !== undefined) await rm(localRoot, { recursive: true, force: true })
  localRoot = undefined
})

const cwdSuite = process.platform === 'win32' ? describe.skip : describe

/** Windows cmd emits CRLF; normalize before comparing against POSIX fixtures. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

describe('ssh-local provider', () => {
  beforeEach(async () => {
    await startServer()
  })

  it('authenticates with a password and runs a foreground command', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    const result = await handle.exec(ctx.ssh.resolveExec({ command: 'echo hello' }))
    expect(result.exitCode).toBe(0)
    expect(normalize(result.stdout)).toBe('hello\n')
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports nonzero exits and captures stderr separately', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    const result = await handle.exec(ctx.ssh.resolveExec({ command: 'echo err 1>&2 && exit 3' }))
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('err')
    expect(result.stdout).toBe('')
  })

  it('rejects wrong credentials with the typed auth error', async () => {
    const ctx = await setup()
    await ctx.ssh.save(saveInput({ auth: { kind: 'password', password: 'wrong' } }))
    await expect(ctx.ssh.connect(SshConnectionId('test-box'))).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' })
  })

  it('authenticates with a private key file', async () => {
    const ctx = await setup()
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-key-'))
    const keyPath = join(localRoot, 'id_test')
    await writeFile(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }))
    // OpenSSH rejects group/other-readable keys; the fixture must look real.
    if (process.platform !== 'win32') await chmod(keyPath, 0o600)
    await ctx.ssh.save(saveInput({
      name: 'key-box',
      auth: { kind: 'privateKey', privateKeyPath: keyPath },
    }))
    const handle = await ctx.ssh.connect(SshConnectionId('key-box'))
    const result = await handle.exec(ctx.ssh.resolveExec({ command: 'echo keyed' }))
    expect(normalize(result.stdout)).toBe('keyed\n')
  })

  it('fails loud when the private key file is missing', async () => {
    const ctx = await setup()
    await ctx.ssh.save(saveInput({
      auth: { kind: 'privateKey', privateKeyPath: 'C:/definitely/missing/key.pem' },
    }))
    await expect(ctx.ssh.connect(SshConnectionId('test-box'))).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' })
  })

  it('kills a command that exceeds its timeout and reports timedOut', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    const result = await handle.exec(ctx.ssh.resolveExec({ command: 'node -e "setTimeout(() => {}, 10000)"', timeoutMs: 500 }))
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.timeoutMs).toBe(500)
    expect(result.durationMs).toBeLessThan(8000)
  })

  it('aborts a running command when the caller signal fires', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    const controller = new AbortController()
    const running = handle.exec(ctx.ssh.resolveExec({
      command: 'node -e "setTimeout(() => {}, 10000)"',
      timeoutMs: 30_000,
      signal: controller.signal,
    }))
    setTimeout(() => { controller.abort() }, 300)
    const result = await running
    expect(result.aborted).toBe(true)
  })

  it('truncates oversized output to its tail with the truncation flag', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    const result = await handle.exec(ctx.ssh.resolveExec({
      command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"',
    }))
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout).toHaveLength(65_536)
    expect(result.stdout.endsWith('x'.repeat(200_000).slice(-65_536))).toBe(true)
    const stderrResult = await handle.exec(ctx.ssh.resolveExec({
      command: 'node -e "process.stderr.write(\'e\'.repeat(200000))"',
    }))
    expect(stderrResult.stderrTruncated).toBe(true)
    expect(stderrResult.stderr).toHaveLength(65_536)
  })

  it('reuses the shared connection and replaces it after close', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    // Closing a never-connected id is a no-op.
    await ctx.ssh.close(saved.id)
    // Connecting an unknown id fails loud with the typed error.
    await expect(ctx.ssh.connect(SshConnectionId('missing-id'))).rejects.toMatchObject({ code: 'SSH_NOT_FOUND' })
    const first = await ctx.ssh.connect(saved.id)
    const second = await ctx.ssh.connect(saved.id)
    expect(first).toBe(second)
    await ctx.ssh.close(saved.id)
    const third = await ctx.ssh.connect(saved.id)
    expect(third).not.toBe(first)
    expect(await third.exec(ctx.ssh.resolveExec({ command: 'echo again' }))).toMatchObject({ exitCode: 0 })
  })

  it('evicts a connection dropped by the server and fails connect loud after', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await handle.exec(ctx.ssh.resolveExec({ command: 'echo up' }))
    await server!.stop()
    server = undefined
    // The dropped client evicted itself, so the next connect attempts a fresh
    // handshake and reports a connection failure rather than SSH_CLOSED.
    await expect(ctx.ssh.connect(saved.id)).rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED' })
  })

  it('closes every pooled connection at composition teardown', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    await ctx.ssh.connect(saved.id)
    const second = await ctx.ssh.save(saveInput({ name: 'second' }))
    await ctx.ssh.connect(second.id)
    const before = server!.disconnects
    await ctx.fiber.dispose()
    context = undefined
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(server!.disconnects).toBeGreaterThanOrEqual(before + 2)
  })

  it('resolves exec requests with provider defaults and caps', async () => {
    const ctx = await setup()
    expect(ctx.ssh.resolveExec({ command: 'x' })).toMatchObject({ command: 'x', timeoutMs: 60_000, outputMaxBytes: 65_536 })
    expect(ctx.ssh.resolveExec({ command: 'x', timeoutMs: 1 })).toMatchObject({ timeoutMs: 1 })
    expect(ctx.ssh.resolveExec({ command: 'x', timeoutMs: 999_999 })).toMatchObject({ timeoutMs: 300_000 })
    expect(ctx.ssh.resolveExec({ command: 'x', cwd: '/tmp' })).toMatchObject({ cwd: '/tmp' })
    expect(() => ctx.ssh.resolveExec({ command: 'x', timeoutMs: 0 })).toThrow(/positive finite/)
  })
})

describe('ssh-local sftp operations', () => {
  beforeEach(async () => {
    await startServer()
  })

  it('walks the full transfer surface: mkdir, write, list, stat, read, rename, remove', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-'))
    const upload = join(localRoot, 'payload.txt')
    await writeFile(upload, 'remote me')

    await handle.sftp.mkdir('data')
    expect((await handle.sftp.list('.')).map(entry => entry.name)).toContain('data')
    const uploaded = await handle.sftp.writeFile(upload, 'data/payload.txt')
    expect(uploaded.bytes).toBe(9)
    expect((await handle.sftp.stat('data/payload.txt')).size).toBe(9)

    const download = join(localRoot, 'downloaded.txt')
    const downloaded = await handle.sftp.readFile('data/payload.txt', download)
    expect(downloaded.bytes).toBe(9)
    expect(await readFile(download, 'utf8')).toBe('remote me')

    await handle.sftp.rename('data/payload.txt', 'data/moved.txt')
    expect((await handle.sftp.list('data')).map(entry => entry.name)).toEqual(['moved.txt'])

    await handle.sftp.remove('data/moved.txt')
    expect((await handle.sftp.list('data'))).toEqual([])
    await handle.sftp.remove('data')
  })

  it('creates missing parents with recursive mkdir', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await handle.sftp.mkdir('a/b/c', { recursive: true })
    expect((await handle.sftp.list('a/b')).map(entry => entry.name)).toEqual(['c'])
    // A second pass over an existing tree is a no-op.
    await handle.sftp.mkdir('a/b/c', { recursive: true })
  })

  it('refuses to overwrite an existing local file unless asked', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-'))
    await writeFile(join(localRoot, 'remote.txt'), 'keep me')
    await handle.sftp.writeFile(join(localRoot, 'remote.txt'), 'remote.txt')
    const existing = join(localRoot, 'existing.txt')
    await writeFile(existing, 'precious')
    await expect(handle.sftp.readFile('remote.txt', existing)).rejects.toMatchObject({ code: 'SSH_LOCAL_IO' })
    expect(await readFile(existing, 'utf8')).toBe('precious')
    const replaced = await handle.sftp.readFile('remote.txt', existing, { overwrite: true })
    expect(replaced.bytes).toBe(7)
    expect(await readFile(existing, 'utf8')).toBe('keep me')
  })

  it('removes a partial local file when a download fails mid-transfer', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-'))
    const target = join(localRoot, 'partial.txt')
    await expect(handle.sftp.readFile('missing.txt', target)).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a directory tree depth-first and refuses without recursive', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await handle.sftp.mkdir('tree/inner', { recursive: true })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-'))
    const leaf = join(localRoot, 'leaf.txt')
    await writeFile(leaf, 'leaf')
    await handle.sftp.writeFile(leaf, 'tree/inner/leaf.txt')
    await expect(handle.sftp.remove('tree')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    await handle.sftp.remove('tree', { recursive: true })
    await expect(handle.sftp.stat('tree')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
  })

  it('reports missing local upload sources with the local-io code', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await expect(handle.sftp.writeFile('C:/missing/source.txt', 'any.txt')).rejects.toMatchObject({ code: 'SSH_LOCAL_IO' })
  })

  it('fails sftp operations with typed errors on missing paths and bad parents', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await expect(handle.sftp.list('missing-dir')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-'))
    const source = join(localRoot, 'src.txt')
    await writeFile(source, 'x')
    // A small-file upload to a missing remote parent fails on the remote side.
    await expect(handle.sftp.writeFile(source, 'no-parent/file.txt')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    // mkdir of an existing directory fails loud.
    await handle.sftp.mkdir('exists')
    await expect(handle.sftp.mkdir('exists')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    // Removing or renaming a missing path fails on the remote side.
    await expect(handle.sftp.remove('missing-path')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    await expect(handle.sftp.rename('missing-from.txt', 'any.txt')).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    // A download whose local target is a directory fails with the local-io code.
    await expect(handle.sftp.readFile('exists', localRoot)).rejects.toMatchObject({ code: 'SSH_LOCAL_IO' })
    // A download whose remote source is missing fails on the remote side and
    // removes the partial local file.
    const freeTarget = join(localRoot, 'free.txt')
    await expect(handle.sftp.readFile('missing-file', freeTarget)).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    await expect(stat(freeTarget)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors a zero fast-transfer threshold (stream-only transfers)', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService, { fastTransferThresholdBytes: 0 })
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-'))
    const source = join(localRoot, 'src.txt')
    await writeFile(source, 'streamed')
    const written = await handle.sftp.writeFile(source, 'streamed.txt')
    expect(written.bytes).toBe(8)
    const target = join(localRoot, 'down.txt')
    const read = await handle.sftp.readFile('streamed.txt', target)
    expect(read.bytes).toBe(8)
    expect(await readFile(target, 'utf8')).toBe('streamed')
    // Stream-only reads surface a missing remote through the read stream and
    // clean up the partial local file.
    const missing = join(localRoot, 'missing.txt')
    await expect(handle.sftp.readFile('missing-remote.txt', missing)).rejects.toMatchObject({ code: 'SSH_SFTP_FAILED' })
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    // A local target whose parent is missing fails on the local open, not on
    // the remote side.
    await expect(handle.sftp.readFile('streamed.txt', join(localRoot, 'no-parent', 'x.txt'))).rejects.toMatchObject({ code: 'SSH_LOCAL_IO' })
    // A missing local upload source fails on the local read stream.
    await expect(handle.sftp.writeFile(join(localRoot, 'no-source.txt'), 'up.txt')).rejects.toMatchObject({ code: 'SSH_LOCAL_IO' })
  })

  it('fails sftp operations on a closed connection with SSH_CLOSED', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await ctx.ssh.close(saved.id)
    await expect(handle.sftp.list('.')).rejects.toMatchObject({ code: 'SSH_CLOSED' })
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo x' }))).rejects.toMatchObject({ code: 'SSH_CLOSED' })
  })
})

cwdSuite('ssh-local remote cwd (POSIX remote shell)', () => {
  it('prefixes a cd to the command', async () => {
    const ctx = await setup()
    await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(SshConnectionId('test-box'))
    // The provider quotes the cwd for a POSIX remote shell; the directory
    // must exist on the host, so the server's own root is the target.
    const sub = join(server!.root, 'subdir')
    await mkdir(sub)
    const result = await handle.exec(ctx.ssh.resolveExec({ command: 'pwd', cwd: sub }))
    expect(result.stdout.trim()).toBe(sub)
  })
})

describe('ssh-local host key verification and transfer performance', () => {
  beforeEach(async () => {
    await startServer()
  })

  it('remembers an unknown host key on first contact (accept-new)', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await handle.exec(ctx.ssh.resolveExec({ command: 'echo first' }))
    const hostPort = `127.0.0.1:${server!.port}`
    // The remember write is fire-and-forget by design; wait for it to land.
    const remembered = await vi.waitFor(() => ctx.ssh.knownHostFingerprint(hostPort))
    expect(remembered).toMatch(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
    // A second connection verifies against the remembered fingerprint.
    const again = await ctx.ssh.connect(saved.id)
    await expect(again.exec(ctx.ssh.resolveExec({ command: 'echo again' }))).resolves.toMatchObject({ exitCode: 0 })
  })

  it('accepts a pinned fingerprint that matches the server key', async () => {
    const ctx = await setup()
    const probe = await ctx.ssh.connect((await ctx.ssh.save(saveInput())).id)
    await probe.exec(ctx.ssh.resolveExec({ command: 'echo probe' }))
    await probe.close()
    const fingerprint = await vi.waitFor(() => ctx.ssh.knownHostFingerprint(`127.0.0.1:${server!.port}`))
    const saved = await ctx.ssh.save(saveInput({
      name: 'pinned',
      hostKeyFingerprint: fingerprint,
    }))
    const handle = await ctx.ssh.connect(saved.id)
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo ok' }))).resolves.toMatchObject({ exitCode: 0 })
  })

  it('rejects a pinned fingerprint that does not match', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput({
      hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    }))
    await expect(ctx.ssh.connect(saved.id)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_MISMATCH' })
  })

  it('rejects a changed key against the remembered fingerprint', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await handle.exec(ctx.ssh.resolveExec({ command: 'echo seed' }))
    // A different fingerprint is now remembered; the server's real key no
    // longer matches it.
    await ctx.ssh.rememberHostKey(`127.0.0.1:${server!.port}`, 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=')
    await ctx.ssh.close(saved.id)
    await expect(ctx.ssh.connect(saved.id)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_MISMATCH' })
  })

  it('rejects an unknown host key under strictHostKey: reject', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService, { strictHostKey: 'reject' })
    await ctx.ssh.save(saveInput())
    await expect(ctx.ssh.connect(SshConnectionId('test-box'))).rejects.toMatchObject({ code: 'SSH_HOST_KEY_UNKNOWN' })
  })

  it('connects with the modern algorithm set (no legacy fallbacks)', async () => {
    const ctx = await setup()
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo algo' }))).resolves.toMatchObject({ exitCode: 0 })
  })

  it('rejects a too-open private key on POSIX hosts', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const ctx = await setup()
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-key-'))
    const loosePath = join(localRoot, 'id_loose')
    await writeFile(loosePath, privateKey.export({ type: 'pkcs1', format: 'pem' }))
    await chmod(loosePath, 0o644)
    await ctx.ssh.save(saveInput({ name: 'loose', auth: { kind: 'privateKey', privateKeyPath: loosePath } }))
    if (process.platform === 'win32') return // Windows ACLs are not checked
    await expect(ctx.ssh.connect(SshConnectionId('loose'))).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' })
    const strictPath = join(localRoot, 'id_strict')
    await writeFile(strictPath, privateKey.export({ type: 'pkcs1', format: 'pem' }))
    await chmod(strictPath, 0o600)
    await ctx.ssh.save(saveInput({ name: 'strict', auth: { kind: 'privateKey', privateKeyPath: strictPath } }))
    const handle = await ctx.ssh.connect(SshConnectionId('strict'))
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo ok' }))).resolves.toMatchObject({ exitCode: 0 })
  })

  it('transfers large files through the parallel fastGet/fastPut path', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService, { fastTransferThresholdBytes: 1024 })
    const saved = await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(saved.id)
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-fast-'))
    const big = 'y'.repeat(200_000)
    const upload = join(localRoot, 'big.txt')
    await writeFile(upload, big)
    const uploaded = await handle.sftp.writeFile(upload, 'big.txt')
    expect(uploaded.bytes).toBe(200_000)
    const download = join(localRoot, 'big-down.txt')
    const downloaded = await handle.sftp.readFile('big.txt', download)
    expect(downloaded.bytes).toBe(200_000)
    expect(await readFile(download, 'utf8')).toBe(big)
    // The small-path overwrite guard still applies.
    await expect(handle.sftp.readFile('big.txt', download)).rejects.toMatchObject({ code: 'SSH_LOCAL_IO' })
    await expect(handle.sftp.readFile('big.txt', download, { overwrite: true })).resolves.toMatchObject({ bytes: 200_000 })
  }, 15_000)
})

describe('ssh-local provider configuration', () => {
  beforeEach(async () => {
    await startServer()
  })

  it('quotes remote cwd paths for a POSIX shell', () => {
    expect(shellQuote('/plain/path')).toBe("'/plain/path'")
    expect(shellQuote("/it's/sneaky")).toBe("'/it'\\''s/sneaky'")
  })

  it('applies every config default when none is supplied', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService)
    await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(SshConnectionId('test-box'))
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo ok' }))).resolves.toMatchObject({ exitCode: 0 })
  })

  it('rejects a config whose exec cap is below its default', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await expect(ctx.plugin(LocalSshService, {
      defaultExecTimeoutMs: 100_000,
      maxExecTimeoutMs: 50_000,
    })).rejects.toThrow(/maxExecTimeoutMs must be >= defaultExecTimeoutMs/)
  })

  it('connects with legacy algorithms and a keep-alive interval', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService, { allowLegacyAlgorithms: true, keepaliveIntervalMs: 5000 })
    await ctx.ssh.save(saveInput())
    const handle = await ctx.ssh.connect(SshConnectionId('test-box'))
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo legacy' }))).resolves.toMatchObject({ exitCode: 0 })
  })

  it('authenticates with an encrypted private key and passphrase', async () => {
    const ctx = await setup()
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-key-'))
    const keyPath = join(localRoot, 'id_encrypted')
    await writeFile(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'key-pass' }))
    if (process.platform !== 'win32') await chmod(keyPath, 0o600)
    await ctx.ssh.save(saveInput({
      name: 'encrypted',
      auth: { kind: 'privateKey', privateKeyPath: keyPath, passphrase: 'key-pass' },
    }))
    const handle = await ctx.ssh.connect(SshConnectionId('encrypted'))
    await expect(handle.exec(ctx.ssh.resolveExec({ command: 'echo keyed' }))).resolves.toMatchObject({ exitCode: 0 })
  })
})
