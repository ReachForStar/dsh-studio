/**
 * Host Remote gateway for the SSH connection-management GUI: list, save, and
 * remove definitions plus the connectivity probe, all over the `ctx.sshSftp` seam.
 * Secrets are write-only — every response is a secret-free view.
 * @module @reachforstar/dsh-host-ssh-remotes
 */

import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SshError } from '@reachforstar/dsh-ssh'
import type {
  SftpEntry,
  SshConnection,
  SshConnectionDefinition,
  SshPtySession,
} from '@reachforstar/dsh-ssh'
import type {
  SftpEntryView,
  SshExecRemoteRequest,
  SshPtyAttachRequest,
  SshPtyCloseRequest,
  SshPtyOpenRequest,
  SshPtyResizeRequest,
  SshPtyWriteRequest,
  SshRemoteDefinition,
  SshRemoteSaveRequest,
  SshRemoteTestResult,
  SshSftpMkdirRequest,
  SshSftpRemoveRequest,
  SshSftpRenameRequest,
  SshSftpRequest,
  SshRemoteRunResult,
} from './types.ts'

export type * from './types.ts'

interface SshConnectionFetch {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

function connectionOf(ctx: Context): SshConnectionFetch {
  return Reflect.get(ctx, 'connection') as SshConnectionFetch
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ssh save: ${key} must be a non-empty string`)
  }
  return value.trim()
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ssh save: ${key} must be a number`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`ssh save: ${key} must be a string`)
  }
  return value
}

/**
 * Project one registry definition to its secret-free wire shape.
 * @param definition - the definition to project.
 * @returns the flat wire view the browser reads.
 */
export function toRemoteDefinition(definition: SshConnectionDefinition): SshRemoteDefinition {
  return {
    id: String(definition.id),
    name: definition.name,
    host: definition.host,
    port: definition.port,
    username: definition.username,
    authKind: definition.auth.kind,
    passwordSet: definition.auth.kind === 'password',
    privateKeyPath: definition.auth.kind === 'privateKey' ? definition.auth.privateKeyPath : null,
    passphraseSet: definition.auth.kind === 'privateKey'
      && definition.auth.passphrase !== undefined
      && definition.auth.passphrase.length > 0,
    connectTimeoutMs: definition.connectTimeoutMs,
  }
}

/**
 * Translate one validated wire request into a seam save input.
 * @param request - the validated wire payload.
 * @returns the save input handed to the seam.
 */
export function toSaveInput(request: SshRemoteSaveRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: request.name,
    host: request.host,
    username: request.username,
  }
  // Undefined fields are forwarded as absent: the seam keeps stored secrets.
  if (request.id !== undefined) input['id'] = request.id
  if (request.port !== undefined) input['port'] = request.port
  if (request.connectTimeoutMs !== undefined) input['connectTimeoutMs'] = request.connectTimeoutMs
  if (request.authKind === 'password') {
    input['auth'] = {
      kind: 'password',
      ...request.password !== undefined ? { password: request.password } : {},
    }
  } else {
    input['auth'] = {
      kind: 'privateKey',
      ...request.privateKeyPath !== undefined ? { privateKeyPath: request.privateKeyPath } : {},
      ...request.passphrase !== undefined ? { passphrase: request.passphrase } : {},
    }
  }
  return input
}

/**
 * Wire-boundary validation of a save payload. The browser may legitimately
 * omit a stored secret (write-only inputs), so `password`/`passphrase` are
 * forwarded as absent and the seam's save keeps the stored value.
 * @param value - untrusted wire payload.
 * @returns the validated save request.
 */
