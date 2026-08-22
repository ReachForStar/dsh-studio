// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshSection, type SshSectionProps } from '../src/client/SshSection.tsx'
import { SshConnectionsStore, type SshRemoteFace } from '../src/client/ssh-store.ts'
import { en, type SshLocaleKey } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import type { SshRemoteDefinition, SshRemoteSaveRequest, SshRemoteTestResult } from '@deepseek-ai/dsh-api-remotes/client'

afterEach(cleanup)

const t = ((key: SshLocaleKey): string => en[key]) as SshSectionProps['t']

function definition(overrides: Partial<SshRemoteDefinition> = {}): SshRemoteDefinition {
  return {
    id: 'id-1',
    name: 'box',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authKind: 'password',
    passwordSet: true,
    privateKeyPath: null,
    passphraseSet: false,
    connectTimeoutMs: 10_000,
    ...overrides,
  }
}

function remote(overrides: Partial<SshRemoteFace> = {}) {
  return {
    list: vi.fn(async () => ({ connections: [definition()] })),
    save: vi.fn(async (request: SshRemoteSaveRequest) => definition({ name: request.name })),
    remove: vi.fn(async () => ({ removed: true })),
    test: vi.fn(async (): Promise<SshRemoteTestResult> => ({ ok: true, latencyMs: 3 })),
    ...overrides,
  }
}

/** Render the section with a real controller and a plain snapshot hook. */
async function renderSection(api: SshRemoteFace): Promise<{ controller: SshConnectionsStore }> {
  const controller = new SshConnectionsStore(api)
  // Load BEFORE render so the plain (non-subscribing) snapshot hook sees a
  // ready state; the component's own mount effect re-loads harmlessly.
  await controller.load()
  const props = {
    t,
    controller,
    useSnapshot: (selector: (state: ReturnType<SshConnectionsStore['store']['getSnapshot']>) => unknown) =>
      selector(controller.store.getSnapshot()),
  } as unknown as SshSectionProps
  render(<SshSection {...props} />)
  return { controller }
}

describe('SshSection', () => {
  it('loads and lists saved connections', async () => {
    await renderSection(remote())
    expect(screen.getByText('box')).toBeTruthy()
    expect(screen.getByText(/deploy@example.com:22/)).toBeTruthy()
    expect(screen.getByText(en.test)).toBeTruthy()
    expect(screen.getByText(en.edit)).toBeTruthy()
    expect(screen.getByText(en.delete)).toBeTruthy()
  })

  it('shows an empty state and a new-connection form', async () => {
    await renderSection(remote({ list: vi.fn(async () => ({ connections: [] })) }))
    expect(screen.getByText(en.empty)).toBeTruthy()
    fireEvent.click(screen.getByText(en.new))
    expect(screen.getByLabelText(en.name)).toBeTruthy()
    expect(screen.getByLabelText(en.host)).toBeTruthy()
    expect(screen.getByLabelText(en.password)).toBeTruthy()
  })

  it('validates the editor before saving', async () => {
    const api = remote()
    await renderSection(api)
    fireEvent.click(screen.getByText(en.new))
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => { expect(screen.getByText(en.emptyName)).toBeTruthy() })
    expect(api.save).not.toHaveBeenCalled()
  })

  it('saves a new connection through the wire and closes the editor', async () => {
    const api = remote({ list: vi.fn(async () => ({ connections: [] })) })
    await renderSection(api)
    fireEvent.click(screen.getByText(en.new))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'fresh' } })
    fireEvent.change(screen.getByLabelText(en.host), { target: { value: 'h' } })
    fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'u' } })
    fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'secret' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => { expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      name: 'fresh',
      host: 'h',
      username: 'u',
      authKind: 'password',
      password: 'secret',
    })) })
    expect(screen.queryByLabelText(en.password)).toBeNull()
  })

  it('probes a connection and reports the latency', async () => {
    await renderSection(remote())
    fireEvent.click(screen.getByText(en.test))
    await waitFor(() => { expect(screen.getByText(en.testOk.replace('{ms}', '3'))).toBeTruthy() })
  })

  it('reports a failed probe without an error state', async () => {
    const api = remote({ test: vi.fn(async (): Promise<SshRemoteTestResult> => ({ ok: false, error: 'refused' })) })
    await renderSection(api)
    fireEvent.click(screen.getByText(en.test))
    await waitFor(() => { expect(screen.getByText(en.testFail.replace('{error}', 'refused'))).toBeTruthy() })
  })

  it('removes a connection after a two-step confirm', async () => {
    const api = remote()
    await renderSection(api)
    fireEvent.click(screen.getByText(en.delete))
    expect(api.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en.deleteConfirm))
    await waitFor(() => { expect(api.remove).toHaveBeenCalledWith('id-1') })
  })

  it('surfaces a load failure and retries on demand', async () => {
    const api = remote({ list: vi.fn(async () => { throw new Error('boom') }) })
    await renderSection(api)
    expect(screen.getByText(en.loadFailed)).toBeTruthy()
    const callsBefore = (api.list as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(screen.getByText(en.retry))
    await waitFor(() => {
      expect((api.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })
})
