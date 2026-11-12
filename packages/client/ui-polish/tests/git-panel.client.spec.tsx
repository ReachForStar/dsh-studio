// @vitest-environment jsdom
/**
 * GitPanel behavior: repository scanning, branch/commit actions, rule and model
 * modals, working-tree groups, file actions, the untracked tree, diff drawers
 * (text and image), history with its graph, confirmations, and abort paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GitPanelProps } from '../src/client/GitPanel.tsx'
import { CommitGraph, DiffDrawer, GitPanel, ImageDiff } from '../src/client/GitPanel.tsx'
import type {
  GitBranches, GitCommit, GitModel, GitRepo, GitRules, GitStatus,
} from '../src/client/git-client.ts'

const api = vi.hoisted(() => ({
  repos: vi.fn(),
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  show: vi.fn(),
  blob: vi.fn(),
  models: vi.fn(),
  rules: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  clean: vi.fn(),
  diff: vi.fn(),
  commit: vi.fn(),
  undoCommit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  switch: vi.fn(),
  stashList: vi.fn(),
  stashPush: vi.fn(),
  stashPop: vi.fn(),
  mergeAbort: vi.fn(),
  mergeComplete: vi.fn(),
  reset: vi.fn(),
  rulesSave: vi.fn(),
  rulesReset: vi.fn(),
  generate: vi.fn(),
  generateCancel: vi.fn(),
}))

vi.mock('../src/client/git-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/git-client.ts')>()
  return { ...actual, gitApi: api }
})

const REPO: GitRepo = { path: '/ws', name: 'ws', isWorktree: false }
const SUB_REPO: GitRepo = { path: '/ws/sub', name: 'sub', isWorktree: true }

const CLEAN_STATUS: GitStatus = {
  isRepo: true, branch: 'main', ahead: 0, behind: 0, mergeState: null, head: 'h1',
  staged: [], unstaged: [], untracked: [], conflicted: [],
}

const FULL_STATUS: GitStatus = {
  isRepo: true, branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
  mergeState: null, head: 'h1',
  staged: [{ status: 'M ', path: 'staged.txt' }, { status: 'A ', path: 'added.txt' }],
  unstaged: [{ status: ' M', path: 'dir/change.txt' }],
  untracked: [
    { status: '??', path: 'new.txt' },
    { status: '??', path: 'sub/a.txt' },
    { status: '??', path: 'sub/deep/b.txt' },
  ],
  conflicted: [{ status: 'UU', path: 'conflict.txt' }],
}

const BRANCHES: GitBranches = {
  current: 'main',
  upstream: 'origin/main',
  local: [{ name: 'main', current: true }, { name: 'dev', current: false }],
  remote: ['origin/dev'],
}

const RULES: GitRules = { systemPrompt: 'sys', userContext: 'ctx', source: 'repo', scope: 'repo' }

const DIFF = [
  'diff --git a/dir/change.txt b/dir/change.txt',
  'index 111..222 100644',
  '--- a/dir/change.txt',
  '+++ b/dir/change.txt',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old line',
  '+new line',
].join('\n')

const CONFLICT_DIFF = [
  '@@ -1,3 +1,3 @@',
  '<<<<<<< HEAD',
  'ours',
  '=======',
  'theirs',
  '>>>>>>> branch',
].join('\n')

const COMMITS: readonly GitCommit[] = [
  {
    hash: 'h1', shortHash: 'h1', parents: ['h2'], author: 'Ada', email: 'ada@example.com',
    date: '2026-01-01T00:00:00.000Z', subject: 'first commit', body: 'details',
    stat: { files: 2, insertions: 4, deletions: 1 },
  },
  {
    hash: 'h2', shortHash: 'h2', parents: ['missing'], author: 'Bob', email: 'bob@example.com',
    date: '2025-12-31T00:00:00.000Z', subject: 'second commit', body: '',
  },
]

const t = ((key: string) => key) as unknown as GitPanelProps['t']
const paramT = ((key: string, params?: Record<string, unknown>) =>
  (params === undefined ? key : `${key} ${JSON.stringify(params)}`)) as unknown as GitPanelProps['t']

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return { ...CLEAN_STATUS, ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function resetApi(): void {
  for (const fn of Object.values(api)) fn.mockReset()
  api.repos.mockResolvedValue({ repos: [REPO] })
  api.models.mockResolvedValue({ models: [] })
  api.status.mockResolvedValue(CLEAN_STATUS)
  api.branches.mockResolvedValue(BRANCHES)
  api.log.mockResolvedValue({ commits: [], hasMore: false })
  api.rules.mockResolvedValue(RULES)
  api.stashList.mockResolvedValue({ entries: [] })
  api.stage.mockResolvedValue({ ok: true })
  api.unstage.mockResolvedValue({ ok: true })
  api.discard.mockResolvedValue({ ok: true })
  api.clean.mockResolvedValue({ ok: true })
  api.diff.mockResolvedValue({ diff: DIFF })
  api.commit.mockResolvedValue({ ok: true, hash: 'abc1234' })
  api.undoCommit.mockResolvedValue({ ok: true })
  api.push.mockResolvedValue({ ok: true })
  api.pull.mockResolvedValue({ ok: true })
  api.switch.mockResolvedValue({ ok: true })
  api.stashPush.mockResolvedValue({ ok: true })
  api.stashPop.mockResolvedValue({ ok: true })
  api.mergeAbort.mockResolvedValue({ ok: true })
  api.mergeComplete.mockResolvedValue({ ok: true, hash: 'merge1' })
  api.reset.mockResolvedValue({ ok: true })
  api.rulesSave.mockResolvedValue({ ok: true })
  api.rulesReset.mockResolvedValue({ ok: true })
  api.generate.mockResolvedValue('generated')
  api.generateCancel.mockResolvedValue({ ok: true })
  api.blob.mockImplementation((_cwd: string, _path: string, source: string) =>
    Promise.resolve({ mime: 'image/png', size: 3, dataUrl: `data:${source}` }))
}

interface MountOptions {
  noSession?: boolean
  translate?: GitPanelProps['t']
}

function mount(options: MountOptions = {}) {
  const sessionId = options.noSession === true ? undefined : 's-1'
  const props = {
    useSession: (select: (state: { sessionId: string | undefined }) => unknown) => select({ sessionId }),
    useWorkspaces: (select: (state: { items: readonly unknown[] }) => unknown) =>
      select({ items: [{ path: '/ws', sessionIds: ['s-1'] }] }),
    t: options.translate ?? t,
  } as unknown as GitPanelProps
  return render(<GitPanel {...props} />)
}

async function loaded(branch = 'main'): Promise<void> {
  await waitFor(() => { expect(screen.getAllByText(branch).length).toBeGreaterThan(0) })
}

function fileRow(name: string): HTMLElement {
  const row = screen.getByText(name).parentElement
  if (row === null) throw new Error(`no row for ${name}`)
  return row
}

function menu(label: string): HTMLElement {
  const element = screen.getByText(label).parentElement
  if (element === null) throw new Error(`no menu for ${label}`)
  return element
}

async function openRulesMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTitle('git.rules'))
  const opened = await waitFor(() => menu('git.rulesSource'))
  await act(async () => {})
  return opened
}

async function openRuleEditor(): Promise<HTMLElement> {
  const opened = await openRulesMenu()
  fireEvent.click(within(opened).getByText('git.editRules'))
  return screen.getByText('git.rulesTitle').parentElement as HTMLElement
}

beforeEach(() => {
  resetApi()
  localStorage.clear()
  // The history sentinel mounts an observer once commits render; jsdom has none.
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return [] }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GitPanel workspace states', () => {
  it('renders the no-workspace note without scanning', () => {
    mount({ noSession: true })
    expect(screen.getByText('git.noWorkspace')).toBeDefined()
    expect(api.repos).not.toHaveBeenCalled()
  })

  it('renders an Error thrown by the repository scan', async () => {
    api.repos.mockRejectedValue(new Error('scan failed'))
    mount()
    expect(await screen.findByText('scan failed')).toBeDefined()
  })

  it('stringifies a non-Error scan rejection', async () => {
    api.repos.mockRejectedValue('offline')
    mount()
    expect(await screen.findByText('offline')).toBeDefined()
  })

  it('renders the loading placeholder until the scan resolves', async () => {
    const scan = deferred<{ repos: readonly GitRepo[] }>()
    api.repos.mockReturnValue(scan.promise)
    mount()
    expect(screen.getByText('…')).toBeDefined()
    await act(async () => { scan.resolve({ repos: [] }) })
    expect(screen.getByText('git.noRepo')).toBeDefined()
  })

  it('renders the empty-repository state and refreshes the scan', async () => {
    api.repos.mockResolvedValue({ repos: [] })
    mount()
    expect(await screen.findByText('git.noRepo')).toBeDefined()
    fireEvent.click(screen.getByTitle('git.refresh'))
    await waitFor(() => { expect(api.repos).toHaveBeenCalledTimes(2) })
    expect(api.repos).toHaveBeenLastCalledWith('/ws', true)
    expect(await screen.findByText('git.noRepo')).toBeDefined()
  })

  it('renders every repository with root and worktree titles', async () => {
    api.repos.mockResolvedValue({ repos: [REPO, SUB_REPO] })
    mount()
    await waitFor(() => { expect(api.status).toHaveBeenCalledTimes(2) })
    expect(screen.getByText('git.rootRepo')).toBeDefined()
    expect(screen.getByText(/git\.worktree/)).toBeDefined()
    expect(screen.getByText('git.repoCount')).toBeDefined()
    expect(screen.getAllByTitle('/ws').length).toBeGreaterThan(0)
  })

  it('refreshes a loaded repository from the header button', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getAllByTitle('git.refresh').at(0) as HTMLElement)
    await waitFor(() => { expect(api.status).toHaveBeenCalledTimes(2) })
    expect(api.repos).toHaveBeenLastCalledWith('/ws', true)
  })

  it('refreshes a repository from its own header button', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getAllByTitle('git.refresh').at(-1) as HTMLElement)
    await waitFor(() => { expect(api.status).toHaveBeenCalledTimes(2) })
    expect(api.repos).toHaveBeenCalledTimes(1)
  })

  it('reports a refresh failure in the error bar', async () => {
    api.status.mockRejectedValue(new Error('status failed'))
    mount()
    expect(await screen.findByText('status failed')).toBeDefined()
  })

  it('stringifies a non-Error refresh failure', async () => {
    api.status.mockRejectedValue('status string')
    mount()
    expect(await screen.findByText('status string')).toBeDefined()
  })

  it('shows the branch sync badges and the merge badge', async () => {
    api.status.mockResolvedValue(status({ mergeState: 'merge', ahead: 2, behind: 1, upstream: 'origin/main' }))
    mount()
    await loaded()
    expect(screen.getByText('git.ahead')).toBeDefined()
    expect(screen.getByText('git.behind')).toBeDefined()
    expect(screen.getByText('origin/main')).toBeDefined()
    expect(screen.getByText('git.mergeInProgress')).toBeDefined()
  })

  it('falls back to the empty model catalog when /git/models fails', async () => {
    api.models.mockRejectedValue(new Error('no models'))
    mount()
    await loaded()
    const rulesMenu = await openRulesMenu()
    fireEvent.click(within(rulesMenu).getByText('git.genModel'))
    expect(await screen.findByText(/git\.genModelDefault/)).toBeDefined()
  })
})

describe('GitPanel branch header', () => {
  it('lists local and remote branches and switches to a local branch', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByText('main'))
    const branchMenu = await screen.findByText('git.switchTo')
    const menuEl = branchMenu.parentElement as HTMLElement
    expect(within(menuEl).getByText('dev')).toBeDefined()
    expect(within(menuEl).getByText('origin/dev')).toBeDefined()
    expect(within(menuEl).getByText(/^main/).closest('button')?.disabled).toBe(true)
    fireEvent.click(within(menuEl).getByText('dev'))
    await waitFor(() => { expect(api.switch).toHaveBeenCalledWith('/ws', 'dev', false) })
    await waitFor(() => { expect(screen.queryByText('git.switchTo')).toBeNull() })
  })

  it('creates a branch from the Enter key and ignores empty names', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByText('main'))
    const input = await screen.findByPlaceholderText('git.branchPlaceholder')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'a' })
    expect(api.switch).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' feature ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(api.switch).toHaveBeenCalledWith('/ws', 'feature', true) })
  })

  it('creates a branch from the button once the name is typed', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByText('main'))
    await screen.findByText('git.switchTo')
    const create = screen.getByText('git.create').closest('button') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('git.branchPlaceholder'), { target: { value: 'next' } })
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await waitFor(() => { expect(api.switch).toHaveBeenCalledWith('/ws', 'next', true) })
  })

  it('closes the branch menu on a second chip click', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByText('main'))
    expect(await screen.findByText('git.switchTo')).toBeDefined()
    fireEvent.click(screen.getByText('main'))
    expect(screen.queryByText('git.switchTo')).toBeNull()
  })

  it('disables branch actions while a switch is in flight', async () => {
    const pending = deferred<{ ok: boolean }>()
    api.switch.mockReturnValue(pending.promise)
    mount()
    await loaded()
    fireEvent.click(screen.getByText('main'))
    await screen.findByText('git.switchTo')
    fireEvent.click(screen.getByText('dev'))
    await waitFor(() => { expect(api.switch).toHaveBeenCalled() })
    const menuEl = menu('git.switchTo')
    expect(within(menuEl).getByText('dev').closest('button')?.disabled).toBe(true)
    expect(screen.getByText('git.create').closest('button')?.disabled).toBe(true)
    await act(async () => { pending.resolve({ ok: true }) })
  })
})

describe('GitPanel commit box', () => {
  it('commits with Ctrl+Enter and Meta+Enter', async () => {
    mount()
    await loaded()
    const box = screen.getByPlaceholderText('git.commitPlaceholder') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'feat: one' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => { expect(api.commit).toHaveBeenCalledWith('/ws', 'feat: one') })
    await waitFor(() => { expect(box.value).toBe('') })
    fireEvent.change(box, { target: { value: 'feat: two\n\nbody' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => { expect(api.commit).toHaveBeenCalledWith('/ws', 'feat: two\n\nbody') })
    expect(api.push).not.toHaveBeenCalled()
  })

  it('ignores an empty commit from the keyboard', async () => {
    mount()
    await loaded()
    const box = screen.getByPlaceholderText('git.commitPlaceholder')
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'a', ctrlKey: true })
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(api.commit).not.toHaveBeenCalled()
  })

  it('commits and pushes, showing the no-upstream hint when the push fails', async () => {
    api.push.mockRejectedValue(new Error('fatal: no upstream branch'))
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: push' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.push).toHaveBeenCalledWith('/ws') })
    expect(await screen.findByText('git.pushFailed')).toBeDefined()
    expect(screen.getByText('git.pushNoUpstreamHint')).toBeDefined()
    expect(api.commit).toHaveBeenCalledWith('/ws', 'feat: push')
  })

  it('commits and pushes successfully with a flash', async () => {
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: ok' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('git.pushed')).toBeDefined()
    expect(api.push).toHaveBeenCalledWith('/ws')
  })

  it('reports a generic push failure and retries it', async () => {
    api.push.mockRejectedValueOnce(new Error('network down'))
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: push' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('network down')).toBeDefined()
    fireEvent.click(screen.getByText('git.retryPush').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.push).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByText('git.pushFailed')).toBeNull() })
  })

  it('undoes the last commit from the push-failure modal', async () => {
    api.push.mockRejectedValue(new Error('rejected'))
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: undo' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    await screen.findByText('git.pushFailed')
    fireEvent.click(screen.getByText('git.undoCommit').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.undoCommit).toHaveBeenCalledWith('/ws', 'abc1234') })
    expect(screen.queryByText('git.pushFailed')).toBeNull()
  })

  it('reports an undo failure in the error bar', async () => {
    api.push.mockRejectedValue(new Error('rejected'))
    api.undoCommit.mockRejectedValue(new Error('cannot undo'))
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: undo' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    await screen.findByText('git.pushFailed')
    fireEvent.click(screen.getByText('git.undoCommit').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('cannot undo')).toBeDefined()
  })

  it('stringifies non-Error push and undo rejections', async () => {
    api.push.mockRejectedValue('push string')
    api.undoCommit.mockRejectedValue('undo string')
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: undo' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('push string')).toBeDefined()
    fireEvent.click(screen.getByText('git.undoCommit').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('undo string')).toBeDefined()
  })

  it('closes the push-failure modal from the close button, backdrop, and keeps it on inner clicks', async () => {
    api.push.mockRejectedValue(new Error('rejected'))
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: x' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    const title = await screen.findByText('git.pushFailed')
    fireEvent.click(title)
    expect(screen.getByText('git.pushFailed')).toBeDefined()
    fireEvent.click(title.parentElement?.parentElement as HTMLElement)
    expect(screen.queryByText('git.pushFailed')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: y' } })
    fireEvent.click(screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement)
    await screen.findByText('git.pushFailed')
    fireEvent.click(screen.getByText('git.close').closest('button') as HTMLButtonElement)
    expect(screen.queryByText('git.pushFailed')).toBeNull()
  })

  it('reports commit failures without pushing, including non-Error rejections', async () => {
    api.commit.mockRejectedValueOnce(new Error('nothing to commit'))
    mount()
    await loaded()
    const box = screen.getByPlaceholderText('git.commitPlaceholder')
    fireEvent.change(box, { target: { value: 'feat: a' } })
    fireEvent.click(screen.getByText('git.commit').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('nothing to commit')).toBeDefined()

    api.commit.mockRejectedValueOnce('hook failed')
    fireEvent.change(box, { target: { value: 'feat: b' } })
    fireEvent.click(screen.getByText('git.commit').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('hook failed')).toBeDefined()
  })

  it('disables the commit buttons and explains why', async () => {
    mount()
    await loaded()
    const commitButton = screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement
    expect(commitButton.disabled).toBe(true)
    expect(commitButton.title).toBe('git.commitDisabled')
    expect(screen.getByText('git.commit').closest('button')?.disabled).toBe(true)

    cleanup()
    api.status.mockResolvedValue(status({
      conflicted: [{ status: 'UU', path: 'conflict.txt' }],
    }))
    mount()
    await loaded()
    const blocked = screen.getByText('git.commitAndPush').closest('button') as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    expect(blocked.title).toBe('git.conflictBlockCommit')
  })

  it('disables the commit buttons while a commit is in flight', async () => {
    const pending = deferred<{ ok: boolean; hash: string }>()
    api.commit.mockReturnValue(pending.promise)
    mount()
    await loaded()
    fireEvent.change(screen.getByPlaceholderText('git.commitPlaceholder'), { target: { value: 'feat: slow' } })
    fireEvent.click(screen.getByText('git.commit').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.commit).toHaveBeenCalled() })
    expect(screen.getByText('git.commit').closest('button')?.disabled).toBe(true)
    await act(async () => { pending.resolve({ ok: true, hash: 'slow1' }) })
    await waitFor(() => { expect(screen.getByText('git.commit').closest('button')?.disabled).toBe(true) })
  })
})

describe('GitPanel message generation', () => {
  it('streams deltas into the box and keeps the final message', async () => {
    api.generate.mockImplementation(async (_cwd: string, _token: string, onText: (delta: string) => void) => {
      onText('feat')
      onText(': generated')
      return 'feat: generated'
    })
    mount()
    await loaded()
    fireEvent.click(screen.getByText('✦ git.generate').closest('button') as HTMLButtonElement)
    await waitFor(() => {
      expect(screen.getByPlaceholderText<HTMLTextAreaElement>('git.commitPlaceholder').value).toBe('feat: generated')
    })
    expect(api.generate).toHaveBeenCalledWith('/ws', 'gen-1', expect.any(Function), undefined)
  })

  it('passes the stored generation model', async () => {
    localStorage.setItem('dsh-git-gen-model', 'p/m1')
    mount()
    await loaded()
    fireEvent.click(screen.getByText('✦ git.generate').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.generate).toHaveBeenCalledWith('/ws', 'gen-1', expect.any(Function), 'p/m1') })
  })

  it('cancels a running generation and keeps the partial text', async () => {
    const pending = deferred<string>()
    api.generate.mockReturnValue(pending.promise)
    mount()
    await loaded()
    fireEvent.click(screen.getByText('✦ git.generate').closest('button') as HTMLButtonElement)
    const stop = screen.getByText('git.stop').closest('button') as HTMLButtonElement
    expect(stop.title).toBe('git.stop')
    fireEvent.click(stop)
    expect(api.generateCancel).toHaveBeenCalledWith('gen-1')
    const stopping = screen.getByText('git.stopping').closest('button') as HTMLButtonElement
    expect(stopping.disabled).toBe(true)
    await act(async () => { pending.resolve('partial') })
    await waitFor(() => {
      expect(screen.getByPlaceholderText<HTMLTextAreaElement>('git.commitPlaceholder').value).toBe('partial')
    })
    expect(screen.getByText('✦ git.generate')).toBeDefined()
  })

  it('ticks the elapsed seconds while generating', async () => {
    const pending = deferred<string>()
    api.generate.mockReturnValue(pending.promise)
    mount({ translate: paramT })
    await waitFor(() => { expect(screen.getAllByText('main').length).toBeGreaterThan(0) })
    vi.useFakeTimers()
    fireEvent.click(screen.getByText('✦ git.generate').closest('button') as HTMLButtonElement)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText(/git\.generating \{"n":1\}/)).toBeDefined()
    await act(async () => { pending.resolve('done') })
    vi.useRealTimers()
  })

  it('restores the original message and reports generation errors', async () => {
    api.generate.mockRejectedValue(new Error('quota exceeded'))
    mount()
    await loaded()
    const box = screen.getByPlaceholderText('git.commitPlaceholder') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'my draft' } })
    fireEvent.click(screen.getByText('✦ git.generate').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('quota exceeded')).toBeDefined()
    expect(box.value).toBe('my draft')
  })

  it('stringifies a non-Error generation failure', async () => {
    api.generate.mockRejectedValue('model offline')
    mount()
    await loaded()
    fireEvent.click(screen.getByText('✦ git.generate').closest('button') as HTMLButtonElement)
    expect(await screen.findByText('model offline')).toBeDefined()
  })
})

describe('GitPanel commit rules', () => {
  it.each([
    ['repo', 'git.sourceRepo'],
    ['global', 'git.sourceGlobal'],
    ['builtin', 'git.sourceBuiltin'],
  ] as const)('labels the %s rule source', async (source, label) => {
    api.rules.mockResolvedValue({ ...RULES, source })
    mount({ translate: paramT })
    await loaded()
    fireEvent.click(screen.getByTitle('git.rules'))
    expect(await screen.findByText(new RegExp(label))).toBeDefined()
  })

  it('labels an unavailable rule source', async () => {
    api.rules.mockRejectedValue(new Error('missing'))
    mount({ translate: paramT })
    await loaded()
    fireEvent.click(screen.getByTitle('git.rules'))
    expect(await screen.findByText(/git\.rulesSource \{"source":"—"\}/)).toBeDefined()
  })

  it('copies the effective rules and clears the toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mount()
    await loaded()
    vi.useFakeTimers()
    fireEvent.click(screen.getByTitle('git.rules'))
    await act(async () => {})
    fireEvent.click(screen.getByText('git.copyRules'))
    expect(writeText).toHaveBeenCalledWith('sys\n\nctx')
    expect(screen.getByText('git.copied')).toBeDefined()
    act(() => { vi.advanceTimersByTime(2600) })
    expect(screen.queryByText('git.copied')).toBeNull()
    vi.useRealTimers()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('reports a clipboard failure', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('git.rules'))
    await screen.findByText('git.copyRules')
    fireEvent.click(screen.getByText('git.copyRules'))
    expect(screen.getByText('git.copyFailed')).toBeDefined()
  })

  it('edits and saves the rules, closing the editor and reloading them', async () => {
    mount()
    await loaded()
    const modal = await openRuleEditor()
    const editors = within(modal).getAllByRole('textbox') as HTMLTextAreaElement[]
    expect(editors[0]?.value).toBe('sys')
    expect(editors[1]?.value).toBe('ctx')
    expect(within(modal).getAllByText('ctx').length).toBeGreaterThan(0)
    fireEvent.change(editors[0] as HTMLTextAreaElement, { target: { value: 'new sys' } })
    fireEvent.change(editors[1] as HTMLTextAreaElement, { target: { value: '' } })
    expect(within(modal).getByText('—')).toBeDefined()
    fireEvent.click(within(modal).getAllByRole('radio')[0] as HTMLInputElement)
    fireEvent.click(within(modal).getAllByRole('radio')[1] as HTMLInputElement)
    fireEvent.click(within(modal).getByText('git.save').closest('button') as HTMLButtonElement)
    await waitFor(() => {
      expect(api.rulesSave).toHaveBeenCalledWith('/ws', 'ws', 'repo', 'new sys', '')
    })
    await waitFor(() => { expect(screen.queryByText('git.rulesTitle')).toBeNull() })
    expect(api.rules.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not save an empty system prompt', async () => {
    mount()
    await loaded()
    const modal = await openRuleEditor()
    const editors = within(modal).getAllByRole('textbox') as HTMLTextAreaElement[]
    fireEvent.change(editors[0] as HTMLTextAreaElement, { target: { value: '   ' } })
    expect(within(modal).getByText('git.save').closest('button')?.disabled).toBe(true)
    fireEvent.click(within(modal).getByText('git.save'))
    expect(api.rulesSave).not.toHaveBeenCalled()
  })

  it('disables the editor actions while saving', async () => {
    const pending = deferred<{ ok: boolean }>()
    api.rulesSave.mockReturnValue(pending.promise)
    mount()
    await loaded()
    const modal = await openRuleEditor()
    fireEvent.click(within(modal).getByText('git.save').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.rulesSave).toHaveBeenCalled() })
    expect(within(modal).getByText('git.save').closest('button')?.disabled).toBe(true)
    expect(within(modal).getByText('git.rulesReset').closest('button')?.disabled).toBe(true)
    await act(async () => { pending.resolve({ ok: true }) })
    await waitFor(() => { expect(screen.queryByText('git.rulesTitle')).toBeNull() })
  })

  it('resets the repo-scoped rules and closes the editor', async () => {
    mount()
    await loaded()
    const modal = await openRuleEditor()
    fireEvent.click(within(modal).getByText('git.rulesReset').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.rulesReset).toHaveBeenCalledWith('/ws', 'ws', 'repo') })
    fireEvent.click(within(modal).getByText('git.cancel').closest('button') as HTMLButtonElement)
    expect(screen.queryByText('git.rulesTitle')).toBeNull()
  })

  it('edits rules when none could be loaded (global scope)', async () => {
    api.rules.mockRejectedValue(new Error('missing'))
    mount()
    await loaded()
    const modal = await openRuleEditor()
    const editors = within(modal).getAllByRole('textbox') as HTMLTextAreaElement[]
    expect(editors[0]?.value).toBe('')
    fireEvent.change(editors[0] as HTMLTextAreaElement, { target: { value: 'custom' } })
    fireEvent.click(within(modal).getByText('git.rulesReset').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(api.rulesReset).toHaveBeenCalledWith('/ws', 'ws', 'global') })
  })

  it('closes the rules menu without refetching', async () => {
    mount()
    await loaded()
    await openRulesMenu()
    expect(api.rules).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('git.rules'))
    expect(screen.queryByText('git.rulesSource')).toBeNull()
    expect(api.rules).toHaveBeenCalledTimes(1)
  })

  it('keeps the editor closed when the rules reload fails', async () => {
    api.rules.mockResolvedValueOnce(RULES).mockRejectedValueOnce(new Error('gone'))
    mount()
    await loaded()
    const modal = await openRuleEditor()
    fireEvent.click(within(modal).getByText('git.save').closest('button') as HTMLButtonElement)
    await waitFor(() => { expect(screen.queryByText('git.rulesTitle')).toBeNull() })
    expect(api.rules).toHaveBeenCalledTimes(2)
  })

  it('copies empty rules when none could be loaded', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    api.rules.mockRejectedValue(new Error('missing'))
    mount()
    await loaded()
    const rulesMenu = await openRulesMenu()
    fireEvent.click(within(rulesMenu).getByText('git.copyRules'))
    expect(writeText).toHaveBeenCalledWith('\n\n')
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('picks, persists, and clears the generation model', async () => {
    api.models.mockResolvedValue({ models: [
      { provider: 'p', model: 'm1', name: 'Model One' },
      { provider: 'p', model: 'm2', name: '' },
    ] satisfies readonly GitModel[] })
    mount()
    await loaded()
    const rulesMenu = await openRulesMenu()
    fireEvent.click(within(rulesMenu).getByText('git.genModel'))
    expect(screen.getByText('git.genModelDefault ✓')).toBeDefined()
    expect(screen.getByText(/Model One \(p\)/)).toBeDefined()
    expect(screen.getByText('m2 (p)')).toBeDefined()
    fireEvent.click(screen.getByText(/Model One \(p\)/))
    expect(localStorage.getItem('dsh-git-gen-model')).toBe('p/m1')
    await waitFor(() => { expect(screen.queryByText('git.genModelDefault ✓')).toBeNull() })

    const reopened = await openRulesMenu()
    fireEvent.click(within(reopened).getByText('git.genModel'))
    expect(screen.getByText(/Model One \(p\) ✓/)).toBeDefined()
    fireEvent.click(screen.getByText('git.genModelDefault').closest('button') as HTMLButtonElement)
    expect(localStorage.getItem('dsh-git-gen-model')).toBeNull()
  })

  it('keeps working when local storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    mount()
    await loaded()
    vi.restoreAllMocks()
    const rulesMenu = await openRulesMenu()
    fireEvent.click(within(rulesMenu).getByText('git.genModel'))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    fireEvent.click(screen.getByText(/git\.genModelDefault/))
    vi.restoreAllMocks()
    const reopened = await openRulesMenu()
    fireEvent.click(within(reopened).getByText('git.genModel'))
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    fireEvent.click(screen.getByText(/git\.genModelDefault/))
    expect(screen.queryByText(/git\.genModelDefault/)).toBeNull()
  })
})

describe('GitPanel more menu', () => {
  it('lists stash entries and pops one', async () => {
    api.stashList.mockResolvedValue({ entries: [
      { name: 'stash@{0}', message: 'wip' },
      { name: 'stash@{1}', message: '' },
    ] })
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    expect(await screen.findByText('stash@{0} wip ↑')).toBeDefined()
    expect(screen.getByText('stash@{1} ↑')).toBeDefined()
    fireEvent.click(screen.getByText('stash@{0} wip ↑'))
    await waitFor(() => { expect(api.stashPop).toHaveBeenCalledWith('/ws') })
  })

  it('stashes the working tree and toggles the menu without refetching', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    await waitFor(() => { expect(api.stashList).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByTitle('⋯'))
    fireEvent.click(screen.getByTitle('⋯'))
    await waitFor(() => { expect(api.stashList).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByText('git.stashPush'))
    await waitFor(() => { expect(api.stashPush).toHaveBeenCalledWith('/ws') })
  })

  it('keeps the menu usable when the stash list fails', async () => {
    api.stashList.mockRejectedValue(new Error('no stash'))
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    expect(await screen.findByText('git.push')).toBeDefined()
    expect(screen.queryByText(/stash@/)).toBeNull()
  })

  it('pushes from the more menu and explains a missing upstream', async () => {
    api.push.mockRejectedValue(new Error('upstream missing'))
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    fireEvent.click(await screen.findByText('git.push'))
    expect(await screen.findByText('git.pushFailed')).toBeDefined()
    expect(screen.getByText('git.pushNoUpstreamHint')).toBeDefined()
  })

  it('stringifies a non-Error push rejection from the more menu', async () => {
    api.push.mockRejectedValue('push string')
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    fireEvent.click(await screen.findByText('git.push'))
    expect(await screen.findByText('push string')).toBeDefined()
  })

  it('uses the origin hint before the branch state settles', async () => {
    api.status.mockReturnValue(deferred<GitStatus>().promise)
    api.branches.mockReturnValue(deferred<GitBranches>().promise)
    api.log.mockReturnValue(deferred<{ commits: readonly GitCommit[]; hasMore: boolean }>().promise)
    api.push.mockRejectedValue(new Error('upstream missing'))
    mount()
    fireEvent.click(await screen.findByTitle('⋯'))
    fireEvent.click(await screen.findByText('git.push'))
    expect(await screen.findByText('git.pushFailed')).toBeDefined()
    expect(screen.getByText('git.pushNoUpstreamHint')).toBeDefined()
  })

  it('resets hard after confirmation', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    fireEvent.click(await screen.findByText('git.resetHard'))
    expect(screen.getByText('git.confirmResetHard')).toBeDefined()
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.reset).toHaveBeenCalledWith('/ws', 'hard') })
    expect(screen.queryByText('git.confirmResetHard')).toBeNull()
  })

  it('cleans all untracked files after confirmation', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    fireEvent.click(await screen.findByText('git.cleanUntracked'))
    expect(screen.getByText('git.confirmClean (3)')).toBeDefined()
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => {
      expect(api.clean).toHaveBeenCalledWith('/ws', ['new.txt', 'sub/a.txt', 'sub/deep/b.txt'])
    })
  })

  it('aborts a merge from the more menu', async () => {
    api.status.mockResolvedValue(status({ mergeState: 'merge' }))
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('⋯'))
    const moreMenu = await waitFor(() => menu('git.push'))
    fireEvent.click(within(moreMenu).getByText('git.abortMerge'))
    expect(screen.getByText('git.confirmMergeAbort')).toBeDefined()
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.mergeAbort).toHaveBeenCalledWith('/ws') })
  })
})

describe('GitPanel merge state', () => {
  it('shows conflicts and aborts from the merge bar', async () => {
    api.status.mockResolvedValue(status({
      mergeState: 'merge',
      conflicted: [{ status: 'UU', path: 'a.txt' }, { status: 'UU', path: 'b.txt' }],
    }))
    mount()
    await loaded()
    expect(screen.getByText('git.mergeConflicts')).toBeDefined()
    expect(screen.queryByText('git.completeMerge')).toBeNull()
    fireEvent.click(screen.getByText('git.abortMerge'))
    fireEvent.click(screen.getByText('git.cancel'))
    expect(screen.queryByText('git.confirmMergeAbort')).toBeNull()
  })

  it('offers to complete a clean-index merge', async () => {
    api.status.mockResolvedValue(status({ mergeState: 'merge' }))
    mount()
    await loaded()
    expect(screen.getByText('git.mergeCleanIndex')).toBeDefined()
    fireEvent.click(screen.getByText('git.completeMerge'))
    await waitFor(() => { expect(api.mergeComplete).toHaveBeenCalledWith('/ws') })
  })

  it('explains that staged changes finish the merge', async () => {
    api.status.mockResolvedValue(status({
      mergeState: 'merge',
      staged: [{ status: 'M ', path: 'a.txt' }],
    }))
    mount()
    await loaded()
    expect(screen.getByText('git.mergeStageToCommit')).toBeDefined()
    expect(screen.queryByText('git.completeMerge')).toBeNull()
  })

  it('shows the terminal hint for other merge states', async () => {
    api.status.mockResolvedValue(status({ mergeState: 'rebase' }))
    mount()
    await loaded()
    expect(screen.getByText('git.mergeTerminalHint')).toBeDefined()
    expect(screen.queryByText('git.completeMerge')).toBeNull()
  })

  it('confirms a merge abort from the bar', async () => {
    api.status.mockResolvedValue(status({ mergeState: 'merge' }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.abortMerge'))
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.mergeAbort).toHaveBeenCalledWith('/ws') })
  })
})

describe('GitPanel working-tree groups', () => {
  it('runs the bulk actions for every group', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.markResolvedAll'))
    await waitFor(() => { expect(api.stage).toHaveBeenCalledWith('/ws', ['conflict.txt']) })
    fireEvent.click(screen.getByText('git.unstageAll'))
    await waitFor(() => { expect(api.unstage).toHaveBeenCalledWith('/ws', ['staged.txt', 'added.txt']) })
    const stageAll = screen.getAllByText('git.stageAll')
    fireEvent.click(stageAll[0] as HTMLElement)
    await waitFor(() => { expect(api.stage).toHaveBeenCalledWith('/ws', ['dir/change.txt']) })
    fireEvent.click(stageAll[1] as HTMLElement)
    await waitFor(() => {
      expect(api.stage).toHaveBeenCalledWith('/ws', ['new.txt', 'sub/a.txt', 'sub/deep/b.txt'])
    })
    expect(screen.getByText('git.conflicts')).toBeDefined()
  })

  it('stages, unstages, and opens rows by click', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('change.txt')).getByTitle('git.stage'))
    await waitFor(() => { expect(api.stage).toHaveBeenCalledWith('/ws', ['dir/change.txt']) })
    fireEvent.click(within(fileRow('staged.txt')).getByTitle('git.unstage'))
    await waitFor(() => { expect(api.unstage).toHaveBeenCalledWith('/ws', ['staged.txt']) })
    fireEvent.click(screen.getByText('change.txt'))
    await waitFor(() => { expect(api.diff).toHaveBeenCalledWith('/ws', 'dir/change.txt', false, false) })
  })

  it('discards a staged file and an unstaged file with the right staged flag', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('staged.txt')).getByTitle('git.discard'))
    expect(screen.getByText('git.confirmDiscard (1)')).toBeDefined()
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.discard).toHaveBeenCalledWith('/ws', ['staged.txt'], true) })

    fireEvent.click(within(fileRow('change.txt')).getByTitle('git.discard'))
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.discard).toHaveBeenCalledWith('/ws', ['dir/change.txt'], false) })
  })

  it('cancels a discard from the backdrop', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('change.txt')).getByTitle('git.discard'))
    const title = screen.getByText('git.confirmDiscard (1)')
    fireEvent.click(title.parentElement?.parentElement as HTMLElement)
    expect(screen.queryByText('git.confirmDiscard (1)')).toBeNull()
    expect(api.discard).not.toHaveBeenCalled()
  })

  it('cancels a confirm with Escape', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('change.txt')).getByTitle('git.discard'))
    expect(screen.getByText('git.confirmDiscard (1)')).toBeDefined()
    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.getByText('git.confirmDiscard (1)')).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('git.confirmDiscard (1)')).toBeNull()
    expect(api.discard).not.toHaveBeenCalled()
  })

  it('opens and stages a conflicted row', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('conflict.txt')).getByTitle('git.stage'))
    await waitFor(() => { expect(api.stage).toHaveBeenCalledWith('/ws', ['conflict.txt']) })
    fireEvent.click(screen.getByText('conflict.txt'))
    await waitFor(() => { expect(api.diff).toHaveBeenCalledWith('/ws', 'conflict.txt', false, false) })
  })

  it('shows the rename source in the file row', async () => {
    api.status.mockResolvedValue(status({
      unstaged: [{ status: 'R ', path: 'newname.txt', renameFrom: 'oldname.txt' }],
    }))
    mount()
    await loaded()
    expect((screen.getByTitle('newname.txt').parentElement as HTMLElement).textContent).toContain('oldname.txt →')
  })

  it('collapses and expands a group without triggering its bulk action', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.changes'))
    expect(screen.queryByText('change.txt')).toBeNull()
    fireEvent.click(screen.getByText('git.changes'))
    expect(screen.getByText('change.txt')).toBeDefined()
    fireEvent.click(screen.getByText('git.markResolvedAll'))
    expect(api.stage).toHaveBeenCalled()
    expect(screen.getByText('conflict.txt')).toBeDefined()
  })

  it('disables every row action while one action runs', async () => {
    const pending = deferred<{ ok: boolean }>()
    api.stage.mockReturnValue(pending.promise)
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('change.txt')).getByTitle('git.stage'))
    await waitFor(() => { expect(api.stage).toHaveBeenCalled() })
    expect(within(fileRow('change.txt')).getByTitle('git.stage').closest('button')?.disabled).toBe(true)
    expect(within(fileRow('staged.txt')).getByTitle('git.unstage').closest('button')?.disabled).toBe(true)
    expect(within(fileRow('staged.txt')).getByTitle('git.discard').closest('button')?.disabled).toBe(true)
    await act(async () => { pending.resolve({ ok: true }) })
  })

  it('reports a stage failure that is not an Error', async () => {
    api.stage.mockRejectedValue('rejected')
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('change.txt')).getByTitle('git.stage'))
    expect(await screen.findByText('rejected')).toBeDefined()
  })
})

describe('GitPanel untracked tree', () => {
  it('renders root files, directories, and nested directory names', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    const tree = screen.getByText('new.txt').closest('div')?.parentElement as HTMLElement
    expect(within(tree).getByText('sub/')).toBeDefined()
    expect(within(tree).getByText('sub/deep/')).toBeDefined()
    expect(within(tree).getByText('a.txt')).toBeDefined()
  })

  it('stages and deletes every file under a directory', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    const dirRow = screen.getByText('sub/').closest('div') as HTMLElement
    fireEvent.click(within(dirRow).getByText('git.deleteFile'))
    expect(screen.getByText('git.confirmClean (2)')).toBeDefined()
    fireEvent.click(screen.getByText('git.cancel'))
    fireEvent.click(dirRow)
    await waitFor(() => {
      expect(api.stage).toHaveBeenCalledWith('/ws', ['sub/a.txt', 'sub/deep/b.txt'])
    })
  })

  it('deletes a single untracked file and opens its diff', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('new.txt')).getByTitle('git.deleteFile'))
    expect(screen.getByText('git.confirmClean (1)')).toBeDefined()
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.clean).toHaveBeenCalledWith('/ws', ['new.txt']) })

    fireEvent.click(within(fileRow('new.txt')).getByTitle('git.stage'))
    await waitFor(() => { expect(api.stage).toHaveBeenCalledWith('/ws', ['new.txt']) })
    fireEvent.click(screen.getByText('new.txt'))
    await waitFor(() => { expect(api.diff).toHaveBeenCalledWith('/ws', 'new.txt', false, true) })
  })

  it('deletes one file inside the untracked tree', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('a.txt')).getByTitle('git.deleteFile'))
    expect(screen.getByText('git.confirmClean (1)')).toBeDefined()
    fireEvent.click(screen.getByText('git.confirm'))
    await waitFor(() => { expect(api.clean).toHaveBeenCalledWith('/ws', ['sub/a.txt']) })
  })

  it('stages and opens a tree file', async () => {
    api.status.mockResolvedValue(FULL_STATUS)
    mount()
    await loaded()
    fireEvent.click(within(fileRow('a.txt')).getByTitle('git.stage'))
    await waitFor(() => { expect(api.stage).toHaveBeenCalledWith('/ws', ['sub/a.txt']) })
    fireEvent.click(screen.getByText('a.txt'))
    await waitFor(() => { expect(api.diff).toHaveBeenCalledWith('/ws', 'sub/a.txt', false, true) })
  })
})

describe('GitPanel diff drawer', () => {
  it('renders a text diff, toggles wrap, and closes with Escape', async () => {
    api.status.mockResolvedValue(status({ unstaged: [{ status: ' M', path: 'dir/change.txt' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('change.txt'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(drawer.getAttribute('aria-label')).toBe('dir/change.txt')
    expect(within(drawer).getByText('old line')).toBeDefined()
    expect(within(drawer).getByText('new line')).toBeDefined()
    expect(within(drawer).getByText('+1')).toBeDefined()
    expect(within(drawer).getByText('−1')).toBeDefined()
    expect(within(drawer).getByText('git.pairWorktree')).toBeDefined()
    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.getByRole('dialog')).toBeDefined()
    const wrapButton = within(drawer).getByTitle('git.wrap')
    expect(wrapButton.textContent).toBe('⇤')
    fireEvent.click(wrapButton)
    expect(wrapButton.textContent).toBe('⇥')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes with the header close button and confirms a staged pair', async () => {
    api.status.mockResolvedValue(status({ staged: [{ status: 'M ', path: 'staged.txt' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('staged.txt'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(within(drawer).getByText('git.pairStaged')).toBeDefined()
    expect(api.diff).toHaveBeenCalledWith('/ws', 'staged.txt', true, false)
    fireEvent.click(within(drawer).getByTitle('git.close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders conflict-marker rows in both columns', async () => {
    api.diff.mockResolvedValue({ diff: CONFLICT_DIFF })
    api.status.mockResolvedValue(status({ unstaged: [{ status: 'UU', path: 'a.txt' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('a.txt'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(within(drawer).getAllByText('<<<<<<< HEAD')).toHaveLength(2)
  })

  it('reports a diff failure', async () => {
    api.diff.mockRejectedValue(new Error('diff failed'))
    api.status.mockResolvedValue(status({ unstaged: [{ status: ' M', path: 'dir/change.txt' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('change.txt'))
    expect(await screen.findByText('diff failed')).toBeDefined()
    api.diff.mockRejectedValue('diff string')
    fireEvent.click(screen.getByText('change.txt'))
    expect(await screen.findByText('diff string')).toBeDefined()
  })

  it('renders the empty-diff note', () => {
    render(<DiffDrawer
      file={{ status: ' M', path: 'a.txt' }}
      rows={[]}
      staged={false}
      wrap={false}
      onToggleWrap={() => {}}
      onClose={() => {}}
      t={t}
    />)
    expect(screen.getByText('git.noDiff')).toBeDefined()
  })
})

describe('GitPanel image previews', () => {
  it('previews both versions and drives the fullscreen switch', async () => {
    api.status.mockResolvedValue(status({ unstaged: [{ status: ' M', path: 'img/pic.png' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('pic.png'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(within(drawer).getByAltText('git.imageOld')).toBeDefined()
    expect(within(drawer).getByAltText('git.imageNew')).toBeDefined()
    expect(api.blob).toHaveBeenCalledWith('/ws', 'img/pic.png', 'head')
    expect(api.blob).toHaveBeenCalledWith('/ws', 'img/pic.png', 'worktree')

    fireEvent.click(within(drawer).getByAltText('git.imageOld'))
    const bar = screen.getByTitle('git.imageSwitch').parentElement as HTMLElement
    expect(within(bar).getByText('git.imageOld')).toBeDefined()
    fireEvent.click(screen.getByTitle('git.imageSwitch'))
    expect(within(bar).getByText('git.imageNew')).toBeDefined()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    const fullImage = document.querySelector('img[alt=""]') as HTMLImageElement
    const backdrop = fullImage.parentElement?.parentElement?.parentElement as HTMLElement
    fireEvent.click(backdrop)
    expect(document.querySelector('img[alt=""]')).toBeNull()
    expect(screen.getByRole('dialog')).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('loads the staged side from the index and closes via the close button', async () => {
    api.status.mockResolvedValue(status({ staged: [{ status: 'A ', path: 'img/new.png' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('new.png'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(api.blob).toHaveBeenCalledWith('/ws', 'img/new.png', 'index')
    fireEvent.click(within(drawer).getByTitle('git.close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the old-version error and the missing new version', async () => {
    api.blob.mockImplementation((_cwd: string, _path: string, source: string) =>
      source === 'head'
        ? Promise.reject(new Error('gone'))
        : Promise.reject(new Error('missing')))
    api.status.mockResolvedValue(status({ unstaged: [{ status: ' M', path: 'img/pic.png' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('pic.png'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(within(drawer).getByText('gone')).toBeDefined()
    expect(within(drawer).getByText('git.imageMissing')).toBeDefined()
  })

  it('opens the new image fullscreen and closes it with the keyboard', async () => {
    api.status.mockResolvedValue(status({ unstaged: [{ status: ' M', path: 'img/pic.png' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('pic.png'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    fireEvent.click(within(drawer).getByAltText('git.imageNew'))
    const bar = screen.getByTitle('git.imageSwitch').parentElement as HTMLElement
    expect(within(bar).getByText('git.imageNew')).toBeDefined()
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(within(bar).getByText('git.imageOld')).toBeDefined()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a non-Error old-version failure', async () => {
    api.blob.mockImplementation((_cwd: string, _path: string, source: string) => {
      if (source !== 'head') {
        return Promise.resolve({ mime: 'image/png', size: 3, dataUrl: 'data:worktree' })
      }
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
      return Promise.reject('gone string')
    })
    api.status.mockResolvedValue(status({ unstaged: [{ status: ' M', path: 'img/pic.png' }] }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('pic.png'))
    const drawer = await waitFor(() => screen.getByRole('dialog'))
    expect(within(drawer).getByText('gone string')).toBeDefined()
  })

  it('renders the placeholder for a missing old version', () => {
    render(<ImageDiff
      file={{ status: ' M', path: 'img/pic.png' }}
      oldUrl={null}
      newUrl={null}
      oldError={null}
      onFullscreen={() => {}}
      onClose={() => {}}
      t={t}
    />)
    expect(screen.getByText('—')).toBeDefined()
  })
})

describe('GitPanel history', () => {
  it('renders the graph, hover card, and commit details', async () => {
    api.status.mockResolvedValue(status({ head: 'h1' }))
    api.log.mockResolvedValue({ commits: COMMITS, hasMore: false })
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.history'))
    expect(await screen.findByText('first commit')).toBeDefined()
    expect(screen.getByText('second commit')).toBeDefined()
    const svg = document.querySelector('svg') as SVGSVGElement
    expect(svg.querySelectorAll('path')).toHaveLength(1)
    expect(svg.querySelectorAll('circle')).toHaveLength(2)
    expect(svg.querySelector('circle[stroke]')).not.toBeNull()

    const row = screen.getByText('first commit').closest('li') as HTMLLIElement
    fireEvent.mouseEnter(row)
    const hover = screen.getByText('details').parentElement as HTMLElement
    expect(within(hover).getByText(/git\.fileCount/)).toBeDefined()
    expect(within(hover).getByText(/Ada <ada@example\.com>/)).toBeDefined()
    fireEvent.mouseLeave(row)
    expect(screen.queryByText('details')).toBeNull()

    fireEvent.mouseEnter(screen.getByText('second commit').closest('li') as HTMLLIElement)
    expect(screen.queryByText('details')).toBeNull()
    fireEvent.click(screen.getByText('git.history'))
    expect(screen.queryByText('first commit')).toBeNull()
  })

  it('shows the no-commits note', async () => {
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.history'))
    expect(screen.getByText('git.noCommits')).toBeDefined()
  })

  it('loads the next page when the sentinel intersects', async () => {
    let observer: IntersectionObserverCallback | undefined
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) { observer = callback }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = ''
      thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    api.log.mockImplementation((_cwd: string, skip: number) => Promise.resolve({
      commits: skip === 0 ? COMMITS : [COMMITS[1] as GitCommit],
      hasMore: skip === 0,
    }))
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.history'))
    expect(await screen.findByText('first commit')).toBeDefined()
    expect(screen.getByText('git.loadMore')).toBeDefined()
    await act(async () => {
      observer?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(api.log).toHaveBeenCalledTimes(1)
    await act(async () => {
      observer?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    await waitFor(() => { expect(api.log).toHaveBeenCalledWith('/ws', 2, 100) })
    expect(screen.getAllByText('second commit').length).toBeGreaterThan(1)
  })

  it('does not paginate when there is no next page', async () => {
    let observer: IntersectionObserverCallback | undefined
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) { observer = callback }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = ''
      thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    api.log.mockResolvedValue({ commits: COMMITS, hasMore: false })
    mount()
    await loaded()
    fireEvent.click(screen.getByText('git.history'))
    await screen.findByText('first commit')
    await act(async () => {
      observer?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(api.log).toHaveBeenCalledTimes(1)
  })
})

describe('GitPanel misc states', () => {
  it('shows the clean note when nothing changed', async () => {
    mount()
    await loaded()
    expect(screen.getByText('git.clean')).toBeDefined()
  })

  it('reports a pull failure', async () => {
    api.pull.mockRejectedValue(new Error('pull failed'))
    mount()
    await loaded()
    fireEvent.click(screen.getByTitle('git.pull'))
    expect(await screen.findByText('pull failed')).toBeDefined()
  })

  it('ignores repository results that arrive after unmount', async () => {
    const scan = deferred<{ repos: readonly GitRepo[] }>()
    api.repos.mockReturnValue(scan.promise)
    const view = mount()
    await act(async () => {})
    view.unmount()
    await act(async () => { scan.resolve({ repos: [REPO] }) })
    expect(api.status).not.toHaveBeenCalled()
  })

  it('ignores scan failures that arrive after unmount', async () => {
    const scan = deferred<{ repos: readonly GitRepo[] }>()
    api.repos.mockReturnValue(scan.promise)
    const view = mount()
    await act(async () => {})
    view.unmount()
    await act(async () => { scan.reject(new Error('late failure')) })
    expect(screen.queryByText('late failure')).toBeNull()
  })

  it('ignores model results that arrive after unmount', async () => {
    const models = deferred<{ models: readonly GitModel[] }>()
    api.models.mockReturnValue(models.promise)
    const view = mount()
    await loaded()
    view.unmount()
    await act(async () => { models.resolve({ models: [] }) })
    expect(screen.queryByText('git.genModel')).toBeNull()
  })

  it('ignores model failures that arrive after unmount', async () => {
    const models = deferred<{ models: readonly GitModel[] }>()
    api.models.mockReturnValue(models.promise)
    const view = mount()
    await loaded()
    view.unmount()
    await act(async () => { models.reject(new Error('late models')) })
    expect(screen.queryByText('git.genModel')).toBeNull()
  })

  it('cleans untracked files before the status settles', async () => {
    const pending = deferred<GitStatus>()
    api.status.mockReturnValue(pending.promise)
    mount()
    fireEvent.click(await screen.findByTitle('⋯'))
    fireEvent.click(await screen.findByText('git.cleanUntracked'))
    expect(screen.getByText('git.confirmClean (0)')).toBeDefined()
    fireEvent.click(screen.getByText('git.cancel'))
  })

  it('renders an empty commit graph canvas', () => {
    render(<CommitGraph nodes={[]} commits={[]} headHash="" />)
    const svg = document.querySelector('svg') as SVGSVGElement
    expect(svg.getAttribute('width')).toBe('26')
    expect(svg.getAttribute('height')).toBe('44')
  })
})
