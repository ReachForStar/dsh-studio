/**
 * SFTP-backed `ctx.fs` implementation over the `ctx.sshSftp` connection seam.
 * Remote targets are POSIX absolute paths; identity is the canonical (realpath)
 * path of existing files and the deepest-existing-ancestor join for missing
 * suffixes. Mutations stage a temp file in the target's directory and publish
 * it with an SFTP rename, so readers never observe a partial file.
 * @module @reachforstar/dsh-fs-sftp
 */

import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { applyLiteralEdit, createUtf8StreamDecoder, decodeUtf8, decodeUtf8Stream, detectLineEndings, isBinarySample, normalizeLineEndings, restoreLineEndings } from '@deepseek-ai/dsh-fs'
import type { LineEndings } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { SshError } from '@reachforstar/dsh-ssh'
import type { SshConnection, SshConnectionId, SshRunResult } from '@reachforstar/dsh-ssh'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion as FsVersionType,
  FsWriteBytesOutcome,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/** Configuration for the remote SFTP filesystem backend. */
export interface Config {
  /** Name or id of the saved `ctx.sshSftp` connection this backend uses. */
  connection: string
  /** Base directory (on the remote) for relative paths. */
  cwd: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, mirroring
   * `@deepseek-ai/dsh-fs-local`. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
/** Remote paths are joined lexically; the seam is POSIX-only by contract. */
const SEP = '/'

/** One SFTP entry mapped into the seam's metadata shape. */
interface SftpMeta {
  version: FsVersionType
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mode: number
}

/**
 * The seam collapses every SFTP failure into SSH_SFTP_FAILED; "missing" is
 * recognized by the server's no-such-file text (OpenSSH and the test server
 * both spell it that way), keeping permission failures visible as I/O errors.
 */
function isMissingSftpError(error: unknown): boolean {
  return error instanceof SshError
    && error.code === 'SSH_SFTP_FAILED'
    && /no such file|enoent|not a directory|enotdir/iu.test(error.message)
}

/** Map one remote stat to seam metadata (the version is mtime: size: mode). */
function metaOf(entry: { type: string; size: number; mtimeMs: number; mode: number }): SftpMeta {
  const type = entry.type === 'dir' ? 'directory' : entry.type === 'file' ? 'file' : entry.type === 'symlink' ? 'symlink' : 'other'
  return {
    version: FsVersion(`${entry.mtimeMs}:${entry.size}:${entry.mode}`),
    type,
    size: entry.size,
    mode: entry.mode,
  }
}

/**
 * The remote SFTP filesystem backend. Registers as `ctx.fs` (loading it INSTEAD
 * of `dsh-fs-sandbox`/`dsh-fs-local` is the whole swap; the model-facing tools
 * and the Web workspace-file surface are untouched). The per-call sandbox
 * fence is applied over the remote path strings (lexical containment under the
 * policy workspace root plus the remote `/tmp`).
 */
export class SftpFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    connection: z.string(),
    cwd: z.string(),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  static inject = ['sshSftp', 'sandboxPolicy']

