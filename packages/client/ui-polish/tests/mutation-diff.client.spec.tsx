// @vitest-environment jsdom
/** MutationDiffPanel (the workspace file panel): directory-tree browse, in-place
 * read/edit through /git/*, and the no-workspace notice. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { MutationDiffPanel, type MutationDiffPanelProps } from '../src/client/MutationDiffPanel.tsx'

const SID = 's1'

/** The temp workspace the panel treats as the current cwd. */
const WORKSPACE = 'D:/workspace'

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  } as unknown as WorkspaceSnapshot)
  return bindSnapshotSelector(store)
}

function workspaceWorkspaces() {
  const items = [{ workspaceId: 'w1', path: WORKSPACE, title: 'ws', sessionIds: [SID], createdAt: '', updatedAt: '' }] as unknown as readonly WorkspaceView[]
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items,
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  } as unknown as WorkspaceSnapshot)
  return bindSnapshotSelector(store)
}

function sessionSource(sessionId: string | undefined) {
  let snap = { sessionId } as unknown as SessionSnapshot
  const subs = new Set<() => void>()
  return {
    set: (next: string | undefined): void => {
      snap = { sessionId: next } as unknown as SessionSnapshot
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void): (() => void) => { subs.add(fn); return () => subs.delete(fn) },
    },
  }
}

function props(source: { getSnapshot(): SessionSnapshot; subscribe(fn: () => void): () => void }): MutationDiffPanelProps {
  return {
    useSession: bindSnapshotSelector(source),
    useWorkspaces: emptyWorkspaces(),
    t: (key: string) => key,
  } as unknown as MutationDiffPanelProps
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('/git/list')) {
      const body = init?.body
      const hasDir = typeof body === 'string' && body.includes('"dir"')
      return Promise.resolve(jsonResponse({
        items: hasDir
          ? []
          : [
            { path: 'src', name: 'src', type: 'dir', size: null, modifiedMs: null },
            { path: 'readme.md', name: 'readme.md', type: 'file', size: 12, modifiedMs: 1_000 },
          ],
      }))
    }
    if (url.startsWith('/git/read')) {
      return Promise.resolve(jsonResponse({ content: 'hello workspace' }))
    }
    if (url.startsWith('/git/write')) {
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    return Promise.resolve(jsonResponse({}))
  }))
})

afterEach(cleanup)

describe('MutationDiffPanel (file panel)', () => {
  it('shows the no-workspace notice when the session owns none', () => {
    const { source } = sessionSource(undefined)
    const view = render(<MutationDiffPanel {...props(source)} />)
    expect(view.container.textContent).toContain('git.noWorkspace')
  })

  it('loads the workspace root listing and browses a directory lazily', async () => {
    const { source } = sessionSource(SID)
    const withWorkspace: MutationDiffPanelProps = {
      ...props(source),
      useWorkspaces: workspaceWorkspaces(),
    }
    const view = render(<MutationDiffPanel {...withWorkspace} />)
    await vi.waitFor(() => { expect(view.container.textContent).toContain('readme.md') })
    // Directory entries expand into their fetched children.
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    await vi.waitFor(() => { expect(view.container.textContent).toContain('readme.md') })
  })

  it('selects a file, reads its content, and saves an edit through /git/write', async () => {
    const { source } = sessionSource(SID)
    const view = render(<MutationDiffPanel {...props(source)} useWorkspaces={workspaceWorkspaces()} />)
    await vi.waitFor(() => { expect(view.container.textContent).toContain('readme.md') })
    fireEvent.click(screen.getByRole('button', { name: /readme.md/ }))
    await vi.waitFor(() => { expect(view.container.textContent).toContain('hello workspace') })
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'edited' } })
    fireEvent.click(view.getByRole('button', { name: 'diff.save' }))
    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some(call => String(call[0]).startsWith('/git/write'))).toBe(true)
    })
  })

  it('renders nothing extra when the listing is empty', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    // oxlint-disable-next-line typescript/no-misused-promises -- the fetch stub returns a promise by contract
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ items: [] })))
    const { source } = sessionSource(SID)
    const view = render(<MutationDiffPanel {...props(source)} useWorkspaces={workspaceWorkspaces()} />)
    await vi.waitFor(() => { expect(view.container.textContent).toContain('diff.empty') })
    act(() => {})
  })
})
