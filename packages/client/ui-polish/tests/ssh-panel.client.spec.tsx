// @vitest-environment jsdom
/** SshPanel: the SFTP browser reads through the terminal's connection, so a
 * selected target alone lists nothing and closing the terminal drops it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SshPanelProps, SshPanelRpcResult } from '../src/client/SshPanel.tsx'

/** xterm needs a real DOM canvas; the panel only awaits its API surface. */
class FakeTerminal {
  static instances: FakeTerminal[] = []
  cols = 80
  rows = 24
  textarea = document.createElement('textarea')
  options: Record<string, unknown> = {}
  written: string[] = []
  dataHandler: ((data: string) => void) | null = null
  constructor() { FakeTerminal.instances.push(this) }
  open(): void {}
  dispose(): void {}
  onData(handler: (data: string) => void): void { this.dataHandler = handler }
  loadAddon(): void {}
  write(data: string): void { this.written.push(data) }
  focus(): void {}
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const {
  SshPanel, createPromptTracker, extractCwdFromHook, extractCwdFromProbe, extractCwdFromPrompt, formatSize,
  joinPath, nextActionId, parentOf, pathSegments, resolveHomeDir, resolveTheme, stripAnsi,
} = await import('../src/client/SshPanel.tsx')

const CONNECTION = { id: 'c-1', name: 'box', host: 'h', port: 22, user: 'u', authKind: 'password' as const }
const OTHER = { id: 'c-2', name: 'other', host: 'h2', port: 22, user: 'u', authKind: 'password' as const }
const DIR_ENTRY = { name: 'sub', path: '/home/u/sub', type: 'directory', size: 0, mtime: 2 }

/** Recorded Remote calls, in order. */
let calls: { method: string; payload: Record<string, unknown> }[]
let rpc: SshPanelProps['rpc']

function panel(overrides: Partial<SshPanelProps> = {}) {
  return render(<SshPanel {...({
    t: (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`,
    rpc,
    subscribeHostFrames: () => () => undefined,
  } as unknown as SshPanelProps)} {...overrides} />)
}

beforeEach(() => {
  calls = []
  rpc = async (method, payload): Promise<SshPanelRpcResult> => {
    calls.push({ method, payload })
    if (method === 'ssh.list') return { ok: true, value: { connections: [CONNECTION, OTHER] } }
    if (method === 'ssh.exec') return { ok: true, value: { stdout: '/home/u\n', exitCode: 0 } }
    if (method === 'ssh.pty.open') return { ok: true, value: { ptyId: 'p-1' } }
    if (method === 'ssh.pty.attach') return { ok: true, value: { attached: true } }
    if (method === 'ssh.sftp.list') {
      return { ok: true, value: { entries: [{ name: 'file.txt', path: `${String(payload.path)}/file.txt`, type: 'file', size: 1, mtime: 1 }] } }
    }
    return { ok: true, value: {} }
  }
})

afterEach(() => { cleanup() })

/** Select a target in the connection picker. */
async function select(container: HTMLElement, id: string): Promise<void> {
  const picker = container.querySelector('select')!
  await waitFor(() => { expect(picker.querySelectorAll('option').length).toBeGreaterThan(2) })
  fireEvent.change(picker, { target: { value: id } })
}

function methods(): string[] {
  return calls.map(call => call.method)
}

describe('SshPanel path and prompt helpers', () => {
  it('joins and walks absolute paths', () => {
    expect(joinPath('/', 'x')).toBe('/x')
    expect(joinPath('/a', 'x')).toBe('/a/x')
    expect(parentOf('/')).toBe('/')
    expect(parentOf('')).toBe('/')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/a/b/')).toBe('/a')
    expect(parentOf('relative')).toBe('/')
    expect(pathSegments('/')).toEqual([{ prefix: '/', label: '/' }])
    expect(pathSegments('/var/log/')).toEqual([
      { prefix: '/', label: '/' }, { prefix: '/var', label: 'var' }, { prefix: '/var/log', label: 'log' },
    ])
  })

  it('formats byte sizes at every threshold', () => {
    expect(formatSize(10)).toBe('10 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('strips ANSI CSI, OSC, and single-character escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi('a\u001b]0;title\u0007b')).toBe('ab')
    expect(stripAnsi('a\u001bMb')).toBe('ab')
  })

  it('extracts the cwd from bracketed, plain, tilde, and minimal prompts', () => {
    expect(extractCwdFromPrompt('[user@host ~]# ', '/home/u')).toBe('/home/u')
    expect(extractCwdFromPrompt('user@host:/var/log$ ', '/home/u')).toBe('/var/log')
    expect(extractCwdFromPrompt('~/work$ ', '/home/u')).toBe('/home/u/work')
    expect(extractCwdFromPrompt('~$ ', '/home/u')).toBe('/home/u')
    expect(extractCwdFromPrompt('relative$ ', '/home/u')).toBeNull()
    expect(extractCwdFromPrompt('', '/home/u')).toBeNull()
    expect(extractCwdFromPrompt('[]$ ', '/home/u')).toBeNull()
    expect(extractCwdFromPrompt('\u001b[32m/opt\u001b[0m$\r\n', '/home/u')).toBe('/opt')
  })

  it('extracts the latest hook marker, ignoring no marker or relative paths', () => {
    expect(extractCwdFromHook('x\n__DSH_CWD__/a\n__DSH_CWD__/b\n')).toBe('/b')
    expect(extractCwdFromHook('__DSH_CWD__/a')).toBe('/a')
    expect(extractCwdFromHook('__DSH_CWD__relative\n')).toBeNull()
    expect(extractCwdFromHook('nothing')).toBeNull()
  })

  it('parses the probe markers', () => {
    expect(extractCwdFromProbe('__DSH_CWD_START__/w/x__DSH_CWD_END__')).toBe('/w/x')
    expect(extractCwdFromProbe('__DSH_CWD_START__/w')).toBeNull()
    expect(extractCwdFromProbe('(no marker)')).toBeNull()
    expect(extractCwdFromProbe('__DSH_CWD_START__rel__DSH_CWD_END__')).toBeNull()
  })

  it('reports prompt-tracker cwd changes once and resets', () => {
    const seen: string[] = []
    const tracker = createPromptTracker(cwd => seen.push(cwd), '/home/u')
    tracker.feed('__DSH_CWD__/a\n')
    tracker.feed('__DSH_CWD__/a\n')
    tracker.feed('__DSH_CWD__/b\n')
    tracker.reset()
    tracker.feed('user@host:/tmp$ ')
    expect(seen).toEqual(['/a', '/b', '/tmp'])
  })

  it('drops an overlong tracker buffer while keeping the newest marker', () => {
    const seen: string[] = []
    const tracker = createPromptTracker(cwd => seen.push(cwd), '/home/u')
    tracker.feed(`${'x'.repeat(9000)}\n__DSH_CWD__/new\n`)
    expect(seen).toEqual(['/new'])
  })

  it('reads the theme from the body attribute', () => {
    document.body.removeAttribute('data-ds-dark-theme')
    expect(resolveTheme().background).toBe('#eff1f5')
    document.body.setAttribute('data-ds-dark-theme', '')
    expect(resolveTheme().background).toBe('#1e1e2e')
    document.body.removeAttribute('data-ds-dark-theme')
  })

  it('increments the action counter', () => {
    const first = nextActionId()
    expect(nextActionId()).toBe(first + 1)
  })
})

describe('resolveHomeDir', () => {
  const signal = () => new AbortController()

  it('returns an absolute home and rejects every failure shape', async () => {
    await expect(resolveHomeDir(async () => ({ ok: true, value: { exitCode: 0, stdout: '/home/u\n' } }), 'c')).resolves.toBe('/home/u')
    await expect(resolveHomeDir(async () => ({ ok: false }), 'c')).resolves.toBeNull()
    await expect(resolveHomeDir(async () => ({ ok: true }), 'c')).resolves.toBeNull()
    await expect(resolveHomeDir(async () => ({ ok: true, value: { exitCode: 1 } }), 'c')).resolves.toBeNull()
    await expect(resolveHomeDir(async () => ({ ok: true, value: { exitCode: 0, stdout: 'rel' } }), 'c')).resolves.toBeNull()
  })

  it('turns an abort into null and logs a real failure', async () => {
    const aborted = signal()
    aborted.abort()
    await expect(resolveHomeDir(async () => { throw new Error('boom') }, 'c', aborted.signal)).resolves.toBeNull()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(resolveHomeDir(async () => { throw new Error('boom') }, 'c')).resolves.toBeNull()
    expect(spy).toHaveBeenCalled()
  })
})

describe('SshPanel SFTP lifecycle', () => {
  it('connects to nothing when a target is merely selected', async () => {
    const { container, getByText } = panel()
    await select(container, CONNECTION.id)

    await waitFor(() => { expect(methods()).toContain('ssh.list') })
    expect(methods()).not.toContain('ssh.sftp.list')
    expect(methods()).not.toContain('ssh.exec')
    expect(methods()).not.toContain('ssh.pty.open')
    expect(getByText('ssh.needsTerminal')).toBeDefined()
  })

  it('lists the remote home directory once a terminal is open', async () => {
    const { container, getByText } = panel()
    await select(container, CONNECTION.id)

    fireEvent.click(getByText('ssh.openTerminal'))
    await waitFor(() => { expect(methods()).toContain('ssh.pty.open') })
    await waitFor(() => { expect(methods()).toContain('ssh.sftp.list') })

    expect(calls.find(call => call.method === 'ssh.sftp.list')?.payload)
      .toEqual({ connectionId: CONNECTION.id, path: '/home/u' })
    await waitFor(() => { expect(getByText('file.txt')).toBeDefined() })
  })

  it('drops the listing and stops reading when the terminal closes', async () => {
    const { container, getByText, queryByText } = panel()
    await select(container, CONNECTION.id)
    fireEvent.click(getByText('ssh.openTerminal'))
    await waitFor(() => { expect(getByText('file.txt')).toBeDefined() })

    fireEvent.click(getByText('ssh.closeTerminal'))

    await waitFor(() => { expect(getByText('ssh.needsTerminal')).toBeDefined() })
    expect(queryByText('file.txt')).toBeNull()
    expect(methods()).toContain('ssh.pty.close')

    const before = calls.filter(call => call.method === 'ssh.sftp.list').length
    fireEvent.click(getByText('ssh.refresh'))
    expect(calls.filter(call => call.method === 'ssh.sftp.list').length).toBe(before)
  })

  it('closes the terminal when another target replaces it', async () => {
    const { container, getByText } = panel()
    await select(container, CONNECTION.id)
    fireEvent.click(getByText('ssh.openTerminal'))
    await waitFor(() => { expect(methods()).toContain('ssh.pty.open') })

    await select(container, OTHER.id)

    await waitFor(() => { expect(methods()).toContain('ssh.pty.close') })
    await waitFor(() => { expect(getByText('ssh.needsTerminal')).toBeDefined() })
  })
})

function lastTerminal(): FakeTerminal {
  const terminal = FakeTerminal.instances.at(-1)
  if (terminal === undefined) throw new Error('no terminal instance')
  return terminal
}

/** Merge route overrides over the default successful RPC table. */
function mergedRpc(over: Record<string, (payload: Record<string, unknown>) => Promise<SshPanelRpcResult>>): SshPanelProps['rpc'] {
  return async (method, payload): Promise<SshPanelRpcResult> => {
    calls.push({ method, payload })
    const handler = over[method]
    if (handler !== undefined) return handler(payload)
    if (method === 'ssh.list') return { ok: true, value: { connections: [CONNECTION, OTHER] } }
    if (method === 'ssh.exec') return { ok: true, value: { stdout: '/home/u\n', exitCode: 0 } }
    if (method === 'ssh.pty.open') return { ok: true, value: { ptyId: 'p-1' } }
    if (method === 'ssh.pty.attach') return { ok: true, value: { attached: true } }
    if (method === 'ssh.sftp.list') {
      return { ok: true, value: { entries: [{ name: 'file.txt', path: `${String(payload.path)}/file.txt`, type: 'file', size: 1, mtime: 1 }] } }
    }
    return { ok: true, value: {} }
  }
}

/** Select the first connection and open its terminal. */
async function openTerminal(container: HTMLElement, getByText: (text: string) => HTMLElement): Promise<void> {
  await select(container, CONNECTION.id)
  fireEvent.click(getByText('ssh.openTerminal'))
  await waitFor(() => { expect(calls).toContainEqual(expect.objectContaining({ method: 'ssh.sftp.list' })) })
}

describe('SshPanel failure paths', () => {
  it('shows the empty picker when listing connections fails or throws', async () => {
    const failed = panel({ rpc: async () => ({ ok: false }) })
    await waitFor(() => { expect(failed.container.querySelector('select')!.textContent).toContain('ssh.noConnections') })
    cleanup()
    const thrown = panel({ rpc: async () => { throw new Error('offline') } })
    await waitFor(() => { expect(thrown.container.querySelector('select')!.textContent).toContain('ssh.noConnections') })
  })

  it('reports every PTY open failure shape', async () => {
    const refused = panel({ rpc: mergedRpc({
      'ssh.pty.open': async () => ({ ok: false, error: { message: 'refused' } }),
    }) })
    await select(refused.container, CONNECTION.id)
    fireEvent.click(refused.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(refused.getByText('refused')).toBeDefined() })
    cleanup()

    const missing = panel({ rpc: mergedRpc({ 'ssh.pty.open': async () => ({ ok: true, value: {} }) }) })
    await select(missing.container, CONNECTION.id)
    fireEvent.click(missing.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(missing.getByText('host returned no PTY id')).toBeDefined() })
    cleanup()

    const attach = panel({ rpc: mergedRpc({
      'ssh.pty.attach': async () => ({ ok: false, error: { message: 'attach failed' } }),
    }) })
    await select(attach.container, CONNECTION.id)
    fireEvent.click(attach.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(attach.getByText('attach failed')).toBeDefined() })
    cleanup()

    const crashed = panel({ rpc: mergedRpc({ 'ssh.pty.open': async () => { throw new Error('crashed') } }) })
    await select(crashed.container, CONNECTION.id)
    fireEvent.click(crashed.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(crashed.getByText('crashed')).toBeDefined() })
  })

  it('reports SFTP list failures from both a result and an exception', async () => {
    const failed = panel({ rpc: mergedRpc({
      'ssh.sftp.list': async () => ({ ok: false, error: { message: 'denied' } }),
    }) })
    const view = await waitFor(() => {
      expect(failed.container.querySelector('select')!.querySelectorAll('option').length).toBeGreaterThan(2)
      return failed
    })
    fireEvent.change(view.container.querySelector('select')!, { target: { value: CONNECTION.id } })
    fireEvent.click(view.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(view.getByText('denied')).toBeDefined() })
    cleanup()

    const thrown = panel({ rpc: mergedRpc({ 'ssh.sftp.list': async () => { throw new Error('boom-list') } }) })
    await select(thrown.container, CONNECTION.id)
    fireEvent.click(thrown.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(thrown.getByText('boom-list')).toBeDefined() })
  })
})

describe('SshPanel SFTP navigation and actions', () => {

  it('navigates directories, parents, breadcrumbs, and filters rows', async () => {
    const list = panel({ rpc: mergedRpc({
      'ssh.sftp.list': async payload => ({
        ok: true,
        value: {
          entries: payload['path'] === '/home/u/sub'
            ? []
            : [DIR_ENTRY, { name: 'note.txt', path: '/home/u/note.txt', type: 'file', size: 10, mtime: 3 }],
        },
      }),
    }) })
    await openTerminal(list.container, list.getByText)
    await waitFor(() => { expect(list.getByText('sub')).toBeDefined() })

    fireEvent.click(list.getByText('sub'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/home/u/sub')).toBe(true) })
    await waitFor(() => { expect(list.getByText('ssh.empty')).toBeDefined() })

    fireEvent.click(list.getByText('..'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/home/u')).toBe(true) })

    fireEvent.click(list.getByText('home'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/home')).toBe(true) })

    fireEvent.change(list.getByPlaceholderText('ssh.filter'), { target: { value: 'note' } })
    expect(list.queryByText('sub')).toBeNull()
    expect(list.getByText('note.txt')).toBeDefined()
    fireEvent.change(list.getByPlaceholderText('ssh.filter'), { target: { value: 'missing' } })
    expect(list.getByText('ssh.empty')).toBeDefined()
  })

  it('creates a directory and reports success, refusal, and an exception', async () => {
    const created = panel()
    await openTerminal(created.container, created.getByText)
    fireEvent.click(created.getByText('ssh.mkdir'))
    fireEvent.change(created.getByPlaceholderText('ssh.mkdirPrompt'), { target: { value: 'newdir' } })
    fireEvent.click(created.getByText('ssh.confirm'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.mkdir' && c.payload['path'] === '/home/u/newdir')).toBe(true) })
    cleanup()

    const refused = panel({ rpc: mergedRpc({
      'ssh.sftp.mkdir': async () => ({ ok: false, error: { message: 'mkdir denied' } }),
    }) })
    await openTerminal(refused.container, refused.getByText)
    fireEvent.click(refused.getByText('ssh.mkdir'))
    fireEvent.change(refused.getByPlaceholderText('ssh.mkdirPrompt'), { target: { value: 'x' } })
    fireEvent.click(refused.getByText('ssh.confirm'))
    await waitFor(() => { expect(refused.getByText('mkdir denied')).toBeDefined() })
    cleanup()

    const thrown = panel({ rpc: mergedRpc({ 'ssh.sftp.mkdir': async () => { throw new Error('mkdir boom') } }) })
    await openTerminal(thrown.container, thrown.getByText)
    fireEvent.click(thrown.getByText('ssh.mkdir'))
    fireEvent.change(thrown.getByPlaceholderText('ssh.mkdirPrompt'), { target: { value: 'x' } })
    fireEvent.click(thrown.getByText('ssh.confirm'))
    await waitFor(() => { expect(thrown.getByText('mkdir boom')).toBeDefined() })
  })

  it('renames through the inline dialog and keeps the dialog on cancel', async () => {
    const renamed = panel()
    await openTerminal(renamed.container, renamed.getByText)
    fireEvent.click(renamed.getByText('ssh.rename'))
    fireEvent.change(renamed.getByPlaceholderText('ssh.renamePrompt'), { target: { value: 'renamed.txt' } })
    fireEvent.click(renamed.getByText('ssh.confirm'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.rename' && c.payload['toPath'] === '/home/u/renamed.txt')).toBe(true) })
    cleanup()

    const refused = panel({ rpc: mergedRpc({
      'ssh.sftp.rename': async () => ({ ok: false, error: { message: 'rename denied' } }),
    }) })
    await openTerminal(refused.container, refused.getByText)
    fireEvent.click(refused.getByText('ssh.rename'))
    fireEvent.change(refused.getByPlaceholderText('ssh.renamePrompt'), { target: { value: 'x.txt' } })
    fireEvent.click(refused.getByText('ssh.confirm'))
    await waitFor(() => { expect(refused.getByText('rename denied')).toBeDefined() })
    cleanup()

    const thrown = panel({ rpc: mergedRpc({ 'ssh.sftp.rename': async () => { throw new Error('rename boom') } }) })
    await openTerminal(thrown.container, thrown.getByText)
    fireEvent.click(thrown.getByText('ssh.rename'))
    fireEvent.change(thrown.getByPlaceholderText('ssh.renamePrompt'), { target: { value: 'x.txt' } })
    fireEvent.click(thrown.getByText('ssh.confirm'))
    await waitFor(() => { expect(thrown.getByText('rename boom')).toBeDefined() })
    cleanup()

    const cancelled = panel()
    await openTerminal(cancelled.container, cancelled.getByText)
    fireEvent.click(cancelled.getByText('ssh.rename'))
    fireEvent.click(cancelled.getByText('ssh.cancel'))
    expect(cancelled.queryByPlaceholderText('ssh.renamePrompt')).toBeNull()
  })

  it('removes a row after the two-step confirmation', async () => {
    const removed = panel()
    await openTerminal(removed.container, removed.getByText)
    fireEvent.click(removed.getByText('ssh.remove'))
    expect(removed.getByText('ssh.confirmRemove')).toBeDefined()
    fireEvent.click(removed.getByText('ssh.confirmRemove'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.remove' && c.payload['recursive'] === false)).toBe(true) })
    cleanup()

    const refused = panel({ rpc: mergedRpc({
      'ssh.sftp.remove': async () => ({ ok: false, error: { message: 'remove denied' } }),
    }) })
    await openTerminal(refused.container, refused.getByText)
    fireEvent.click(refused.getByText('ssh.remove'))
    fireEvent.click(refused.getByText('ssh.confirmRemove'))
    await waitFor(() => { expect(refused.getByText('remove denied')).toBeDefined() })
    cleanup()

    const thrown = panel({ rpc: mergedRpc({ 'ssh.sftp.remove': async () => { throw new Error('remove boom') } }) })
    await openTerminal(thrown.container, thrown.getByText)
    fireEvent.click(thrown.getByText('ssh.remove'))
    fireEvent.click(thrown.getByText('ssh.confirmRemove'))
    await waitFor(() => { expect(thrown.getByText('remove boom')).toBeDefined() })
  })

  it('opens the detail card and refines it from the stat result', async () => {
    const detailed = panel({ rpc: mergedRpc({
      'ssh.sftp.stat': async () => ({ ok: true, value: { entry: { name: 'fresh.txt', path: '/home/u/file.txt', type: 'file', size: 2048, mtime: 5 } } }),
    }) })
    await openTerminal(detailed.container, detailed.getByText)
    fireEvent.click(detailed.getByText('ssh.details'))
    await waitFor(() => { expect(detailed.getByText('fresh.txt')).toBeDefined() })
    expect(detailed.getByText('2.0 KB')).toBeDefined()
    fireEvent.click(detailed.getByText('ssh.detailClose'))
    expect(detailed.queryByText('fresh.txt')).toBeNull()
    cleanup()

    const failed = panel({ rpc: mergedRpc({ 'ssh.sftp.stat': async () => ({ ok: false }) }) })
    await openTerminal(failed.container, failed.getByText)
    fireEvent.click(failed.getByText('ssh.details'))
    await waitFor(() => { expect(failed.getByText('ssh.detailTitle')).toBeDefined() })
    cleanup()

    const thrown = panel({ rpc: mergedRpc({ 'ssh.sftp.stat': async () => { throw new Error('stat boom') } }) })
    await openTerminal(thrown.container, thrown.getByText)
    fireEvent.click(thrown.getByText('ssh.details'))
    await waitFor(() => { expect(thrown.getByText('ssh.detailTitle')).toBeDefined() })
  })
})

/** Capture the host frame subscription callbacks. */
function hostFrames() {
  let onFrame: ((frame: { type: string; ptyId?: string; data?: string }) => void) | null = null
  let onDrop: ((ptyId: string) => void) | null = null
  return {
    subscribe: (frame: (frame: { type: string; ptyId?: string; data?: string }) => void, drop: (ptyId: string) => void) => {
      onFrame = frame
      onDrop = drop
      return () => undefined
    },
    emit: (frame: { type: string; ptyId?: string; data?: string }) => { onFrame?.(frame) },
    drop: (ptyId: string) => { onDrop?.(ptyId) },
  }
}

const b64 = (text: string): string => Buffer.from(text).toString('base64')

describe('SshPanel terminal frames and PTY wiring', () => {
  it('writes matching frame output to xterm and follows a hook cwd marker', async () => {
    const frames = hostFrames()
    const view = panel({ subscribeHostFrames: frames.subscribe })
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })

    frames.emit({ type: 'data', ptyId: 'other', data: b64('ignored') })
    frames.emit({ type: 'data', ptyId: 'p-1' })
    expect(lastTerminal().written).toEqual([])

    frames.emit({ type: 'data', ptyId: 'p-1', data: b64('__DSH_CWD__/srv\n') })
    await waitFor(() => { expect(lastTerminal().written.length).toBe(1) })
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/srv')).toBe(true) })
  })

  it('stops following after manual navigation and resumes from the follow switch', async () => {
    const frames = hostFrames()
    const view = panel({
      subscribeHostFrames: frames.subscribe,
      rpc: mergedRpc({
        'ssh.sftp.list': async payload => ({
          ok: true,
          value: { entries: payload['path'] === '/home/u' ? [DIR_ENTRY] : [] },
        }),
      }),
    })
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })

    fireEvent.click(view.getByText('sub'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/home/u/sub')).toBe(true) })
    const before = calls.filter(c => c.method === 'ssh.sftp.list').length
    frames.emit({ type: 'data', ptyId: 'p-1', data: b64('__DSH_CWD__/other\n') })
    expect(calls.filter(c => c.method === 'ssh.sftp.list').length).toBe(before)

    fireEvent.click(view.getByText('ssh.followCwd'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.write')).toBe(true) })
    frames.emit({ type: 'data', ptyId: 'p-1', data: b64('__DSH_CWD_START__/srv__DSH_CWD_END__') })
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/srv')).toBe(true) })
  })

  it('tears down on a matching drop frame and ignores other pty ids', async () => {
    const frames = hostFrames()
    const view = panel({ subscribeHostFrames: frames.subscribe })
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(view.getByText('ssh.closeTerminal')).toBeDefined() })

    frames.drop('other')
    expect(view.getByText('ssh.closeTerminal')).toBeDefined()
    frames.drop('p-1')
    await waitFor(() => { expect(view.getByText('ssh.needsTerminal')).toBeDefined() })
  })

  it('sends xterm keystrokes through the PTY write route', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    lastTerminal().dataHandler?.('ls\n')
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.write' && c.payload['data'] === b64('ls\n'))).toBe(true) })
  })

  it('resizes the PTY through a ResizeObserver', async () => {
    const instances: FakeResizeObserver[] = []
    class FakeResizeObserver {
      private readonly callback: () => void
      constructor(callback: () => void) { this.callback = callback; instances.push(this) }
      observe(): void {}
      disconnect(): void {}
      trigger(): void { this.callback() }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const view = panel()
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(instances.length).toBeGreaterThan(0) })
    instances[0]!.trigger()
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.resize')).toBe(true) })
    vi.unstubAllGlobals()
  })

  it('repaints the xterm palette when the body theme flips', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    document.body.setAttribute('data-ds-dark-theme', '')
    await waitFor(() => { expect((lastTerminal().options['theme'] as { background?: string } | undefined)?.background).toBe('#1e1e2e') })
    document.body.removeAttribute('data-ds-dark-theme')
    await waitFor(() => { expect((lastTerminal().options['theme'] as { background?: string } | undefined)?.background).toBe('#eff1f5') })
  })

  it('closes the PTY on unmount', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    view.unmount()
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.close')).toBe(true) })
  })

  it('falls back to / when the remote home cannot be resolved', async () => {
    const view = panel({ rpc: mergedRpc({
      'ssh.exec': async () => ({ ok: false }),
    }) })
    await select(view.container, CONNECTION.id)
    fireEvent.click(view.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/')).toBe(true) })
  })
})

describe('SshPanel file transfer', () => {
  it('downloads a file and reports an HTTP failure', async () => {
    const createObjectURL = vi.fn(() => 'blob:test')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) }))
    vi.stubGlobal('fetch', fetchMock)
    const view = panel()
    await openTerminal(view.container, view.getByText)
    fireEvent.click(view.getByText('ssh.download'))
    await waitFor(() => { expect(createObjectURL).toHaveBeenCalled() })
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalled()
    cleanup()

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'nope' })))
    const failed = panel()
    await openTerminal(failed.container, failed.getByText)
    fireEvent.click(failed.getByText('ssh.download'))
    await waitFor(() => { expect(failed.getByText(/ssh.downloadFailed/)).toBeDefined() })
    vi.unstubAllGlobals()
    click.mockRestore()
  })

  it('uploads selected files and reports an HTTP failure', async () => {
    const created: HTMLInputElement[] = []
    // oxlint-disable-next-line typescript/no-deprecated -- jsdom has no non-deprecated element factory.
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = original(tag)
      if (tag === 'input') created.push(element as HTMLInputElement)
      return element
    }) as never)
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const view = panel()
    await openTerminal(view.container, view.getByText)
    fireEvent.click(view.getByText('ssh.upload'))
    const input = created.at(-1)!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'up.txt')] })
    await input.onchange?.(new Event('change'))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled() })
    expect(calls.some(c => c.method === 'ssh.sftp.list' && c.payload['path'] === '/home/u')).toBe(true)
    cleanup()

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'denied' })))
    const failed = panel()
    await openTerminal(failed.container, failed.getByText)
    fireEvent.click(failed.getByText('ssh.upload'))
    const input2 = created.at(-1)!
    Object.defineProperty(input2, 'files', { value: [new File(['x'], 'up.txt')] })
    await input2.onchange?.(new Event('change'))
    await waitFor(() => { expect(failed.getByText(/up\.txt \(500\): denied/)).toBeDefined() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})

describe('SshPanel remaining dialogs and controls', () => {
  it('cancels the mkdir dialog and ignores a blank name', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    fireEvent.click(view.getByText('ssh.mkdir'))
    fireEvent.click(view.getByText('ssh.cancel'))
    expect(view.queryByPlaceholderText('ssh.mkdirPrompt')).toBeNull()
    fireEvent.click(view.getByText('ssh.mkdir'))
    fireEvent.click(view.getByText('ssh.confirm'))
    expect(calls.some(c => c.method === 'ssh.sftp.mkdir')).toBe(false)
  })

  it('refreshes the current directory and shows detail metadata for a directory', async () => {
    const view = panel({ rpc: mergedRpc({
      'ssh.sftp.list': async () => ({
        ok: true,
        value: { entries: [DIR_ENTRY] },
      }),
    }) })
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(view.getByText('sub')).toBeDefined() })
    fireEvent.click(view.getByText('ssh.refresh'))
    await waitFor(() => { expect(calls.filter(c => c.method === 'ssh.sftp.list').length).toBeGreaterThan(1) })
    fireEvent.click(view.getByText('ssh.details'))
    await waitFor(() => { expect(view.getByText('ssh.detailTitle')).toBeDefined() })
  })
})


describe('SshPanel remaining branch coverage', () => {
  it('tolerates a remote close failure while tearing down', async () => {
    const view = panel({ rpc: mergedRpc({
      'ssh.pty.close': async () => { throw new Error('close failed') },
    }) })
    await openTerminal(view.container, view.getByText)
    fireEvent.click(view.getByText('ssh.closeTerminal'))
    await waitFor(() => { expect(view.getByText('ssh.needsTerminal')).toBeDefined() })
  })

  it('tolerates a close failure after an attach failure', async () => {
    const attach = panel({ rpc: mergedRpc({
      'ssh.pty.attach': async () => ({ ok: false, error: { message: 'attach failed' } }),
      'ssh.pty.close': async () => { throw new Error('close failed') },
    }) })
    await select(attach.container, CONNECTION.id)
    fireEvent.click(attach.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(attach.getByText('attach failed')).toBeDefined() })
  })

  it('tolerates a close failure while unmounting', async () => {
    const unmounted = panel({ rpc: mergedRpc({
      'ssh.pty.close': async () => { throw new Error('close failed') },
    }) })
    await openTerminal(unmounted.container, unmounted.getByText)
    unmounted.unmount()
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.close')).toBe(true) })
  })

  it('ignores a click on a file row, a repeated cwd, and an empty upload', async () => {
    const frames = hostFrames()
    const view = panel({ subscribeHostFrames: frames.subscribe })
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    const before = calls.filter(c => c.method === 'ssh.sftp.list').length
    fireEvent.click(view.getByText('file.txt'))
    expect(calls.filter(c => c.method === 'ssh.sftp.list').length).toBe(before)

    frames.emit({ type: 'data', ptyId: 'p-1', data: b64('__DSH_CWD__/home/u\n__DSH_CWD__/home/u\n') })
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    expect(calls.filter(c => c.method === 'ssh.sftp.list').length).toBe(before)

    const created: HTMLInputElement[] = []
    // oxlint-disable-next-line typescript/no-deprecated -- jsdom has no non-deprecated element factory.
    const original = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = original(tag)
      if (tag === 'input') created.push(element as HTMLInputElement)
      return element
    }) as never)
    fireEvent.click(view.getByText('ssh.upload'))
    const input = created.at(-1)!
    Object.defineProperty(input, 'files', { value: [] })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await input.onchange?.(new Event('change'))
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('submits an unchanged rename without a remote call', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    fireEvent.click(view.getByText('ssh.rename'))
    fireEvent.click(view.getByText('ssh.confirm'))
    expect(calls.some(c => c.method === 'ssh.sftp.rename')).toBe(false)
  })

  it('runs the hook and probe timers once the terminal mounts', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    vi.useFakeTimers()
    try {
      // A fresh probe scheduled under fake timers exercises the timeout fallback.
      act(() => { fireEvent.click(view.getByText('ssh.followCwd')) })
      act(() => { fireEvent.click(view.getByText('ssh.followCwd')) })
      act(() => { vi.advanceTimersByTime(1_600) })
    } finally {
      vi.useRealTimers()
    }
    expect(calls.some(c => c.method === 'ssh.pty.write' && atob(String(c.payload['data'])).includes('__DSH_CWD_START__'))).toBe(true)
  })

  it('does not repaint a closed terminal on a theme mutation', async () => {
    const view = panel()
    document.body.setAttribute('data-ds-dark-theme', '')
    await waitFor(() => { expect(view.container.textContent).toContain('ssh.title') })
    document.body.removeAttribute('data-ds-dark-theme')
  })

})


describe('SshPanel default messages and aborted loads', () => {
  it('uses default messages when a route omits its error', async () => {
    const missing = panel({ rpc: mergedRpc({ 'ssh.pty.open': async () => ({ ok: false }) }) })
    await select(missing.container, CONNECTION.id)
    fireEvent.click(missing.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(missing.getByText('failed to open PTY')).toBeDefined() })
    cleanup()

    const attach = panel({ rpc: mergedRpc({ 'ssh.pty.attach': async () => ({ ok: false }) }) })
    await select(attach.container, CONNECTION.id)
    fireEvent.click(attach.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(attach.getByText('failed to attach PTY')).toBeDefined() })
    cleanup()

    const list = panel({ rpc: mergedRpc({
      'ssh.sftp.list': async () => ({ ok: true }),
    }) })
    await select(list.container, CONNECTION.id)
    fireEvent.click(list.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(list.getByText('ssh.empty')).toBeDefined() })
    cleanup()

    const denied = panel({ rpc: mergedRpc({
      'ssh.sftp.list': async () => ({ ok: false }),
    }) })
    await select(denied.container, CONNECTION.id)
    fireEvent.click(denied.getByText('ssh.openTerminal'))
    await waitFor(() => { expect(denied.getByText('failed to list directory')).toBeDefined() })
    cleanup()

    const mkdir = panel({ rpc: mergedRpc({ 'ssh.sftp.mkdir': async () => ({ ok: false }) }) })
    await openTerminal(mkdir.container, mkdir.getByText)
    fireEvent.click(mkdir.getByText('ssh.mkdir'))
    fireEvent.change(mkdir.getByPlaceholderText('ssh.mkdirPrompt'), { target: { value: 'x' } })
    fireEvent.click(mkdir.getByText('ssh.confirm'))
    await waitFor(() => { expect(mkdir.getByText(/ssh\.mkdirFailed/)).toBeDefined() })
    cleanup()

    const rename = panel({ rpc: mergedRpc({ 'ssh.sftp.rename': async () => ({ ok: false }) }) })
    await openTerminal(rename.container, rename.getByText)
    fireEvent.click(rename.getByText('ssh.rename'))
    fireEvent.change(rename.getByPlaceholderText('ssh.renamePrompt'), { target: { value: 'x.txt' } })
    fireEvent.click(rename.getByText('ssh.confirm'))
    await waitFor(() => { expect(rename.getByText(/ssh\.renameFailed/)).toBeDefined() })
    cleanup()

    const remove = panel({ rpc: mergedRpc({ 'ssh.sftp.remove': async () => ({ ok: false }) }) })
    await openTerminal(remove.container, remove.getByText)
    fireEvent.click(remove.getByText('ssh.remove'))
    fireEvent.click(remove.getByText('ssh.confirmRemove'))
    await waitFor(() => { expect(remove.getByText(/ssh\.removeFailed/)).toBeDefined() })
  })

  it('drops an aborted home lookup instead of listing the directory', async () => {
    let resolveExec!: (value: SshPanelRpcResult) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const view = panel({ rpc: mergedRpc({
      'ssh.exec': async () => new Promise<SshPanelRpcResult>((resolve) => {
        resolveExec = resolve
        markStarted()
      }),
    }) })
    await select(view.container, CONNECTION.id)
    fireEvent.click(view.getByText('ssh.openTerminal'))
    await started
    view.unmount()
    resolveExec({ ok: true, value: { stdout: '/home/u\n', exitCode: 0 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.some(c => c.method === 'ssh.sftp.list')).toBe(false)
  })
})


describe('SshPanel remaining UI guards', () => {
  it('treats a missing connection list value as empty and runs without ResizeObserver', async () => {
    const view = panel({ rpc: mergedRpc({ 'ssh.list': async () => ({ ok: true }) }) })
    await waitFor(() => { expect(view.container.querySelector('select')!.querySelectorAll('option')).toHaveLength(1) })
    cleanup()

    vi.stubGlobal('ResizeObserver', undefined)
    const noObserver = panel()
    await openTerminal(noObserver.container, noObserver.getByText)
    await waitFor(() => { expect(noObserver.getByText('ssh.closeTerminal')).toBeDefined() })
    vi.unstubAllGlobals()
  })

  it('turns following off without probing', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    const before = calls.filter(c => c.method === 'ssh.pty.write').length
    fireEvent.click(view.getByText('ssh.followCwd'))
    expect(calls.filter(c => c.method === 'ssh.pty.write').length).toBe(before)
  })
})


describe('SshPanel shell timers', () => {
  it('injects the prompt hook and probes after the shell settles', async () => {
    const view = panel()
    await openTerminal(view.container, view.getByText)
    await waitFor(() => { expect(FakeTerminal.instances.length).toBeGreaterThan(0) })
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.write' && atob(String(c.payload['data'])).includes('__DSH_CWD__'))).toBe(true) })
    await waitFor(() => { expect(calls.some(c => c.method === 'ssh.pty.write' && atob(String(c.payload['data'])).includes('__DSH_CWD_START__'))).toBe(true) })
  })
})