  /** The configured fields with `diffBasisMaxBytes` resolved. */
  readonly config: Required<Config>
  /** The configured definition's id (resolved at construction; fails loud on a bad name). */
  private readonly connectionId: SshConnectionId
  /** Per-targetKey tail promise: serializes mutating ops per file. */
  private readonly locks = new Map<string, Promise<unknown>>()
  private connectionPromise: Promise<SshConnection> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, diffBasisMaxBytes: config.diffBasisMaxBytes ?? DEFAULT_DIFF_BASIS_MAX_BYTES }
    this.connectionId = ctx.sshSftp.resolve(config.connection).id
  }

  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /** The shared connection for this backend's configured definition (lazy). */
  private async connection(): Promise<SshConnection> {
    this.connectionPromise ??= this.ctx.sshSftp.connect(this.connectionId)
    return this.connectionPromise
  }

  /** Run one bounded remote probe command, mapping shell failures to FS errors. */
  private async execProbe(command: string, signal?: AbortSignal): Promise<SshRunResult> {
    const conn = await this.connection()
    const spec = this.ctx.sshSftp.resolveExec({ command, ...(signal === undefined ? {} : { signal }) })
    try {
      return await conn.exec(spec)
    } catch (error: unknown) {
      throw this.translateError(error, 'exec')
    }
  }

  /** Translate seam/ssh errors into the fs taxonomy. */
  private translateError(error: unknown, verb: string, signal?: AbortSignal): FsError {
    if (error instanceof FsError) return error
    if (signal?.aborted) {
      return new FsError(`${verb} aborted`, 'FS_ABORTED')
    }
    if (error instanceof SshError) {
      return new FsError(`${verb} failed: ${error.message}`, 'FS_IO_ERROR', { cause: error })
    }
    return new FsError(`${verb} failed: ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
  }

  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  // --- path helpers ---

  /** Lexical join of a remote base and a relative path (`..` collapsed). */
  private remotePath(cwd: string, path: string): string {
    const base = isRemoteAbsolute(cwd) ? cwd : `${SEP}${cwd}`
    const raw = isRemoteAbsolute(path) ? path : `${base}${SEP}${path}`
    return normalizeRemotePath(raw)
  }

  /**
   * Resolve a remote path to its canonical form. Existing paths realpath through
   * the remote shell; missing paths realpath the deepest existing ancestor and
   * re-append the missing suffix.
   * @param cwd - base directory for relative paths.
   * @param path - the path to resolve.
   * @param signal - aborts the round-trips.
   * @returns the canonical remote path.
   */
  private async canonical(cwd: string, path: string, signal?: AbortSignal): Promise<string> {
    const display = this.remotePath(cwd, path)
    const probe = `cd ${shellQuote(display)} 2>/dev/null && pwd -P`
    const result = await this.execProbe(probe, signal)
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      const reported = result.stdout.trim()
      // The probe runs in the connection's shell world; trust its answer only
      // when the SFTP world can see the same path (the two views are identical
      // on every real remote; exotic test mounts that diverge fall through).
      if (await this.sftpStat(reported, signal) !== undefined) return reported
    }
    // Absent: walk up to the deepest existing ancestor, canonicalize it, and
    // re-append the missing suffix (stable identity across creation).
    let ancestor = display
    const missing: string[] = []
    for (;;) {
      const stat = await this.sftpStat(ancestor, signal)
      if (stat !== undefined) {
        if (stat.type === 'file' && missing.length > 0) {
          throw new FsError(`cannot resolve "${display}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
        }
        const real = await this.execProbe(`cd ${shellQuote(ancestor)} 2>/dev/null && pwd -P`, signal)
        const base = real.exitCode === 0 && real.stdout.trim().length > 0 ? real.stdout.trim() : ancestor
        const joiner = base.endsWith(SEP) ? '' : SEP
        return missing.length > 0 ? `${base}${joiner}${missing.join(SEP)}` : base
      }
      const parent = parentOf(ancestor)
      if (parent === ancestor) return display
      missing.unshift(basename(ancestor))
      ancestor = parent
      signal?.throwIfAborted()
    }
  }

  // --- SFTP helpers ---

  private async sftpStat(path: string, signal?: AbortSignal): Promise<SftpMeta | undefined> {
    signal?.throwIfAborted()
    const conn = await this.connection()
    try {
      return metaOf(await conn.sftp.stat(path))
    } catch (error: unknown) {
      if (isMissingSftpError(error)) return undefined
      throw this.translateError(error, 'stat')
    }
  }

  // --- FileSystem interface ---

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = this.remotePath(opts?.cwd ?? this.config.cwd, path)
    const targetKey = await this.canonical(opts?.cwd ?? this.config.cwd, path, opts?.signal)
    return { targetKey: FsTargetKey(targetKey), displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file://${this.processPath(target)}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const p = this.processPath(parent)
    const c = this.processPath(child)
    if (c === p) return true
    const prefix = p.endsWith(SEP) ? p : `${p}${SEP}`
    return c.startsWith(prefix)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const meta = await this.sftpStat(this.processPath(target), signal)
    if (meta === undefined) return undefined
    return {
      version: meta.version,
      type: meta.type === 'directory' ? 'directory' : meta.type === 'file' ? 'file' : 'other',
      size: meta.size,
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const cwd = opts?.cwd ?? this.config.cwd
    const meta = await this.sftpStat(this.remotePath(cwd, path), signal)
    if (meta === undefined) return undefined
    return { version: meta.version, type: meta.type, size: meta.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.assertRegularFile(this.processPath(target), 'read', signal)
    const conn = await this.connection()
    const file = await conn.sftp.openRead(this.processPath(target)).catch((error: unknown) => {
      throw this.translateError(error, 'read', signal)
    })
    guardStream(file.stream)
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of file.stream) {
        signal?.throwIfAborted()
        // Node Readable iterators are untyped; the SFTP stream emits Buffer chunks.
        const buffer = chunk as Buffer
        bytes += buffer.length
        chunks.push(buffer)
      }
      const full = Buffer.concat(chunks, bytes)
      if (isBinarySample(full)) {
        throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
      }
      return decodeUtf8(full, 'read', target.displayPath)
    } catch (error: unknown) {
      throw this.translateError(error, 'read', signal)
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.assertRegularFile(this.processPath(target), 'read', signal)
    const conn = await this.connection()
    const file = await conn.sftp.openRead(this.processPath(target)).catch((error: unknown) => {
      throw this.translateError(error, 'read')
    })
    guardStream(file.stream)
    const decoder = createUtf8StreamDecoder()
    let sampledBytes = 0
    return (async function* (): AsyncIterable<string> {
      try {
        for await (const chunk of file.stream) {
          signal?.throwIfAborted()
          // Node Readable iterators are untyped; the SFTP stream emits Buffer chunks.
          const buffer = chunk as Buffer
          if (sampledBytes < 8192) {
            const sample = buffer.subarray(0, Math.min(buffer.length, 8192 - sampledBytes))
            if (sample.includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
            sampledBytes += sample.length
          }
          yield decodeUtf8Stream(decoder, buffer, 'read', target.displayPath)
        }
        yield decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
      } catch (error: unknown) {
        throw fsErrorFromReadError(error, signal)
      } finally {
        await file.close().catch(() => undefined)
      }
    }())
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const conn = await this.connection()
    const file = await conn.sftp.openRead(this.processPath(target), { end: maxBytes }).catch((error: unknown) => {
      throw this.translateError(error, 'read')
    })
    guardStream(file.stream)
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of file.stream) {
        signal?.throwIfAborted()
        // Node Readable iterators are untyped; the SFTP stream emits Buffer chunks.
        const buffer = chunk as Buffer
        bytes += buffer.length
        if (bytes > maxBytes) {
          throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
        }
        chunks.push(buffer)
      }
      return Buffer.concat(chunks, bytes)
    } catch (error: unknown) {
      throw fsErrorFromReadError(error, signal)
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    await this.assertRegularFile(this.processPath(target), 'read', signal)
    if (range.length === 0) return new Uint8Array(0)
    const conn = await this.connection()
    const file = await conn.sftp.openRead(this.processPath(target), {
      start: range.offset,
      end: range.offset + range.length - 1,
    }).catch((error: unknown) => {
      throw this.translateError(error, 'read')
    })
    guardStream(file.stream)
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of file.stream) {
        signal?.throwIfAborted()
        // Node Readable iterators are untyped; the SFTP stream emits Buffer chunks.
        const buffer = chunk as Buffer
        chunks.push(buffer)
        bytes += buffer.length
      }
      return Buffer.concat(chunks, bytes)
    } catch (error: unknown) {
      throw fsErrorFromReadError(error, signal)
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const path = this.processPath(target)
    const meta = await this.sftpStat(path, signal)
    if (meta === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (meta.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const conn = await this.connection()
    let entries: Array<{ name: string; type: string; size: number; mtimeMs: number; mode: number }>
    try {
      entries = await conn.sftp.list(path)
    } catch (error: unknown) {
      throw this.translateError(error, 'list')
    }
    signal?.throwIfAborted()
    const result: FsDirEntry[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted()
      const childPath = path.endsWith(SEP) ? `${path}${entry.name}` : `${path}${SEP}${entry.name}`
      const childMeta = metaOf(entry)
      result.push({
        name: entry.name,
        type: childMeta.type === 'directory' ? 'directory' : childMeta.type === 'file' ? 'file' : 'other',
        target: { targetKey: FsTargetKey(childPath), displayPath: childPath },
        version: childMeta.version,
        ...childMeta.type === 'file' ? { size: childMeta.size } : {},
      })
    }
    return result
  }

  // --- mutations ---

  /** Fence the mutation by the per-call policy over the remote path strings. */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (isRemotePathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const checked = await this.checkedTarget(target, sandboxPolicy)
      const path = this.processPath(checked)
      const existing = await this.sftpStat(path, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${checked.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined) throw new FsError(`cannot write "${checked.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${checked.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot overwrite existing "${checked.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      const before = existing !== undefined && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
        ? await this.readDiffBasis(path, this.config.diffBasisMaxBytes)
        : null
      await this.atomicWrite(path, Buffer.from(content, 'utf8'), existing?.type === 'file' ? existing.mode : undefined, expected?.kind === 'createIfAbsent', signal, checked)
      const after = await this.sftpStat(path, signal)
      return {
        operation: existing ? 'update' : 'create',
        version: after?.version ?? FsVersion(`missing:${path}`),
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteBytesOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const checked = await this.checkedTarget(target, sandboxPolicy)
      const path = this.processPath(checked)
      const existing = await this.sftpStat(path, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${checked.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined) throw new FsError(`cannot write "${checked.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${checked.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot overwrite existing "${checked.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      await this.atomicWrite(path, content, existing?.type === 'file' ? existing.mode : undefined, expected?.kind === 'createIfAbsent', signal, checked)
      const after = await this.sftpStat(path, signal)
      return { operation: existing ? 'update' : 'create', version: after?.version ?? FsVersion(`missing:${path}`) }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersionType },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const checked = await this.checkedTarget(target, sandboxPolicy)
      const path = this.processPath(checked)
      const existing = await this.sftpStat(path, signal)
      if (existing === undefined) throw new FsError(`cannot edit "${checked.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${checked.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${checked.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const conn = await this.connection()
      const file = await conn.sftp.openRead(path).catch((error: unknown) => {
        throw this.translateError(error, 'edit')
      })
      guardStream(file.stream)
      let raw: string
      let lineEndings: LineEndings
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of file.stream) {
          // Node Readable iterators are untyped; the SFTP stream emits Buffer chunks.
          const buffer = chunk as Buffer
          bytes += buffer.length
          chunks.push(buffer)
        }
        const full = Buffer.concat(chunks, bytes)
        if (full.includes(0)) throw new FsError(`cannot edit "${checked.displayPath}": binary file`, 'FS_NOT_TEXT')
        raw = decodeUtf8(full, 'edit', checked.displayPath)
        lineEndings = detectLineEndings(raw)
      } catch (error: unknown) {
        throw this.translateError(error, 'edit')
      } finally {
        await file.close().catch(() => undefined)
      }
      const original = normalizeLineEndings(raw)
      const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, checked.displayPath)
      const content = restoreLineEndings(edited.content, lineEndings)
      await this.atomicWrite(path, Buffer.from(content, 'utf8'), existing.mode, false, signal, checked)
      const after = await this.sftpStat(path, signal)
      return {
        version: after?.version ?? FsVersion(`missing:${path}`),
        before: original,
        after: edited.content,
      }
    })
  }

  /** Best-effort overwrite diff basis (bounded, null on any non-text/oversize). */
  private async readDiffBasis(path: string, maxBytes: number): Promise<string | null> {
    try {
      const conn = await this.connection()
      const file = await conn.sftp.openRead(path, { end: maxBytes - 1 })
      guardStream(file.stream)
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of file.stream) {
          // Node Readable iterators are untyped; the SFTP stream emits Buffer chunks.
          const buffer = chunk as Buffer
          bytes += buffer.length
          if (bytes > maxBytes - 1) return null
          chunks.push(buffer)
        }
        const basis = Buffer.concat(chunks, bytes)
        if (basis.includes(0)) return null
        return normalizeLineEndings(createUtf8StreamDecoder().decode(basis))
      } finally {
        await file.close().catch(() => undefined)
      }
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      return null
    }
  }

  /**
   * Stage a temp file in the target's directory and publish it with an SFTP
   * rename (atomic on POSIX). For `createIfAbsent`, the publish is a no-replace
   * `ln` so a concurrent creator's file wins and this write reports
   * `FS_NOT_OBSERVED`.
   */
  private async atomicWrite(
    path: string,
    content: Uint8Array,
    mode: number | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
    checked?: FsTarget,
  ): Promise<void> {
    signal?.throwIfAborted()
    const conn = await this.connection()
    const dir = parentOf(path)
    const name = basename(path)
    const tempPath = `${dir}${SEP}.dsh-${name}.${randomUUID()}.tmp`
    try {
      const file = await conn.sftp.openWrite(tempPath).catch((error: unknown) => {
        throw this.translateError(error, 'write')
      })
      file.stream.on('error', () => undefined)
      try {
        file.stream.write(Buffer.from(content))
        file.stream.end()
        await file.done().catch((error: unknown) => {
          throw this.translateError(error, 'write')
        })
      } catch (error: unknown) {
        await conn.sftp.remove(tempPath).catch(() => undefined)
        throw error
      }
      signal?.throwIfAborted()
      if (mode !== undefined) {
        await this.execProbe(`chmod ${String(mode & 0o777)} ${shellQuote(tempPath)}`, signal).catch(() => undefined)
      }
      if (createIfAbsent) {
        const ln = await this.execProbe(`ln ${shellQuote(tempPath)} ${shellQuote(path)}`, signal)
        if (ln.exitCode !== 0) {
          // `ln` failed: either a concurrent creator published first, or this
          // remote's exec world cannot see the staged path. Verify through the
          // SFTP world (authoritative) before falling back to the atomic rename.
          const now = await this.sftpStat(path, signal)
          if (now !== undefined) {
            await conn.sftp.remove(tempPath).catch(() => undefined)
            throw new FsError(
              `cannot overwrite existing "${checked?.displayPath ?? path}" without reading it first`,
              'FS_NOT_OBSERVED',
            )
          }
          await conn.sftp.rename(tempPath, path).catch((error: unknown) => {
            throw this.translateError(error, 'write')
          })
        }
        // On success `ln` left the temp name as a hard link to the published
        // file; the cleanup below removes just that name.
      } else {
        await conn.sftp.rename(tempPath, path).catch((error: unknown) => {
          throw this.translateError(error, 'write')
        })
      }
      await conn.sftp.remove(tempPath).catch(() => undefined)
    } catch (error: unknown) {
      if (error instanceof FsError) throw error
      if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
      throw this.translateError(error, 'write')
    }
  }

  private async assertRegularFile(path: string, verb: string, signal?: AbortSignal): Promise<void> {
    const meta = await this.sftpStat(path, signal)
    if (meta === undefined) throw new FsError(`cannot ${verb} "${path}": not found`, 'FS_NOT_FOUND')
    if (meta.type !== 'file') throw new FsError(`cannot ${verb} "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
}

function isRemoteAbsolute(path: string): boolean {
  return path.startsWith(SEP)
}

/**
 * Lexical containment of one canonical remote path under a root. Remote keys
 * are POSIX canonical strings on both sides, so the lexical check is the
 * complete comparison (no filesystem-identity fallback to apply).
 */
function isRemotePathUnder(path: string, root: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith(SEP) ? root : `${root}${SEP}`
  return path.startsWith(prefix)
}

function normalizeRemotePath(raw: string): string {
  const parts: string[] = []
  for (const segment of raw.split(SEP)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `${SEP}${parts.join(SEP)}`
}

function parentOf(path: string): string {
  const trimmed = path.endsWith(SEP) ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf(SEP)
  if (index <= 0) return SEP
  return trimmed.slice(0, index)
}

function basename(path: string): string {
  const trimmed = path.endsWith(SEP) ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf(SEP)
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

/**
 * The consuming code already maps stream errors to the fs taxonomy; this
 * listener keeps a channel-teardown error on an already-abandoned stream from
 * becoming an uncaught exception.
 */
function guardStream(stream: Readable): void {
  stream.on('error', () => undefined)
}

/** Single-quote a remote path for the POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Map a read-path error to the fs taxonomy (abort-aware). */
function fsErrorFromReadError(error: unknown, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted) return new FsError('read aborted', 'FS_ABORTED')
  return new FsError(`read failed: ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
}

export default SftpFileSystem
