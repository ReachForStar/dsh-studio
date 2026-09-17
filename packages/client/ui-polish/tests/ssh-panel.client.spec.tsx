// @vitest-environment jsdom
/** SshPanel: the SFTP browser reads through the terminal's connection, so a
 * selected target alone lists nothing and closing the terminal drops it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SshPanelProps, SshPanelRpcResult } from '../src/client/SshPanel.tsx'

/** xterm needs a real DOM canvas; the panel only awaits its API surface. */
class FakeTerminal {
  cols = 80
  rows = 24
  textarea = document.createElement('textarea')
  open(): void {}
  dispose(): void {}
  onData(): void {}
  loadAddon(): void {}
  write(): void {}
  focus(): void {}
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const { SshPanel } = await import('../src/client/SshPanel.tsx')

const CONNECTION = { id: 'c-1', name: 'box', host: 'h', port: 22, user: 'u', authKind: 'password' as const }
const OTHER = { id: 'c-2', name: 'other', host: 'h2', port: 22, user: 'u', authKind: 'password' as const }

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
