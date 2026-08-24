/**
 * Test-only in-process SSH server over `ssh2.Server`: real password and
 * public-key authentication, real shell execution for exec (through node's
 * child_process), and an SFTP subsystem mapped onto a temp directory. The
 * SFTP half uses ssh2's own server-side packet parsing: requests arrive as
 * named channel events (`OPEN`, `READDIR`, `MKDIR`, …) and replies go
 * through the channel's `status`/`handle`/`data`/`name` helpers.
 */

import { exec as shellExec, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename as renameFile,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Stats } from 'node:fs'
import {
  Server,
  type Attributes,
  type Connection,
  type ServerChannel,
  type SFTPWrapper,
} from 'ssh2'

export const TEST_SSH_PASSWORD = 'test-password'
export const TEST_SSH_USERNAME = 'test-user'

/** SFTP v3 status codes (ssh2 does not re-export its protocol constants). */
const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  FAILURE: 4,
} as const

/** One open remote file or directory handle. */
interface SftpHandle {
  kind: 'file' | 'dir'
  path: string
  /** Open directory entries yet to be delivered. */
  entries: Array<{ filename: string; longname: string; attrs: Attributes }> | undefined
}

/** Map one node stat to the SFTP attrs record ssh2's name() helper wants. */
function attrsOf(stats: Stats): Attributes {
  const typeBit = stats.isDirectory() ? 0o040000 : stats.isSymbolicLink() ? 0o120000 : 0o100000
  return {
    mode: typeBit | (stats.mode & 0o7777),
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  }
}

/** Minimal SFTP v3 server mapped onto one root directory. */
export class SftpTestServer {
  private readonly handles = new Map<string, SftpHandle>()
  private nextHandleId = 1

  constructor(private readonly root: string) {}

