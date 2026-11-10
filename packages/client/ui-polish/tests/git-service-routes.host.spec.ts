/** Git panel host service: the remaining route branches against real temporary repositories. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  findRepos, findReposCached, handleGitRequest, imageMimeOf, ruleKey, workspaceCwdResolver,
  type CommitMessageBridge,
} from '../src/git-service.ts'

const run = promisify(execFile)

let homeDir: string
const previousHome: string | undefined = process.env['DSH_HOME']

beforeAll(async () => {
  homeDir = await mkdtemp(`${tmpdir()}/dsh-git-routes-home-`)
  process.env['DSH_HOME'] = homeDir
})

afterAll(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(homeDir, { recursive: true, force: true })
})

/** Build a throwaway git repository with an initial commit. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/dsh-git-routes-`)
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'alpha\n')
  await run('git', ['add', 'a.txt'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  return dir
}

/** A bare remote plus a clone wired to it, so push/pull have an upstream. */
async function makeRemotePair(): Promise<{ bare: string; clone: string }> {
  const bare = await mkdtemp(`${tmpdir()}/dsh-git-bare-`)
  await run('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare })
  const source = await makeRepo()
  await run('git', ['remote', 'add', 'origin', bare], { cwd: source })
  await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: source })
  const clone = await mkdtemp(`${tmpdir()}/dsh-git-clone-`)
  await run('git', ['clone', '-q', bare, '.'], { cwd: clone })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: clone })
  await run('git', ['config', 'user.name', 'Test'], { cwd: clone })
  return { bare, clone }
}

/** In-memory response double capturing status, writes, and the final body. */
function responseDouble() {
  let statusCode = 0
  let written = ''
  let ended = false
  let headers = false
  return {
    res: {
      writeHead(status: number) { statusCode = status; headers = true },
      write(chunk: string) { written += chunk },
      end(payload?: string) {
        if (payload !== undefined) written += payload
        ended = true
      },
      get writableEnded() { return ended },
      get headersSent() { return headers },
    },
    get status(): number { return statusCode },
    get raw(): string { return written },
    get body(): Record<string, unknown> { return JSON.parse(written) as Record<string, unknown> },
    get lines(): Record<string, unknown>[] {
      return written.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>)
    },
  }
}