export function validateSaveRequest(value: unknown): SshRemoteSaveRequest {
  if (!isPlainObject(value)) throw new Error('ssh save: payload must be an object')
  const authKind = value['authKind']
  if (authKind !== 'password' && authKind !== 'privateKey') {
    throw new Error(`ssh save: authKind must be "password" or "privateKey", got ${JSON.stringify(authKind)}`)
  }
  const id = optionalString(value, 'id')
  if (id !== undefined && id.length === 0) throw new Error('ssh save: id must be non-empty')
  const port = optionalNumber(value, 'port')
  const connectTimeoutMs = optionalNumber(value, 'connectTimeoutMs')
  const password = optionalString(value, 'password')
  const privateKeyPath = optionalString(value, 'privateKeyPath')
  const passphrase = optionalString(value, 'passphrase')
  if (authKind === 'password' && password !== undefined && password.length === 0) {
    throw new Error('ssh save: password must be non-empty')
  }
  if (authKind === 'privateKey' && (privateKeyPath === undefined || privateKeyPath.length === 0)) {
    throw new Error('ssh save: privateKeyPath must be non-empty for privateKey auth')
  }
  const request: SshRemoteSaveRequest = {
    name: requireString(value, 'name'),
    host: requireString(value, 'host'),
    username: requireString(value, 'username'),
    authKind,
    ...id !== undefined ? { id } : {},
    ...port !== undefined ? { port } : {},
    ...connectTimeoutMs !== undefined ? { connectTimeoutMs } : {},
    ...password !== undefined && password.length > 0 ? { password } : {},
    ...privateKeyPath !== undefined && privateKeyPath.length > 0 ? { privateKeyPath } : {},
    ...passphrase !== undefined && passphrase.length > 0 ? { passphrase } : {},
  }
  return request
}

function sftpEntryView(entry: SftpEntry, directory: string): SftpEntryView {
  const path = directory === '/' ? `/${entry.name}` : `${directory}/${entry.name}`
  const type = entry.type === 'dir' ? 'directory'
    : entry.type === 'file' || entry.type === 'symlink' ? entry.type : 'other'
  return { name: entry.name, path, type, size: entry.size, mtime: entry.mtimeMs }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`ssh: ${field} must be a positive integer`)
}

/** One live PTY and the shared connection it was opened on. */
interface SshGatewayPty {
  readonly session: SshPtySession
  readonly connection: SshConnection
}

/** Host Remote surface for SSH connection management, PTY, and SFTP. */
export class SshGateway extends TypertRemoteService {
  static inject = ['sshSftp']

  private readonly ptySessions = new Map<string, SshGatewayPty>()