  /** Attach every named request event of one accepted SFTP channel. */
  attach(channel: SFTPWrapper): void {
    channel.on('OPEN', (reqId, filename, flags) => {
      process.stderr.write(`[test-server] OPEN ${filename} flags=${String(flags)}\n`)
      void (async () => {
        try {
          const absolute = this.resolve(filename)
          if ((flags & 0x1) !== 0) { // SSH_FXF_READ
            channel.handle(reqId, this.mint('file', absolute))
            return
          }
          await writeFile(absolute, Buffer.alloc(0), { flag: 'w' })
          channel.handle(reqId, this.mint('file', absolute))
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
    channel.on('CLOSE', (reqId, handle) => {
      this.handles.delete(String(handle))
      channel.status(reqId, SFTP_STATUS.OK)
    })
    channel.on('READ', (reqId, handle, offset, length) => {
      process.stderr.write(`[test-server] READ ${String(handle)} off=${String(offset)} len=${String(length)}\n`)
      void (async () => {
        let fh: Awaited<ReturnType<typeof open>> | undefined
        try {
          const entry = this.handles.get(String(handle))
          if (entry === undefined || entry.kind !== 'file') {
            channel.status(reqId, SFTP_STATUS.FAILURE, 'invalid handle')
            return
          }
          fh = await open(entry.path, 'r')
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await fh.read(buffer, 0, length, offset)
          if (bytesRead === 0) {
            channel.status(reqId, SFTP_STATUS.EOF, 'eof')
            return
          }
          channel.data(reqId, buffer.subarray(0, bytesRead))
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        } finally {
          await fh?.close()
        }
      })()
    })
    channel.on('WRITE', (reqId, handle, offset, data) => {
      void (async () => {
        let fh: Awaited<ReturnType<typeof open>> | undefined
        try {
          const entry = this.handles.get(String(handle))
          if (entry === undefined || entry.kind !== 'file') {
            channel.status(reqId, SFTP_STATUS.FAILURE, 'invalid handle')
            return
          }
          fh = await open(entry.path, 'r+')
          await fh.write(data, 0, data.length, offset)
          channel.status(reqId, SFTP_STATUS.OK)
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        } finally {
          await fh?.close()
        }
      })()
    })
    channel.on('OPENDIR', (reqId, path) => {
      void (async () => {
        try {
          const absolute = this.resolve(path)
          const names = await readdir(absolute)
          const entries = []
          for (const name of names) {
            const stats = await stat(join(absolute, name))
            entries.push({ filename: name, longname: name, attrs: attrsOf(stats) })
          }
          channel.handle(reqId, this.mint('dir', absolute, entries))
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
    channel.on('READDIR', (reqId, handle) => {
      const entry = this.handles.get(String(handle))
      if (entry === undefined || entry.kind !== 'dir' || entry.entries === undefined) {
        channel.status(reqId, SFTP_STATUS.FAILURE, 'invalid handle')
        return
      }
      if (entry.entries.length === 0) {
        channel.status(reqId, SFTP_STATUS.EOF, 'eof')
        return
      }
      channel.name(reqId, entry.entries.splice(0, 64))
    })
    channel.on('LSTAT', (reqId, path) => {
      process.stderr.write(`[test-server] LSTAT ${path}\n`)
      void this.statOne(channel, reqId, path)
    })
    channel.on('STAT', (reqId, path) => {
      process.stderr.write(`[test-server] STAT ${path}\n`)
      void this.statOne(channel, reqId, path)
    })
    channel.on('FSTAT', (reqId, handle) => {
      process.stderr.write(`[test-server] FSTAT ${String(handle)}\n`)
      const entry = this.handles.get(String(handle))
      if (entry === undefined) {
        channel.status(reqId, SFTP_STATUS.FAILURE, 'invalid handle')
        return
      }
      // The handle path is already absolute; never resolve it again.
      void stat(entry.path).then((stats) => {
        process.stderr.write(`[test-server] FSTAT name() for ${entry.path}\n`)
        channel.name(reqId, [{ filename: basename(entry.path), longname: entry.path, attrs: attrsOf(stats) }])
      }).catch((error: unknown) => {
        process.stderr.write(`[test-server] FSTAT error ${error instanceof Error ? error.message : String(error)}\n`)
        channel.status(reqId, this.codeOf(error), this.messageOf(error))
      })
    })
    channel.on('MKDIR', (reqId, path) => {
      void (async () => {
        try {
          await mkdir(this.resolve(path))
          channel.status(reqId, SFTP_STATUS.OK)
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
    channel.on('RMDIR', (reqId, path) => {
      void (async () => {
        try {
          // SFTP semantics: RMDIR removes one empty directory only; a
          // non-empty one fails with ENOTEMPTY so the client's recursive
          // traversal stays authoritative.
          await rmdir(this.resolve(path))
          channel.status(reqId, SFTP_STATUS.OK)
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
    channel.on('REMOVE', (reqId, path) => {
      void (async () => {
        try {
          await unlink(this.resolve(path))
          channel.status(reqId, SFTP_STATUS.OK)
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
    channel.on('RENAME', (reqId, fromPath, toPath) => {
      void (async () => {
        try {
          await renameFile(this.resolve(fromPath), this.resolve(toPath))
          channel.status(reqId, SFTP_STATUS.OK)
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
    channel.on('REALPATH', (reqId, path) => {
      void (async () => {
        try {
          const absolute = this.resolve(path)
          const stats = await stat(absolute)
          channel.name(reqId, [{ filename: absolute, longname: absolute, attrs: attrsOf(stats) }])
        } catch (error) {
          channel.status(reqId, this.codeOf(error), this.messageOf(error))
        }
      })()
    })
  }

  /** Reply to a stat-style request with a one-entry NAME packet. */
  private async statOne(channel: SFTPWrapper, reqId: number, path: string): Promise<void> {
    try {
      const absolute = this.resolve(path)
      const stats = await stat(absolute)
      process.stderr.write(`[test-server] statOne ${path} -> ${absolute} isDir=${String(stats.isDirectory())}\n`)
      channel.name(reqId, [{ filename: basename(absolute), longname: absolute, attrs: attrsOf(stats) }])
      process.stderr.write(`[test-server] statOne ${path} name() sent\n`)
    } catch (error) {
      process.stderr.write(`[test-server] statOne ${path} error ${error instanceof Error ? error.message : String(error)}\n`)
      channel.status(reqId, this.codeOf(error), this.messageOf(error))
    }
  }

  private codeOf(error: unknown): number {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? SFTP_STATUS.NO_SUCH_FILE : SFTP_STATUS.FAILURE
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private resolve(path: string): string {
    if (path === '.' || path === '') return this.root
    if (path.startsWith('/')) return join(this.root, path.slice(1))
    return join(this.root, path)
  }

  private mint(kind: SftpHandle['kind'], path: string, entries?: SftpHandle['entries']): Buffer {
    const handle = Buffer.from(`h${String(this.nextHandleId++)}`, 'utf8')
    this.handles.set(handle.toString('utf8'), { kind, path, entries })
    return handle
  }
}



/** One running test server: SSH transport plus SFTP and shell execution. */
export class TestSshServer {
  /** Client disconnection count (teardown assertions). */
  disconnects = 0
  /** When true, shell requests are rejected (PTY open-failure tests). */
  rejectShell = false
  /** PTY allocation requests received (cols/rows). */
  readonly ptyRequests: Array<{ cols: number; rows: number }> = []
  /** Window-change reports received on shell channels. */
  readonly windows: Array<{ rows: number; cols: number }> = []
  readonly sftp: SftpTestServer
  readonly root: string
  /** Live exec child processes, force-killed on stop. */
  private readonly running = new Set<ReturnType<typeof shellExec>>()
  private readonly ssh: Server
  /** Live client connections, destroyed on stop. */
  private readonly clients = new Set<Connection>()

  private constructor(ssh: Server, root: string) {
    this.ssh = ssh
    this.root = root
    this.sftp = new SftpTestServer(root)
  }

  /** Boot a server on an ephemeral loopback port with a fresh temp root. */
  static async start(): Promise<TestSshServer> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-test-'))
    const harness = new TestSshServer(new Server({ hostKeys: [generateHostKey()] }), root)
    harness.ssh.on('connection', (client: Connection) => {
      harness.clients.add(client)
      client.on('error', () => undefined)
      client.on('authentication', (authCtx) => {
        const passwordOk = authCtx.method === 'password'
          && authCtx.username === TEST_SSH_USERNAME
          && authCtx.password === TEST_SSH_PASSWORD
        // publickey is accepted as-is: the test client signs with a real key,
        // and the server trusts any presented key (throwaway test trust).
        if (passwordOk || authCtx.method === 'publickey') {
          authCtx.accept()
          return
        }
        authCtx.reject(['password', 'publickey'])
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('error', () => undefined)
          session.on('exec', (execAccept, _execReject, info) => {
            const channel = execAccept()
            channel.on('error', () => undefined)
            void harness.runRemoteCommand(info.command, channel)
          })
          session.on('pty', (accept, _reject, info) => {
            harness.ptyRequests.push({ cols: info.cols, rows: info.rows })
            accept()
          })
          session.on('window-change', (_accept, _reject, info) => {
            // ssh2 sends the client window-change with want_reply=0; a reply
            // would desynchronize the protocol, so just record it.
            harness.windows.push({ rows: info.rows, cols: info.cols })
          })
          session.on('shell', (shellAccept, shellReject) => {
            if (harness.rejectShell) {
              shellReject()
              return
            }
            const channel = shellAccept()
            channel.on('error', () => undefined)
            harness.runPseudoShell(channel)
          })
          session.on('sftp', (sftpAccept) => {
            const sftpChannel = sftpAccept()
            sftpChannel.on('error', () => undefined)
            harness.sftp.attach(sftpChannel)
          })
        })
      })
      client.on('close', () => {
        harness.clients.delete(client)
        harness.disconnects += 1
      })
    })
    await new Promise<void>((resolve) => {
      harness.ssh.listen(0, '127.0.0.1', () => { resolve() })
    })
    return harness
  }

  get port(): number {
    const address = this.ssh.address()
    if (address === null || typeof address === 'string') throw new Error('test ssh server not bound')
    return address.port
  }

  async stop(): Promise<void> {
    const children = [...this.running]
    this.running.clear()
    // taskkill is asynchronous; wait for the tree to die before removing the
    // temp root, or a killed child still holding the cwd makes rm report EBUSY.
    await Promise.all(children.map(child => killTree(child.pid)))
    for (const client of [...this.clients]) {
      client.end()
    }
    await new Promise<void>((resolve) => {
      const done = (): void => { resolve() }
      this.ssh.close(done)
      // A client that ignores end() must not hang the teardown.
      setTimeout(done, 1_000).unref()
    })
    // A runaway child may still hold the temp root for a moment; retry before
    // surfacing the cleanup error.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(this.root, { recursive: true, force: true })
        return
      } catch (error) {
        if (attempt === 7) throw error
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }

  /** Run one exec request through the real local shell, streaming into the channel. */
  async runRemoteCommand(command: string, channel: ServerChannel): Promise<void> {
    const child = shellExec(command, { cwd: this.root, windowsHide: true }, (error, stdout, stderr) => {
      this.running.delete(child)
      if (channel.destroyed) return
      channel.write(stdout)
      if (stderr.length > 0) channel.stderr.write(stderr)
      channel.exit(error === null ? 0 : typeof error.code === 'number' ? error.code : 1)
      channel.close()
    })
    this.running.add(child)
    // Kill the real process tree when the client drops the channel, so a
    // runaway command cannot hold the temp root hostage during teardown.
    const drop = (): void => {
      void killTree(child.pid)
    }
    channel.on('close', drop)
    channel.on('eof', drop)
  }

  /**
   * Drive one deterministic in-memory pseudo-shell on a shell channel: prints
   * a READY banner, echoes each line as `ECHO <line>`, exits with 0 on
   * `exit`, with 3 on `code3`, and sends an exit-signal on `sigkill`.
   */
  private runPseudoShell(channel: ServerChannel): void {
    let buf = ''
    channel.write('READY\n')
    channel.on('data', (data: Buffer) => {
      buf += data.toString('utf8')
      for (;;) {
        const i = buf.indexOf('\n')
        if (i < 0) break
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line === 'exit') {
          channel.exit(0)
          channel.close()
          return
        }
        if (line === 'code3') {
          channel.exit(3)
          channel.close()
          return
        }
        if (line === 'sigkill') {
          channel.exit('KILL')
          channel.close()
          return
        }
        channel.write(`ECHO ${line}\n`)
      }
    })
  }
}
/** Kill one process and its children, settling once the tree is gone. */
function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      // A dying tree can hold taskkill open; never block teardown forever.
      taskkill.on('exit', () => { resolve() })
      taskkill.on('error', () => { resolve() })
      setTimeout(resolve, 2_000).unref()
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* the process is already gone */
  }
  return Promise.resolve()
}

/** Generate one throwaway RSA host key for the test server. */
function generateHostKey(): Buffer {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }) as Buffer
}
