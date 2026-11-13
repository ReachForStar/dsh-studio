// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { McpSettingsTab } from '../src/client/McpSettingsTab.tsx'
import type {
  McpServersSnapshot, McpSettingsTabInjected, McpSettingsTabProps,
} from '../src/client/McpSettingsTab.tsx'
import { en, type McpSettingsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: McpSettingsLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as McpSettingsTabProps['t']

/** Props over a fixed snapshot, with every action recorded. */
function props(
  snapshot: McpServersSnapshot,
  actions: Partial<Pick<McpSettingsTabInjected, 'authorize' | 'forgetAuthorization' | 'restart'>> = {},
): McpSettingsTabProps {
  return {
    t,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    authorize: actions.authorize ?? vi.fn(async () => {}),
    forgetAuthorization: actions.forgetAuthorization ?? vi.fn(async () => {}),
    restart: actions.restart ?? vi.fn(async () => {}),
  } as McpSettingsTabProps
}

const CONNECTED: McpManagedServerView = {
  name: 'docs', configured: true, oauth: true, status: { state: 'connected', toolCount: 3, connectedAt: 1 },
}
const WAITING: McpManagedServerView = {
  name: 'docs', configured: true, oauth: true, status: { state: 'waiting-authorization', lastError: 'server requires authorization' },
}
const PLAIN: McpManagedServerView = {
  name: 'local', configured: true, oauth: false, status: { state: 'failed', reason: 'reconnect-disabled', lastError: 'no route' },
}

describe('McpSettingsTab', () => {
  it('reports an empty roster', () => {
    render(<McpSettingsTab {...props({ servers: [] })} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('lists a connected server with its tool count and restart', () => {
    const restart = vi.fn(async () => {})
    render(<McpSettingsTab {...props({ servers: [CONNECTED] }, { restart })} />)
    expect(screen.getByText('Connected · 3 tools')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.restart }))
    expect(restart).toHaveBeenCalledWith('docs')
  })

  it('offers authorization and grant removal only for OAuth servers', async () => {
    const authorize = vi.fn(async () => {})
    const forget = vi.fn(async () => {})
    render(<McpSettingsTab {...props({ servers: [WAITING, PLAIN] }, { authorize, forgetAuthorization: forget })} />)
    expect(screen.getByText('Waiting for authorization')).toBeTruthy()
    expect(screen.getByText('Failed · reconnect disabled')).toBeTruthy()
    const [docs, local] = screen.getAllByRole('listitem')
    expect(docs?.textContent).toContain(en.authorize)
    expect(docs?.textContent).toContain(en.clearAuthorization)
    expect(local?.textContent).not.toContain(en.authorize)
    expect(local?.textContent).not.toContain(en.clearAuthorization)
    expect(local?.textContent).toContain(en.restart)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authorize }))
    })
    expect(authorize).toHaveBeenCalledWith('docs')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.clearAuthorization }))
    })
    expect(forget).toHaveBeenCalledWith('docs')
  })

  it('hides every action for a disabled server', () => {
    render(<McpSettingsTab {...props({ servers: [{ ...CONNECTED, status: { state: 'disabled' } }] })} />)
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the reported diagnostic and an action failure', async () => {
    const authorize = vi.fn(async () => { throw new Error('no browser') })
    render(<McpSettingsTab {...props({ servers: [WAITING] }, { authorize })} />)
    expect(screen.getByText('server requires authorization')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authorize }))
    })
    expect(screen.getByRole('alert').textContent).toBe('The action failed: no browser')
  })

  it('reports a failed or unavailable list', () => {
    render(<McpSettingsTab {...props({ servers: [], failure: 'unavailable' })} />)
    expect(screen.getByRole('alert').textContent).toContain(en.unavailable)
    cleanup()
    render(<McpSettingsTab {...props({ servers: [], failure: 'failed' })} />)
    expect(screen.getByRole('alert').textContent).toContain(en.failedToLoad)
  })
})