  constructor(ctx: Context) {
    // The gateway is its own Cordis service (`sshGateway`) whose wire namespace
    // is `ssh` — the provider's registry key stays a same-process service.
    super(ctx, 'sshGateway', { namespace: 'ssh' })
    ctx.effect(() => async () => {
      const sessions = [...this.ptySessions.values()]
      this.ptySessions.clear()
      await Promise.allSettled(sessions.map(held => held.session.close()))
    }, 'ssh gateway: PTY teardown')
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.effect(() => {
        const disposeDownload = connectionOf(connectionCtx).fetch.register({
          path: '/api/ssh/sftp/download',
          methods: ['GET'],
          fetch: request => this.download(request),
        })
        const disposeUpload = connectionOf(connectionCtx).fetch.register({
          path: '/api/ssh/sftp/upload',
          methods: ['POST'],
          fetch: request => this.upload(request),
        })
        return async () => {
          await disposeUpload()
          await disposeDownload()
        }
      }, 'ssh gateway: SFTP Fetch routes')
    })
  }

  /**
   * List every saved connection as a secret-free wire view.
   * @returns the current definition list, secret-free.
   */
  @Remote('list')
  list(): { connections: SshRemoteDefinition[] } {
    return { connections: this.ctx.sshSftp.list().map(toRemoteDefinition) }
  }

  /**
   * Save one connection definition (create or update by id). Secrets are
   * write-only: a request omitting `password`/`passphrase` keeps the stored
   * value for the addressed connection.
   * @param request - the wire payload (typert validates its shape).
   * @returns the saved secret-free wire view.
   */
  @Remote('save')
  async save(request: SshRemoteSaveRequest): Promise<SshRemoteDefinition> {
    const validated = validateSaveRequest(request)
    const saved = await this.ctx.sshSftp.save(toSaveInput(validated))
    return toRemoteDefinition(saved)
  }

  /**
   * Remove one connection definition.
   * @param id - the connection id to remove.
   * @returns whether a connection was removed.
   */
  @Remote('delete')
  async delete(id: string): Promise<{ removed: boolean }> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('ssh delete: id must be a non-empty string')
    }
    return { removed: await this.ctx.sshSftp.remove(id) }
  }

  /**
   * Probe one connection and report the outcome without throwing across the
   * wire: failures are a result, never an RPC error.
   * @param id - the connection id to test.
   * @returns the probe outcome.
   */
  @Remote('test')
  async test(id: string): Promise<SshRemoteTestResult> {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'ssh test: id must be a non-empty string' }
    }
    try {
      const outcome = await this.ctx.sshSftp.test(id)
      return { ok: outcome.ok, latencyMs: outcome.latencyMs }
    } catch (error) {
      const message = error instanceof SshError ? error.message : error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  /**
   * 执行一次远程命令。
   * @param request - 远程命令及连接参数。
   * @param signal - 取消当前远程操作的信号。
   * @returns 远程命令的退出状态和输出。
   */
  @Remote('exec')
  async exec(request: SshExecRemoteRequest, signal: AbortSignal): Promise<SshRemoteRunResult> {
    return this.withConnection(request.connectionId, signal, connection => connection.exec(this.ctx.sshSftp.resolveExec({
      command: request.command,
      ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs },
      ...request.cwd === undefined ? {} : { cwd: request.cwd },
      signal,
    })))
  }

  /**
   * 打开交互式 PTY。
   * @param request - PTY 的连接和窗口参数。
   * @param signal - 取消当前连接操作的信号。
   * @returns 新建 PTY 的不透明标识。
   */
  @Remote('ptyOpen')
  async ptyOpen(request: SshPtyOpenRequest, signal: AbortSignal): Promise<{ ptyId: string }> {
    requirePositiveInteger(request.cols, 'cols')
    requirePositiveInteger(request.rows, 'rows')
    const connection = await this.connection(request.connectionId, signal)
    const session = await connection.openPty({ cols: request.cols, rows: request.rows })
    if (signal.aborted) {
      await session.close()
      signal.throwIfAborted()
    }
    const ptyId = randomUUID()
    this.ptySessions.set(ptyId, { session, connection })
    return { ptyId }
  }

  /**
   * 订阅 PTY 输出和退出事件；底层会回放订阅前到达的数据。
   * @param request - 要订阅的 PTY 标识。
   * @returns 表示订阅已建立的确认值。
   */
  @Remote('ptyAttach')
  ptyAttach(request: SshPtyAttachRequest): { attached: true } {
    const held = this.pty(request.ptyId)
    held.session.onOutput((data) => {
      this.ctx.emit('ssh/pty/output', { ptyId: request.ptyId, data: Buffer.from(data).toString('base64') })
    })
    held.session.onExit((info) => {
      this.ptySessions.delete(request.ptyId)
      // A shell that exited on its own leaves the same closed-terminal state as
      // an explicit close, so the connection is released here too.
      void this.releaseConnection(held.connection, request.ptyId)
      this.ctx.emit('ssh/pty/exit', { ptyId: request.ptyId, ...info })
    })
    return { attached: true }
  }

  /**
   * 向 PTY 写入 base64 编码的字节。
   * @param request - PTY 标识和编码后的输入字节。
   * @returns 表示输入已接受的确认值。
   */
  @Remote('ptyWrite')
  ptyWrite(request: SshPtyWriteRequest): { accepted: true } {
    this.pty(request.ptyId).session.write(Buffer.from(request.data, 'base64'))
    return { accepted: true }
  }

  /**
   * 调整 PTY 窗口大小。
   * @param request - PTY 标识和正整数窗口尺寸。
   * @returns 表示窗口调整已接受的确认值。
   */
  @Remote('ptyResize')
  ptyResize(request: SshPtyResizeRequest): { accepted: true } {
    requirePositiveInteger(request.cols, 'cols')
    requirePositiveInteger(request.rows, 'rows')
    this.pty(request.ptyId).session.resize(request.cols, request.rows)
    return { accepted: true }
  }

  /**
   * 关闭 PTY。终端是共享连接的持有者：最后一个持有该连接的 PTY 关闭时，连接
   * 一并关闭，否则关闭终端后连接会随定义常驻。后续 exec/SFTP 会按需重新建连。
   * @param request - 要关闭的 PTY 标识。
   * @returns 表示 PTY 已关闭的确认值。
   */
  @Remote('ptyClose')
  async ptyClose(request: SshPtyCloseRequest): Promise<{ closed: true }> {
    const held = this.pty(request.ptyId)
    await held.session.close()
    this.ptySessions.delete(request.ptyId)
    await this.releaseConnection(held.connection, request.ptyId)
    return { closed: true }
  }

  /**
   * 列出一个远程目录。
   * @param request - 远程连接和目录路径。
   * @param signal - 取消当前 SFTP 操作的信号。
   * @returns 目录项的无秘密视图。
   */
  @Remote('sftpList')
  async sftpList(request: SshSftpRequest, signal: AbortSignal): Promise<{ entries: SftpEntryView[] }> {
    return this.withConnection(request.connectionId, signal, async (connection) => {
      const entries = await connection.sftp.list(request.path)
      signal.throwIfAborted()
      return { entries: entries.map(entry => sftpEntryView(entry, request.path)) }
    })
  }

  /**
   * 读取远程路径元数据。
   * @param request - 远程连接和路径。
   * @param signal - 取消当前 SFTP 操作的信号。
   * @returns 路径项的无秘密视图。
   */
  @Remote('sftpStat')
  async sftpStat(request: SshSftpRequest, signal: AbortSignal): Promise<{ entry: SftpEntryView }> {
    return this.withConnection(request.connectionId, signal, async (connection) => {
      const entry = await connection.sftp.stat(request.path)
      signal.throwIfAborted()
      const parent = request.path.slice(0, request.path.lastIndexOf('/')) || '/'
      return { entry: sftpEntryView(entry, parent) }
    })
  }

  /**
   * 创建远程目录。
   * @param request - 远程连接、目录路径和递归选项。
   * @param signal - 取消当前 SFTP 操作的信号。
   * @returns 已创建目录的远程路径。
   */
  @Remote('sftpMkdir')
  async sftpMkdir(request: SshSftpMkdirRequest, signal: AbortSignal): Promise<{ path: string }> {
    return this.withConnection(request.connectionId, signal, async (connection) => {
      await connection.sftp.mkdir(request.path, { recursive: request.recursive === true })
      signal.throwIfAborted()
      return { path: request.path }
    })
  }

  /**
   * 删除远程文件或目录。
   * @param request - 远程连接、路径和递归选项。
   * @param signal - 取消当前 SFTP 操作的信号。
   * @returns 表示路径已删除的确认值。
   */
  @Remote('sftpRemove')
  async sftpRemove(request: SshSftpRemoveRequest, signal: AbortSignal): Promise<{ removed: true }> {
    return this.withConnection(request.connectionId, signal, async (connection) => {
      await connection.sftp.remove(request.path, { recursive: request.recursive === true })
      signal.throwIfAborted()
      return { removed: true }
    })
  }

  /**
   * 重命名远程路径。
   * @param request - 远程连接、原路径和目标路径。
   * @param signal - 取消当前 SFTP 操作的信号。
   * @returns 新路径。
   */
  @Remote('sftpRename')
  async sftpRename(request: SshSftpRenameRequest, signal: AbortSignal): Promise<{ path: string }> {
    return this.withConnection(request.connectionId, signal, async (connection) => {
      await connection.sftp.rename(request.path, request.toPath)
      signal.throwIfAborted()
      return { path: request.toPath }
    })
  }

  /**
   * Run one operation on the shared connection and release it afterwards unless
   * an open terminal still holds it.
   *
   * The provider keys one live connection per definition and hands the same
   * handle to terminals, exec, and SFTP alike, so an operation that simply kept
   * the handle would leave a connection open on a target nobody is using — the
   * terminal that justified it is gone, and the browser's next directory read
   * or working-directory probe would reconnect it forever. Releasing here makes
   * the connection's lifetime the terminals': a held connection is reused for
   * the cost of a map lookup, and an unheld one is closed as the operation ends.
   * @param id - the connection definition id.
   * @param signal - cancels the operation.
   * @param operation - the work to run against the live connection.
   * @returns the operation's result.
   */
  private async withConnection<T>(
    id: string,
    signal: AbortSignal,
    operation: (connection: SshConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connection(id, signal)
    try {
      return await operation(connection)
    } finally {
      await this.releaseConnection(connection, 'one-shot exec/SFTP operation')
    }
  }

  private async connection(id: string, signal: AbortSignal): Promise<SshConnection> {
    const definition = this.ctx.sshSftp.resolve(id)
    signal.throwIfAborted()
    const connection = await this.ctx.sshSftp.connect(definition.id)
    signal.throwIfAborted()
    return connection
  }

  private pty(id: string): SshGatewayPty {
    const held = this.ptySessions.get(id)
    if (held === undefined) throw new SshError('SSH_PTY_CLOSED', `ssh pty session "${id}" was not found or has terminated`)
    return held
  }

  /**
   * Close one shared connection once no open terminal still holds it. The
   * provider keeps one handle per definition for every consumer — terminals,
   * exec, SFTP — so this only closes when the terminals that made it worth
   * keeping are gone; a later operation reconnects on demand.
   *
   * A close that fails does not fail the terminal that asked for it: the
   * terminal is already gone, and a connection the provider had dropped on its
   * own is not a close the caller can retry.
   * @param connection - the handle the closing terminal was opened on.
   * @param holder - the operation that no longer needs it, named in the diagnostic.
   */
  private async releaseConnection(connection: SshConnection, holder: string): Promise<void> {
    for (const held of this.ptySessions.values()) {
      if (held.connection === connection) return
    }
    try {
      await connection.close()
    } catch (error) {
      this.ctx.logger.warn(`ssh gateway: closing the connection released by ${holder} failed`)
      this.ctx.logger.warn(error)
    }
  }

  private async download(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const connectionId = url.searchParams.get('connectionId')
    const path = url.searchParams.get('path')
    if (connectionId === null || connectionId === '' || path === null || path === '') {
      return new Response('missing connectionId or path', { status: 400 })
    }
    let file: Awaited<ReturnType<SshConnection['sftp']['openRead']>> | undefined
    let connection: SshConnection | undefined
    let settled = false
    // The body streams after this handler returns, so the connection is held
    // until the transfer itself ends — on the final chunk, on a read error, or
    // when the client aborts.
    const settle = async (): Promise<void> => {
      if (settled) return
      settled = true
      await file?.close()
      if (connection !== undefined) await this.releaseConnection(connection, 'SFTP download')
    }
    try {
      connection = await this.connection(connectionId, request.signal)
      file = await connection.sftp.openRead(path)
      request.signal.throwIfAborted()
      const stream = Readable.toWeb(file.stream) as ReadableStream<Uint8Array>
      file.stream.once('close', () => { void settle() })
      file.stream.once('error', () => { void settle() })
      return new Response(stream, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${path.split('/').pop() ?? 'download'}"`,
          ...file.size === null ? {} : { 'content-length': String(file.size) },
        },
      })
    } catch (error) {
      await settle()
      if (request.signal.aborted) throw request.signal.reason
      return new Response(`sftp download failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    }
  }

  private async upload(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const connectionId = url.searchParams.get('connectionId')
    const path = url.searchParams.get('path')
    if (connectionId === null || connectionId === '' || path === null || path === '') {
      return new Response('missing connectionId or path', { status: 400 })
    }
    if (request.body === null) return new Response('missing upload body', { status: 400 })
    let writable: Awaited<ReturnType<SshConnection['sftp']['openWrite']>> | undefined
    let connection: SshConnection | undefined
    try {
      connection = await this.connection(connectionId, request.signal)
      writable = await connection.sftp.openWrite(path)
      const reader = request.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        request.signal.throwIfAborted()
        if (!writable.stream.write(Buffer.from(value))) {
          await new Promise<void>(resolve => writable?.stream.once('drain', resolve))
        }
      }
      writable.stream.end()
      const result = await writable.done()
      request.signal.throwIfAborted()
      return Response.json(result)
    } catch (error) {
      writable?.stream.destroy()
      if (request.signal.aborted) throw request.signal.reason
      return new Response(`sftp upload failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    } finally {
      if (connection !== undefined) await this.releaseConnection(connection, 'SFTP upload')
    }
  }
}

export default SshGateway