/** Minimal request double: URL + method + optional JSON body. */
function requestDouble(path: string, method: string, body?: unknown) {
  return {
    url: path,
    method,
    on(event: 'data' | 'end' | 'error', fn: (chunk?: Buffer) => void) {
      if (event === 'data' && body !== undefined) fn(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      if (event === 'end') fn()
    },
  }
}

/** One request against a repo whose cwd is the only known workspace. */
async function call(
  repo: string,
  path: string,
  method: string,
  body?: unknown,
  bridge?: CommitMessageBridge,
) {
  const double = responseDouble()
  await handleGitRequest(
    workspaceCwdResolver([repo], repo),
    requestDouble(path, method, body) as never,
    double.res as never,
    bridge,
  )
  return double
}

describe('status and branches', () => {
  it('reports a non-repository workspace', async () => {
    const plain = await mkdtemp(`${tmpdir()}/dsh-git-plain-`)
    try {
      const double = await call(plain, `/git/status?cwd=${encodeURIComponent(plain)}`, 'GET')
      expect(double.status).toBe(200)
      expect(double.body['isRepo']).toBe(false)
      expect(double.body['branch']).toBe('')
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('lists local and remote branches with the upstream', async () => {
    const { bare, clone } = await makeRemotePair()
    try {
      const double = await call(clone, `/git/branches?cwd=${encodeURIComponent(clone)}`, 'GET')
      expect(double.status).toBe(200)
      const body = double.body as {
        current: string
        upstream?: string
        local: { name: string; current: boolean }[]
        remote: string[]
      }
      expect(body.current).toBe('main')
      expect(body.upstream).toBe('origin/main')
      expect(body.local).toEqual([{ name: 'main', current: true }])
      expect(body.remote).toContain('origin/main')
    } finally {
      await rm(bare, { recursive: true, force: true })
      await rm(clone, { recursive: true, force: true })
    }
  })


})

describe('show and blob', () => {
  it('serves a commit message with text and binary file stats', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
      await writeFile(join(repo, 'text.txt'), 'one\ntwo\n')
      await run('git', ['add', '.'], { cwd: repo })
      await run('git', ['commit', '-q', '-m', 'add files'], { cwd: repo })
      const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
      const double = await call(repo, `/git/show?cwd=${encodeURIComponent(repo)}&hash=${head}`, 'GET')
      expect(double.status).toBe(200)
      const body = double.body as { message: string; files: { path: string; add: number; del: number; binary: boolean }[] }
      expect(body.message).toBe('add files')
      expect(body.files.find(f => f.path === 'text.txt')).toMatchObject({ add: 2, del: 0, binary: false })
      expect(body.files.find(f => f.path === 'bin.dat')).toMatchObject({ add: 0, del: 0, binary: true })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('requires a hash', async () => {
    const repo = await makeRepo()
    try {
      const double = await call(repo, `/git/show?cwd=${encodeURIComponent(repo)}`, 'GET')
      expect(double.status).toBe(500)
      expect(String(double.body['error'])).toContain('needs a hash')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('serves the index version and rejects unknown sources, paths, and missing worktree files', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'staged.txt'), 'staged\n')
      await run('git', ['add', 'staged.txt'], { cwd: repo })
      const index = await call(repo, `/git/blob?cwd=${encodeURIComponent(repo)}&path=staged.txt&source=index`, 'GET')
      expect(index.status).toBe(200)
      expect(index.body['mime']).toBe('application/octet-stream')
      expect(String(index.body['dataUrl'])).toBe(`data:application/octet-stream;base64,${Buffer.from('staged\n').toString('base64')}`)

      const noPath = await call(repo, `/git/blob?cwd=${encodeURIComponent(repo)}&source=head`, 'GET')
      expect(noPath.status).toBe(500)
      expect(String(noPath.body['error'])).toContain('needs a path')

      const badSource = await call(repo, `/git/blob?cwd=${encodeURIComponent(repo)}&path=a.txt&source=nope`, 'GET')
      expect(badSource.status).toBe(500)
      expect(String(badSource.body['error'])).toContain('source must be')

      const missing = await call(repo, `/git/blob?cwd=${encodeURIComponent(repo)}&path=gone.txt&source=worktree`, 'GET')
      expect(missing.status).toBe(500)
      expect(String(missing.body['error'])).toContain('not in the worktree')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('detects every supported image extension', () => {
    expect(imageMimeOf('a.png')).toBe('image/png')
    expect(imageMimeOf('a.jpg')).toBe('image/jpeg')
    expect(imageMimeOf('a.jpeg')).toBe('image/jpeg')
    expect(imageMimeOf('a.gif')).toBe('image/gif')
    expect(imageMimeOf('a.webp')).toBe('image/webp')
    expect(imageMimeOf('a.svg')).toBe('image/svg+xml')
    expect(imageMimeOf('a.bmp')).toBe('image/bmp')
    expect(imageMimeOf('a.txt')).toBeUndefined()
  })
})

describe('models, rules, and discovery', () => {
  it('requires an LLM bridge for models and generation', async () => {
    const repo = await makeRepo()
    try {
      const models = await call(repo, `/git/models?cwd=${encodeURIComponent(repo)}`, 'GET')
      expect(models.status).toBe(500)
      expect(String(models.body['error'])).toContain('no LLM service')
      const generate = await call(repo, '/git/generate', 'POST', { cwd: repo, token: 't1' })
      expect(generate.status).toBe(500)
      expect(String(generate.body['error'])).toContain('no LLM service')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('validates the rule request name', async () => {
    const repo = await makeRepo()
    try {
      const missing = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}`, 'GET')
      expect(missing.status).toBe(500)
      expect(String(missing.body['error'])).toContain('needs a repo name')
      const slash = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=a/b`, 'GET')
      expect(slash.status).toBe(500)
      expect(String(slash.body['error'])).toContain('invalid repository name')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('caches discovery and refreshes on demand', async () => {
    const root = await mkdtemp(`${tmpdir()}/dsh-git-cache-`)
    try {
      await run('git', ['init', '-q'], { cwd: root })
      const first = findReposCached(root, false)
      expect(first).toHaveLength(1)
      const nested = join(root, 'nested')
      await mkdir(nested, { recursive: true })
      await run('git', ['init', '-q'], { cwd: nested })
      // Cached until refreshed.
      expect(findReposCached(root, false)).toHaveLength(1)
      expect(findReposCached(root, true)).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('working-tree operations', () => {
  it('stages and unstages a short path list', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'b.txt'), 'beta\n')
      const staged = await call(repo, '/git/stage', 'POST', { cwd: repo, paths: ['b.txt'] })
      expect(staged.status).toBe(200)
      const status = (await run('git', ['status', '--porcelain'], { cwd: repo })).stdout
      expect(status).toContain('A  b.txt')
      const unstaged = await call(repo, '/git/unstage', 'POST', { cwd: repo, paths: ['b.txt'] })
      expect(unstaged.status).toBe(200)
      expect((await run('git', ['status', '--porcelain'], { cwd: repo })).stdout).toContain('?? b.txt')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('stages a long path list through the NUL-separated stdin pathspec', async () => {
    const repo = await makeRepo()
    try {
      const paths: string[] = []
      for (let i = 0; i < 300; i += 1) {
        const name = `many-${String(i).padStart(4, '0')}.txt`
        await writeFile(join(repo, name), `${i}\n`)
        paths.push(name)
      }
      const staged = await call(repo, '/git/stage', 'POST', { cwd: repo, paths })
      expect(staged.status).toBe(200)
      const unstaged = await call(repo, '/git/unstage', 'POST', { cwd: repo, paths })
      expect(unstaged.status).toBe(200)
      const status = (await run('git', ['status', '--porcelain'], { cwd: repo })).stdout
      expect(status).toContain('?? many-0000.txt')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('discards staged and worktree changes', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'a.txt'), 'changed\n')
      await run('git', ['add', 'a.txt'], { cwd: repo })
      const staged = await call(repo, '/git/discard', 'POST', { cwd: repo, paths: ['a.txt'], staged: true })
      expect(staged.status).toBe(200)
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('alpha\n')
      expect((await run('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('removes untracked files in chunks', async () => {
    const repo = await makeRepo()
    try {
      const paths: string[] = []
      for (let i = 0; i < 205; i += 1) {
        const name = `junk-${String(i).padStart(4, '0')}.txt`
        await writeFile(join(repo, name), 'x')
        paths.push(name)
      }
      const cleaned = await call(repo, '/git/clean', 'POST', { cwd: repo, paths })
      expect(cleaned.status).toBe(200)
      expect((await run('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('diffs staged, worktree, and untracked files', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'a.txt'), 'alpha changed\n')
      const worktree = await call(repo, '/git/diff', 'POST', { cwd: repo, path: 'a.txt', staged: false })
      expect(String(worktree.body['diff'])).toContain('-alpha')
      await run('git', ['add', 'a.txt'], { cwd: repo })
      const staged = await call(repo, '/git/diff', 'POST', { cwd: repo, path: 'a.txt', staged: true })
      expect(String(staged.body['diff'])).toContain('+alpha changed')
      await writeFile(join(repo, 'new.txt'), 'brand new\n')
      const untracked = await call(repo, '/git/diff', 'POST', { cwd: repo, path: 'new.txt', untracked: true })
      expect(String(untracked.body['diff'])).toContain('+brand new')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('commits, undo, push, and pull', () => {
  it('rejects an oversized commit message and an empty index', async () => {
    const repo = await makeRepo()
    try {
      const long = await call(repo, '/git/commit', 'POST', { cwd: repo, message: 'x'.repeat(4_097) })
      expect(long.status).toBe(500)
      expect(String(long.body['error'])).toContain('too long')
      const empty = await call(repo, '/git/commit', 'POST', { cwd: repo, message: 'feat: nothing' })
      expect(empty.status).toBe(500)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('refuses to undo the first commit', async () => {
    const repo = await makeRepo()
    try {
      const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
      const double = await call(repo, '/git/undo-commit', 'POST', { cwd: repo, hash: head })
      expect(double.status).toBe(500)
      expect(String(double.body['error'])).toContain('only has its first commit')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reports a push without an upstream', async () => {
    const repo = await makeRepo()
    const bare = await mkdtemp(`${tmpdir()}/dsh-git-bare-push-`)
    try {
      await run('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare })
      await run('git', ['remote', 'add', 'origin', bare], { cwd: repo })
      const double = await call(repo, '/git/push', 'POST', { cwd: repo })
      expect(double.status).toBe(500)
      expect(double.body['noUpstream']).toBe(true)
    } finally {
      await rm(bare, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('pushes and pulls through an upstream remote', async () => {
    const { bare, clone } = await makeRemotePair()
    try {
      await writeFile(join(clone, 'c.txt'), 'clone change\n')
      await run('git', ['add', 'c.txt'], { cwd: clone })
      await run('git', ['commit', '-q', '-m', 'clone change'], { cwd: clone })
      const pushed = await call(clone, '/git/push', 'POST', { cwd: clone })
      expect(pushed.status).toBe(200)
      // A second clone pushes a commit the first one pulls.
      const other = await mkdtemp(`${tmpdir()}/dsh-git-other-`)
      await run('git', ['clone', '-q', bare, '.'], { cwd: other })
      await run('git', ['config', 'user.email', 't@e.c'], { cwd: other })
      await run('git', ['config', 'user.name', 'T'], { cwd: other })
      await writeFile(join(other, 'd.txt'), 'other change\n')
      await run('git', ['add', 'd.txt'], { cwd: other })
      await run('git', ['commit', '-q', '-m', 'other change'], { cwd: other })
      await run('git', ['push', '-q'], { cwd: other })
      const pulled = await call(clone, '/git/pull', 'POST', { cwd: clone })
      expect(pulled.status).toBe(200)
      expect(pulled.body['fetchedOnly']).toBeUndefined()
      await rm(other, { recursive: true, force: true })
    } finally {
      await rm(bare, { recursive: true, force: true })
      await rm(clone, { recursive: true, force: true })
    }
  })

  it('refuses to pull during a merge', async () => {
    const repo = await makeRepo()
    try {
      await run('git', ['checkout', '-q', '-b', 'side'], { cwd: repo })
      await writeFile(join(repo, 'a.txt'), 'side\n')
      await run('git', ['commit', '-q', '-am', 'side'], { cwd: repo })
      await run('git', ['checkout', '-q', 'main'], { cwd: repo })
      await writeFile(join(repo, 'a.txt'), 'main\n')
      await run('git', ['commit', '-q', '-am', 'main'], { cwd: repo })
      await run('git', ['merge', 'side'], { cwd: repo }).catch(() => null)
      const double = await call(repo, '/git/pull', 'POST', { cwd: repo })
      expect(double.status).toBe(500)
      expect(String(double.body['error'])).toContain('merge or rebase is in progress')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('branches, stash, and reset', () => {
  it('switches to an existing branch and creates a new one', async () => {
    const repo = await makeRepo()
    try {
      await run('git', ['branch', 'existing'], { cwd: repo })
      const switched = await call(repo, '/git/switch', 'POST', { cwd: repo, branch: 'existing' })
      expect(switched.status).toBe(200)
      const created = await call(repo, '/git/switch', 'POST', { cwd: repo, branch: 'fresh', create: true })
      expect(created.status).toBe(200)
      expect((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim()).toBe('fresh')
      const invalid = await call(repo, '/git/switch', 'POST', { cwd: repo, branch: 'bad/name' })
      expect(invalid.status).toBe(500)
      expect(String(invalid.body['error'])).toContain('invalid branch name')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('lists, pushes, and pops stashes', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'a.txt'), 'stash me\n')
      const pushed = await call(repo, '/git/stash', 'POST', { cwd: repo, op: 'push', message: 'wip' })
      expect(pushed.status).toBe(200)
      const listed = await call(repo, '/git/stash', 'POST', { cwd: repo, op: 'list' })
      const entries = (listed.body as { entries: { name: string; message: string }[] }).entries
      expect(entries).toHaveLength(1)
      expect(entries[0]?.message).toContain('wip')
      const popped = await call(repo, '/git/stash', 'POST', { cwd: repo, op: 'pop' })
      expect(popped.status).toBe(200)
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('stash me\n')
      const bad = await call(repo, '/git/stash', 'POST', { cwd: repo, op: 'nope' })
      expect(bad.status).toBe(500)
      expect(String(bad.body['error'])).toContain('stash op must be')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('pushes a stash without a message and aborts a merge', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'a.txt'), 'stash me\n')
      expect((await call(repo, '/git/stash', 'POST', { cwd: repo, op: 'push' })).status).toBe(200)
      expect((await call(repo, '/git/stash', 'POST', { cwd: repo, op: 'pop' })).status).toBe(200)
      await run('git', ['checkout', '-q', '-b', 'side'], { cwd: repo })
      await writeFile(join(repo, 'a.txt'), 'side\n')
      await run('git', ['commit', '-q', '-am', 'side'], { cwd: repo })
      await run('git', ['checkout', '-q', 'main'], { cwd: repo })
      await writeFile(join(repo, 'a.txt'), 'main\n')
      await run('git', ['commit', '-q', '-am', 'main'], { cwd: repo })
      await run('git', ['merge', 'side'], { cwd: repo }).catch(() => null)
      const aborted = await call(repo, '/git/merge-abort', 'POST', { cwd: repo })
      expect(aborted.status).toBe(200)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('resets soft, mixed, and hard, and rejects an unknown mode', async () => {
    const repo = await makeRepo()
    try {
      for (const mode of ['soft', 'mixed', 'hard'] as const) {
        await writeFile(join(repo, 'a.txt'), `${mode}\n`)
        await run('git', ['add', 'a.txt'], { cwd: repo })
        await run('git', ['commit', '-q', '-m', `${mode} commit`], { cwd: repo })
        const double = await call(repo, '/git/reset', 'POST', { cwd: repo, mode })
        expect(double.status).toBe(200)
      }
      const bad = await call(repo, '/git/reset', 'POST', { cwd: repo, mode: 'sideways' })
      expect(bad.status).toBe(500)
      expect(String(bad.body['error'])).toContain('reset mode must be')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('rules save and reset', () => {
  it('saves a global rule and resets it', async () => {
    const repo = await makeRepo()
    try {
      const saved = await call(repo, '/git/rules-save', 'POST', {
        cwd: repo,
        repo: 'demo',
        scope: 'global',
        systemPrompt: 'global rule',
      })
      expect(saved.status).toBe(200)
      const read = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect((read.body as { systemPrompt: string }).systemPrompt).toBe('global rule')
      const reset = await call(repo, '/git/rules-reset', 'POST', { cwd: repo, repo: 'demo', scope: 'global' })
      expect(reset.status).toBe(200)
      const after = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect((after.body as { source: string }).source).toBe('builtin')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects an unknown scope and an invalid repository name', async () => {
    const repo = await makeRepo()
    try {
      const scope = await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'demo', scope: 'team', systemPrompt: 'x' })
      expect(scope.status).toBe(500)
      expect(String(scope.body['error'])).toContain('scope must be global or repo')
      const resetScope = await call(repo, '/git/rules-reset', 'POST', { cwd: repo, repo: 'demo', scope: 'team' })
      expect(resetScope.status).toBe(500)
      expect(String(resetScope.body['error'])).toContain('scope must be global or repo')
      const name = await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'a/b', scope: 'repo', systemPrompt: 'x' })
      expect(name.status).toBe(500)
      expect(String(name.body['error'])).toContain('invalid repository name')
      const nul = await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'a\0b', scope: 'repo', systemPrompt: 'x' })
      expect(nul.status).toBe(500)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('generation failures', () => {
  const failingBridge = (error: unknown): CommitMessageBridge => ({
    async stream() { throw error },
    async listModels() { return [] },
  })

  it('reports an empty index before calling the model', async () => {
    const repo = await makeRepo()
    try {
      const double = await call(repo, '/git/generate', 'POST', { cwd: repo, token: 'gen-empty' }, failingBridge(new Error('unused')))
      expect(double.lines.at(-1)).toMatchObject({ t: 'err' })
      expect(String(double.lines.at(-1)?.['e'])).toContain('nothing staged')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('streams an err event for an Error and a non-Error failure', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'a.txt'), 'staged\n')
      await run('git', ['add', 'a.txt'], { cwd: repo })
      const withError = await call(repo, '/git/generate', 'POST', { cwd: repo, token: 'gen-err' }, failingBridge(new Error('model down')))
      expect(withError.lines.at(-1)).toMatchObject({ t: 'err', e: 'model down' })
      const withString = await call(repo, '/git/generate', 'POST', { cwd: repo, token: 'gen-str' }, failingBridge('offline'))
      expect(withString.lines.at(-1)).toMatchObject({ t: 'err', e: 'offline' })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('truncates a staged diff larger than the generation cap', async () => {
    const repo = await makeRepo()
    try {
      const big = 'x'.repeat(130 * 1024)
      await writeFile(join(repo, 'big.txt'), `${big}\n`)
      await run('git', ['add', 'big.txt'], { cwd: repo })
      const bridge = failingBridge(new Error('stop after render'))
      const double = await call(repo, '/git/generate', 'POST', { cwd: repo, token: 'gen-big' }, bridge)
      expect(String(double.lines.at(-1)?.['e'])).toBe('stop after render')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('answers a cancel for an unknown token', async () => {
    const repo = await makeRepo()
    try {
      const double = await call(repo, '/git/generate-cancel', 'POST', { cwd: repo, token: 'missing' })
      expect(double.status).toBe(200)
      expect(double.body['ok']).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('body validation', () => {
  it('rejects missing and malformed fields', async () => {
    const repo = await makeRepo()
    try {
      const noPaths = await call(repo, '/git/stage', 'POST', { cwd: repo })
      expect(noPaths.status).toBe(500)
      expect(String(noPaths.body['error'])).toContain('non-empty string array')
      const emptyPaths = await call(repo, '/git/stage', 'POST', { cwd: repo, paths: [] })
      expect(String(emptyPaths.body['error'])).toContain('non-empty string array')
      const badEntry = await call(repo, '/git/stage', 'POST', { cwd: repo, paths: [1] })
      expect(String(badEntry.body['error'])).toContain('non-empty string array')
      const noCwd = await call(repo, '/git/stage', 'POST', { paths: ['a'] })
      expect(String(noCwd.body['error'])).toContain('"cwd" must be a non-empty string')
      const badJson = await call(repo, '/git/stage', 'POST', '{oops')
      expect(String(badJson.body['error'])).toContain('invalid JSON body')
      const emptyBody = await call(repo, '/git/generate-cancel', 'POST', {})
      expect(String(emptyBody.body['error'])).toContain('"token" must be a non-empty string')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
describe('status parsing edges', () => {
  it('reports untracked, renamed, and ahead/behind facts', async () => {
    const { bare, clone } = await makeRemotePair()
    try {
      await writeFile(join(clone, 'loose.txt'), 'loose\n')
      await run('git', ['mv', 'a.txt', 'renamed.txt'], { cwd: clone })
      const double = await call(clone, `/git/status?cwd=${encodeURIComponent(clone)}`, 'GET')
      const body = double.body as {
        untracked: { path: string }[]
        staged: { path: string; status: string; renameFrom?: string }[]
      }
      expect(body.untracked.map(f => f.path)).toContain('loose.txt')
      const rename = body.staged.find(f => f.path === 'renamed.txt')
      expect(rename?.status.trim()).toBe('R')
      expect(rename?.renameFrom).toBe('a.txt')

      await run('git', ['commit', '-q', '-m', 'rename'], { cwd: clone })
      const ahead = await call(clone, `/git/status?cwd=${encodeURIComponent(clone)}`, 'GET')
      expect((ahead.body as { ahead: number }).ahead).toBe(1)
    } finally {
      await rm(bare, { recursive: true, force: true })
      await rm(clone, { recursive: true, force: true })
    }
  })

  it('detects rebase, cherry-pick, and revert markers', async () => {
    const repo = await makeRepo()
    try {
      const gitDir = (await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo })).stdout.trim()
      const readState = async (): Promise<unknown> => {
        const double = await call(repo, `/git/status?cwd=${encodeURIComponent(repo)}`, 'GET')
        return double.body['mergeState']
      }
      await mkdir(join(gitDir, 'rebase-merge'), { recursive: true })
      expect(await readState()).toBe('rebase')
      await rm(join(gitDir, 'rebase-merge'), { recursive: true, force: true })
      await writeFile(join(gitDir, 'CHERRY_PICK_HEAD'), 'x\n')
      expect(await readState()).toBe('cherry-pick')
      await rm(join(gitDir, 'CHERRY_PICK_HEAD'))
      await writeFile(join(gitDir, 'REVERT_HEAD'), 'x\n')
      expect(await readState()).toBe('revert')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('keeps an empty commit out of the stat map', async () => {
    const repo = await makeRepo()
    try {
      await run('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: repo })
      const double = await call(repo, `/git/log?cwd=${encodeURIComponent(repo)}&stat=1`, 'GET')
      const commits = (double.body as { commits: { subject: string; stat?: unknown }[] }).commits
      expect(commits.find(c => c.subject === 'empty')?.stat).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('rule file fallbacks', () => {
  /** Write one rule file into the DSH_HOME rules directory. */
  async function writeRuleFile(name: string, content: string): Promise<void> {
    const dir = join(homeDir, 'git-panel', 'rules')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), content, 'utf8')
  }

  it('ignores a malformed, empty, or prompt-less rule file', async () => {
    const repo = await makeRepo()
    try {
      const name = 'demo'
      const key = ruleKey(name, repo)
      for (const content of ['{not yaml', 'null', 'system_prompt: ""']) {
        await writeRuleFile(`${key}.yaml`, content)
        const double = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=${name}`, 'GET')
        expect((double.body as { source: string }).source).toBe('builtin')
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('round-trips a repo rule through the registry and falls back to global', async () => {
    const repo = await makeRepo()
    try {
      const saved = await call(repo, '/git/rules-save', 'POST', {
        cwd: repo,
        repo: 'demo',
        scope: 'repo',
        systemPrompt: 'repo rule',
        userContext: 'ctx',
      })
      expect(saved.status).toBe(200)
      const read = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect(read.body).toMatchObject({ source: 'repo', systemPrompt: 'repo rule', scope: 'repo' })
      const reset = await call(repo, '/git/rules-reset', 'POST', { cwd: repo, repo: 'demo', scope: 'repo' })
      expect(reset.status).toBe(200)
      const after = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect((after.body as { source: string }).source).toBe('builtin')

      // A global file serves a repo whose registry preference points at repo scope.
      await writeRuleFile('default.yaml', 'system_prompt: global text\nuser_context: ctx\n')
      const globalRead = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=other`, 'GET')
      expect(globalRead.body).toMatchObject({ source: 'global', systemPrompt: 'global text', scope: 'unset' })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('audit failures and discovery limits', () => {
  it('continues when the audit log cannot be written', async () => {
    const repo = await makeRepo()
    const previous = process.env['DSH_HOME']
    const blocked = join(await mkdtemp(`${tmpdir()}/dsh-git-blocked-`), 'not-a-dir')
    await writeFile(blocked, 'file\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      process.env['DSH_HOME'] = blocked
      await writeFile(join(repo, 'b.txt'), 'beta\n')
      const staged = await call(repo, '/git/stage', 'POST', { cwd: repo, paths: ['b.txt'] })
      expect(staged.status).toBe(200)
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('audit log unavailable')) })
    } finally {
      warn.mockRestore()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('stops discovery at the depth limit and skips unreadable directories', async () => {
    const root = await mkdtemp(`${tmpdir()}/dsh-git-deep-`)
    try {
      let dir = root
      for (let i = 0; i < 12; i += 1) {
        dir = join(dir, `level${i}`)
        await mkdir(dir, { recursive: true })
      }
      await run('git', ['init', '-q'], { cwd: dir })
      const unreadable = join(root, 'secret')
      await mkdir(unreadable, { recursive: true })
      await chmod(unreadable, 0o000)
      try {
        expect(findRepos(root)).toHaveLength(0)
      } finally {
        await chmod(unreadable, 0o755)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a diff larger than the bounded output', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'huge.txt'), `${'x'.repeat(4 * 1024 * 1024 + 1024)}\n`)
      await run('git', ['add', 'huge.txt'], { cwd: repo })
      await run('git', ['commit', '-q', '-m', 'huge'], { cwd: repo })
      await writeFile(join(repo, 'huge.txt'), `${'y'.repeat(4 * 1024 * 1024 + 1024)}\n`)
      const double = await call(repo, '/git/diff', 'POST', { cwd: repo, path: 'huge.txt', staged: false })
      expect(double.status).toBe(500)
      expect(String(double.body['error'])).toContain('output exceeds')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('request bodies without content', () => {
  it('treats an empty POST body as an empty object', async () => {
    const repo = await makeRepo()
    try {
      const double = await call(repo, '/git/generate-cancel', 'POST')
      expect(double.status).toBe(500)
      expect(String(double.body['error'])).toContain('"token" must be a non-empty string')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('remaining failure paths', () => {
  it('reports a missing blob ref through git stderr', async () => {
    const repo = await makeRepo()
    try {
      const double = await call(repo, `/git/blob?cwd=${encodeURIComponent(repo)}&path=gone.txt&source=head`, 'GET')
      expect(double.status).toBe(500)
      expect(String(double.body['error'])).toContain('git show')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reports a spawn failure when the resolved workspace no longer exists', async () => {
    const ghost = await mkdtemp(`${tmpdir()}/dsh-git-ghost-`)
    await rm(ghost, { recursive: true, force: true })
    const double = responseDouble()
    await handleGitRequest(
      workspaceCwdResolver([ghost], ghost),
      requestDouble(`/git/status?cwd=${encodeURIComponent(ghost)}`, 'GET') as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(String(double.body['error'])).toContain('ENOENT')
  })

  it('treats a second repo reset as a no-op registry delete', async () => {
    const repo = await makeRepo()
    try {
      await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'demo', scope: 'repo', systemPrompt: 'x' })
      expect((await call(repo, '/git/rules-reset', 'POST', { cwd: repo, repo: 'demo', scope: 'repo' })).status).toBe(200)
      expect((await call(repo, '/git/rules-reset', 'POST', { cwd: repo, repo: 'demo', scope: 'repo' })).status).toBe(200)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('falls back to the global rule when the registered repo file is gone', async () => {
    const repo = await makeRepo()
    try {
      await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'demo', scope: 'repo', systemPrompt: 'repo rule' })
      await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'other', scope: 'global', systemPrompt: 'global rule' })
      await rm(join(homeDir, 'git-panel', 'rules', `${ruleKey('demo', repo)}.yaml`))
      const double = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect(double.body).toMatchObject({ source: 'global', systemPrompt: 'global rule', scope: 'repo' })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('prefers a repo file even when the registry has no entry', async () => {
    const repo = await makeRepo()
    try {
      const dir = join(homeDir, 'git-panel', 'rules')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${ruleKey('unregistered', repo)}.yaml`), 'system_prompt: loose rule\nuser_context: ctx\n')
      const double = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=unregistered`, 'GET')
      expect(double.body).toMatchObject({ source: 'repo', systemPrompt: 'loose rule', scope: 'unset' })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('recognizes a path without an extension as non-image', () => {
    expect(imageMimeOf('Makefile')).toBeUndefined()
  })
})
