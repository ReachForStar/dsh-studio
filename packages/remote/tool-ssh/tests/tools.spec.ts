/**
 * Model-facing tools over the REAL provider and a REAL in-process SSH server:
 * every tool's happy path plus argument-validation failures, exercised through
 * the guarded tools executor.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import LocalSshService from '@deepseek-ai/dsh-ssh-local'
import * as ToolSsh from '../src/index.ts'
import { TEST_SSH_PASSWORD, TEST_SSH_USERNAME, TestSshServer } from '../../ssh-local/tests/test-server.ts'

let server: TestSshServer | undefined
let context: Context | undefined
let localRoot: string | undefined

async function setup(): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(MemorySettings)
  await ctx.plugin(LocalSshService)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolSsh)
  return ctx
}

function execute(ctx: Context, name: string, args: Record<string, unknown>, agent?: object) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`ssh-tool-${name}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  } as never)
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('').replace(/\r\n/g, '\n')
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.stop()
  server = undefined
  if (localRoot !== undefined) await rm(localRoot, { recursive: true, force: true })
  localRoot = undefined
})

describe('ssh tools', () => {
  beforeEach(async () => {
    server = await TestSshServer.start()
  })

  it('saves, lists, tests, executes on, and disconnects a connection', async () => {
    const ctx = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'ssh_connect', 'ssh_connections', 'ssh_disconnect', 'ssh_test', 'ssh_exec',
      'sftp_list', 'sftp_stat', 'sftp_read', 'sftp_write', 'sftp_mkdir', 'sftp_rm', 'sftp_rename',
    ])

    const saved = await execute(ctx, 'ssh_connect', {
      name: 'box',
      host: '127.0.0.1',
      port: server!.port,
      username: TEST_SSH_USERNAME,
      auth: 'password',
      password: TEST_SSH_PASSWORD,
      connect_timeout_ms: 8000,
    })
    expect(text(saved)).toBe(`saved ssh connection "box" (test-user@127.0.0.1:${String(server!.port)})`)

    const listed = await execute(ctx, 'ssh_connections', {})
    expect(text(listed)).toContain('box: test-user@127.0.0.1')
    expect(text(listed)).not.toContain(TEST_SSH_PASSWORD)

    const probed = await execute(ctx, 'ssh_test', { connection: 'box' })
    expect(text(probed)).toMatch(/ssh connection ok \(\d+ ms\)/)

    const ran = await execute(ctx, 'ssh_exec', { connection: 'box', command: 'echo tooled' })
    expect(text(ran)).toBe('tooled\n[exit code: 0]')

    const closed = await execute(ctx, 'ssh_disconnect', { connection: 'box' })
    expect(text(closed)).toBe('ssh connection closed')
  })

  it('updates an existing definition by id and reports secret-free views', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    const listed = await execute(ctx, 'ssh_connections', {})
    const idMatch = /\(([0-9a-f-]{36})\)/.exec(text(listed))
    expect(idMatch).not.toBeNull()

    const updated = await execute(ctx, 'ssh_connect', {
      id: idMatch![1], name: 'box', host: '127.0.0.1', port: server!.port, username: 'root',
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    expect(text(updated)).toContain('root@127.0.0.1')
    const listedAgain = await execute(ctx, 'ssh_connections', {})
    expect(text(listedAgain)).toContain('root@127.0.0.1')
    expect(text(listedAgain)).not.toContain(TEST_SSH_PASSWORD)
  })

  it('resolves relative transfer paths against the session workspace', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-'))
    const agent = {
      session: { header: { cwd: localRoot } },
    }
    const source = join(localRoot, 'src.txt')
    await writeFile(source, 'relative')
    // A relative local path uploads from the session workspace.
    const written = await execute(ctx, 'sftp_write', {
      connection: 'box', local_path: 'src.txt', remote_path: 'rel.txt',
    }, agent)
    expect(written.isError).toBe(false)
    const handle = await ctx.ssh.connect(ctx.ssh.get('box')!.id)
    expect((await handle.sftp.list('.')).some(entry => entry.name === 'rel.txt')).toBe(true)
  })

  it('rejects invalid tool arguments with descriptive errors', async () => {
    const ctx = await setup()
    // Most cases resolve the connection first, so a saved one exists.
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['ssh_connect', { name: '', host: 'h', username: 'u', auth: 'password', password: 'x' }, /invalid name/],
      ['ssh_connect', { name: 'n', host: 'h', username: 'u', auth: 'token' }, /must be one of|invalid auth/],
      ['ssh_connect', { name: 'n', host: 'h', username: 'u', auth: 'password' }, /password/],
      ['ssh_connect', { name: 'n', host: 'h', username: 'u', auth: 'password', password: '' }, /password/],
      ['ssh_connect', { name: 'n', host: 'h', username: 'u', auth: 'privateKey' }, /private_key_path/],
      ['ssh_connect', { name: 'n', host: 'h', username: 'u', auth: 'password', password: 'x', id: '' }, /invalid id/],
      ['ssh_exec', { connection: 'missing', command: 'echo x' }, /not defined/],
      ['ssh_exec', { connection: 'box', command: '  ' }, /invalid command/],
      ['sftp_list', { connection: 'box', path: '' }, /invalid path/],
      ['sftp_read', { connection: 'box', remote_path: 'a', local_path: 'b', overwrite: 'yes' }, /must be a boolean|invalid overwrite/],
    ]
    for (const [tool, args, pattern] of cases) {
      const result = await execute(ctx, tool, args)
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(pattern)
    }
  })

  it('tests an unreachable connection with a failure result, not an error', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'dead', host: '127.0.0.1', port: 1, username: 'u', auth: 'password', password: 'x',
    })
    const result = await execute(ctx, 'ssh_test', { connection: 'dead' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('ssh connection failed')
  })

  it('reports an unknown connection as a failed probe, not an error', async () => {
    const ctx = await setup()
    const result = await execute(ctx, 'ssh_test', { connection: 'missing' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('ssh connection failed')
  })

  it.skipIf(process.platform === 'win32')('runs ssh_exec with an explicit remote cwd', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    const ran = await execute(ctx, 'ssh_exec', { connection: 'box', command: 'echo in-cwd', cwd: '/' })
    expect(ran.isError).toBe(false)
    expect(text(ran)).toBe('in-cwd\n[exit code: 0]')
  })

  it('aborts a running ssh_exec when the caller signal fires', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    const controller = new AbortController()
    const running = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('ssh-tool-abort'),
      name: 'ssh_exec',
      arguments: { connection: 'box', command: 'node -e "setTimeout(() => {}, 60000)"' },
    })
    setTimeout(() => { controller.abort() }, 400)
    const result = await running
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('aborted')
  })

  it('reports nonzero exits and timeouts through the exec result', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    const failed = await execute(ctx, 'ssh_exec', { connection: 'box', command: 'echo err 1>&2 && exit 7' })
    expect(failed.isError).toBe(false)
    expect(text(failed)).toContain('[stderr]')
    expect(text(failed)).toContain('[exit code: 7]')

    const slow = await execute(ctx, 'ssh_exec', {
      connection: 'box', command: 'node -e "setTimeout(() => {}, 10000)"', timeout_ms: 400,
    })
    expect(text(slow)).toContain('[timed out after 400 ms]')
  })

  it('transfers files with the sftp tool family', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-'))
    const upload = join(localRoot, 'up.txt')
    await writeFile(upload, 'tool upload')

    const made = await execute(ctx, 'sftp_mkdir', { connection: 'box', path: 'docs' })
    expect(text(made)).toBe('created directory docs')

    const nested = await execute(ctx, 'sftp_mkdir', { connection: 'box', path: 'nested/deep', recursive: true })
    expect(text(nested)).toBe('created directory nested/deep')

    const written = await execute(ctx, 'sftp_write', { connection: 'box', local_path: upload, remote_path: 'docs/up.txt' })
    expect(text(written)).toBe('uploaded 11 bytes')

    const listed = await execute(ctx, 'sftp_list', { connection: 'box', path: 'docs' })
    expect(text(listed)).toContain('up.txt')

    const statted = await execute(ctx, 'sftp_stat', { connection: 'box', path: 'docs/up.txt' })
    expect(text(statted)).toContain('11 bytes')

    const download = join(localRoot, 'down.txt')
    const read = await execute(ctx, 'sftp_read', { connection: 'box', remote_path: 'docs/up.txt', local_path: download })
    expect(text(read)).toBe('downloaded 11 bytes')
    expect(await readFile(download, 'utf8')).toBe('tool upload')

    const renamed = await execute(ctx, 'sftp_rename', { connection: 'box', from: 'docs/up.txt', to: 'docs/moved.txt' })
    expect(renamed.isError).toBe(false)

    const removedFile = await execute(ctx, 'sftp_rm', { connection: 'box', path: 'docs/moved.txt' })
    expect(removedFile.isError).toBe(false)

    const removed = await execute(ctx, 'sftp_rm', { connection: 'box', path: 'docs', recursive: true })
    expect(removed.isError).toBe(false)
  })

  it('refuses a download over an existing local file without overwrite', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-'))
    // Upload a remote file through the provider-level channel, then download
    // onto an existing local file.
    const source = join(localRoot, 'src.txt')
    await writeFile(source, 'data')
    const handle = await ctx.ssh.connect(ctx.ssh.get('box')!.id)
    await handle.sftp.writeFile(source, 'remote.txt')
    const target = join(localRoot, 'target.txt')
    await writeFile(target, 'keep')
    const result = await execute(ctx, 'sftp_read', { connection: 'box', remote_path: 'remote.txt', local_path: target })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('already exists')
    expect(await readFile(target, 'utf8')).toBe('keep')
  })

  it('overwrites an existing local file when overwrite is set', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    localRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-ssh-'))
    const source = join(localRoot, 'src.txt')
    await writeFile(source, 'fresh data')
    const handle = await ctx.ssh.connect(ctx.ssh.get('box')!.id)
    await handle.sftp.writeFile(source, 'remote.txt')
    const target = join(localRoot, 'target.txt')
    await writeFile(target, 'stale')
    const result = await execute(ctx, 'sftp_read', {
      connection: 'box', remote_path: 'remote.txt', local_path: target, overwrite: true,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('downloaded 10 bytes')
    expect(await readFile(target, 'utf8')).toBe('fresh data')
  })

  it('fails loud on duplicate connection names and unknown ids', async () => {
    const ctx = await setup()
    await execute(ctx, 'ssh_connect', {
      name: 'box', host: '127.0.0.1', port: server!.port, username: TEST_SSH_USERNAME,
      auth: 'password', password: TEST_SSH_PASSWORD,
    })
    const duplicate = await execute(ctx, 'ssh_connect', {
      name: 'box', host: 'elsewhere', username: 'u', auth: 'password', password: 'x',
    })
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('already exists')

    const ghost = await execute(ctx, 'ssh_connect', {
      id: '00000000-0000-4000-8000-000000000000', name: 'ghost', host: 'h', username: 'u',
      auth: 'password', password: 'x',
    })
    expect(ghost.isError).toBe(true)
    expect(text(ghost)).toContain('does not exist')
  })
})

describe('ssh tools UI presentation', () => {
  beforeEach(async () => {
    server = await TestSshServer.start()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    await ctx.plugin(LocalSshService)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolSsh)
  })

  it('ssh_exec presents a terminal call and result with a truthful pill', () => {
    const ctx = context!
    expect(ctx.tools.get('ssh_exec')?.presentCall?.({ connection: 'box', command: 'uname -a' })).toEqual({
      card: 'terminal',
      title: 'uname -a',
      description: 'ssh box',
    })
    const result = ctx.tools.get('ssh_exec')!.presentResult!({ connection: 'box', command: 'x' }, {
      content: [{ type: 'text', text: 'hi\n[exit code: 0]' }],
      isError: false,
    } as never)
    expect(result).toEqual({ card: 'terminal', output: 'hi', exitCode: 0 })
    const killed = ctx.tools.get('ssh_exec')!.presentResult!({ connection: 'box', command: 'x' }, {
      content: [{ type: 'text', text: '\n[killed by signal: SIGKILL]' }],
      isError: false,
    } as never)
    expect(killed).toEqual({ card: 'terminal', signal: 'SIGKILL' })
  })

  it('ssh_exec renders timed-out and aborted results without a pill', () => {
    const ctx = context!
    const present = ctx.tools.get('ssh_exec')!.presentResult!.bind(ctx.tools.get('ssh_exec')!)
    const timedOut = present({ connection: 'box', command: 'slow' }, {
      content: [{ type: 'text', text: 'slow\n[timed out after 500 ms]' }],
      isError: false,
    } as never)
    // The timeout marker stays in the terminal output (bash precedent); the
    // pill is omitted because there is no real exit status.
    expect(timedOut).toEqual({ card: 'terminal', output: 'slow\n[timed out after 500 ms]' })
    const aborted = present({ connection: 'box', command: 'x' }, {
      content: [{ type: 'text', text: 'gone\n[aborted]' }],
      isError: false,
    } as never)
    expect(aborted).toEqual({ card: 'terminal', output: 'gone\n[aborted]' })
    // A non-text or multi-block result is left untouched.
    expect(present({ connection: 'box', command: 'x' }, {
      content: [{ type: 'image', mediaType: 'image/png', data: '' }],
      isError: false,
    } as never)).toBeUndefined()
    expect(present({ connection: 'box', command: 'x' }, {
      content: [],
      isError: false,
    })).toBeUndefined()
  })

  it('non-terminal tools present generic calls and fenced results', () => {
    const ctx = context!
    expect(ctx.tools.get('ssh_connections')?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'ssh_connections',
      kind: 'execute',
      rawInput: 'list saved connections',
    })
    const result = ctx.tools.get('ssh_connections')!.presentResult!({}, {
      content: [{ type: 'text', text: 'no ssh connections saved' }],
      isError: false,
    } as never)
    expect(result).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\nno ssh connections saved\n```' }] })
    // A non-text or multi-block result is left untouched.
    expect(ctx.tools.get('ssh_connections')!.presentResult!({}, {
      content: [{ type: 'image', mediaType: 'image/png', data: '' }],
      isError: false,
    } as never)).toBeUndefined()
    expect(ctx.tools.get('ssh_connections')!.presentResult!({}, {
      content: [],
      isError: false,
    })).toBeUndefined()
  })

  it('presentCall validates softly: malformed args return undefined, never throw', () => {
    const ctx = context!
    expect(ctx.tools.get('ssh_exec')?.presentCall?.({ command: 'x' })).toBeUndefined()
    expect(ctx.tools.get('sftp_list')?.presentCall?.({ path: 'a' })).toBeUndefined()
  })

  it('every remaining tool presents a generic call and renders edge values', () => {
    const ctx = context!
    expect(ctx.tools.get('ssh_connect')?.presentCall?.({
      name: 'box', host: 'h', username: 'u', auth: 'password', password: 'x',
    })).toEqual({
      card: 'generic',
      title: 'ssh_connect',
      kind: 'execute',
      rawInput: 'save connection definition',
    })
    expect(ctx.tools.get('ssh_disconnect')?.presentCall?.({ connection: 'box' })).toEqual({
      card: 'generic',
      title: 'ssh_disconnect',
      kind: 'execute',
      rawInput: 'box',
    })
    expect(ctx.tools.get('ssh_test')?.presentCall?.({ connection: 'box' })).toEqual({
      card: 'generic',
      title: 'ssh_test',
      kind: 'execute',
      rawInput: 'box',
    })
    expect(ctx.tools.get('sftp_list')?.presentCall?.({ connection: 'box', path: 'docs' })).toEqual({
      card: 'generic',
      title: 'sftp_list',
      kind: 'execute',
      rawInput: 'docs',
    })
    expect(ctx.tools.get('sftp_stat')?.presentCall?.({ connection: 'box', path: 'docs/up.txt' })).toEqual({
      card: 'generic',
      title: 'sftp_stat',
      kind: 'execute',
      rawInput: 'docs/up.txt',
    })
    expect(ctx.tools.get('sftp_read')?.presentCall?.({ connection: 'box', remote_path: 'a.txt', local_path: 'b.txt' })).toEqual({
      card: 'generic',
      title: 'sftp_read',
      kind: 'execute',
      rawInput: 'a.txt -> b.txt',
    })
    expect(ctx.tools.get('sftp_write')?.presentCall?.({ connection: 'box', local_path: 'b.txt', remote_path: 'a.txt' })).toEqual({
      card: 'generic',
      title: 'sftp_write',
      kind: 'execute',
      rawInput: 'b.txt -> a.txt',
    })
    expect(ctx.tools.get('sftp_mkdir')?.presentCall?.({ connection: 'box', path: 'docs' })).toEqual({
      card: 'generic',
      title: 'sftp_mkdir',
      kind: 'execute',
      rawInput: 'docs',
    })
    expect(ctx.tools.get('sftp_rm')?.presentCall?.({ connection: 'box', path: 'docs' })).toEqual({
      card: 'generic',
      title: 'sftp_rm',
      kind: 'execute',
      rawInput: 'docs',
    })
    expect(ctx.tools.get('sftp_rename')?.presentCall?.({ connection: 'box', from: 'a.txt', to: 'b.txt' })).toEqual({
      card: 'generic',
      title: 'sftp_rename',
      kind: 'execute',
      rawInput: 'a.txt -> b.txt',
    })
    expect(ctx.tools.get('ssh_connections')!.output.render({}, { connections: [] })).toEqual([
      { type: 'text', text: 'no ssh connections saved' },
    ])
    expect(ctx.tools.get('ssh_disconnect')!.output.render({}, { closed: false })).toEqual([
      { type: 'text', text: 'no open connection' },
    ])
    const listRender = ctx.tools.get('sftp_list')!.output.render.bind(ctx.tools.get('sftp_list')!.output)
    expect(listRender({}, { path: 'docs', entries: [] })).toEqual([
      { type: 'text', text: '(empty directory docs)' },
    ])
    expect(listRender({}, {
      path: 'docs',
      entries: [
        { name: 'sub', type: 'dir', size: 0, mtimeMs: 0, mode: 0 },
        { name: 'link', type: 'symlink', size: 1, mtimeMs: 0, mode: 0 },
        { name: 'file.txt', type: 'file', size: 3, mtimeMs: 0, mode: 0 },
      ],
    })).toEqual([
      { type: 'text', text: 'd          0 sub\nl          1 link\n-          3 file.txt' },
    ])
  })
})
