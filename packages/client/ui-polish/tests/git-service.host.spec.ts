/** Git panel host service: route dispatch, cwd resolution, path validation,
 * repository discovery, commit rules, and streaming generation against a real
 * temporary repository. DSH_HOME is pointed at a temp dir so rule/audit files
 * never touch the real home. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  BUILTIN_RULE, findRepos, handleGitRequest, normalizeSlashes, renderTemplate, ruleKey,
  workspaceCwdResolver, type CommitMessageBridge,
} from '../src/git-service.ts'

const run = promisify(execFile)

let homeDir: string
const previousHome: string | undefined = process.env['DSH_HOME']

beforeAll(async () => {
  homeDir = await mkdtemp(`${tmpdir()}/dsh-git-home-`)
  process.env['DSH_HOME'] = homeDir
})

afterAll(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(homeDir, { recursive: true, force: true })
})

/** Build a throwaway git repository with an initial commit. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/dsh-git-svc-`)
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(`${dir}/a.txt`, 'alpha\n')
  await writeFile(`${dir}/b.txt`, 'beta\n')
  await run('git', ['add', 'a.txt', 'b.txt'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  return dir
}

/** In-memory response double capturing status, writes, and the final body. */
function responseDouble() {
  let statusCode = 0
  let written = ''
  let ended = false
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      write(chunk: string) { written += chunk },
      end(payload?: string) {
        if (payload !== undefined) written += payload
        ended = true
      },
      get writableEnded() { return ended },
    },
    get status(): number { return statusCode },
    get raw(): string { return written },
    get body(): Record<string, unknown> { return JSON.parse(written) as Record<string, unknown> },
    /** NDJSON lines, for the streaming generation route. */
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
      if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      if (event === 'end') fn()
    },
  }
}

/** A generation bridge stub: streams the staged diff marker, records calls. */
function stubBridge(): CommitMessageBridge & { calls: { system: string; user: string; model?: string }[] } {
  const calls: { system: string; user: string; model?: string }[] = []
  return {
    calls,
    async stream(params) {
      calls.push({ system: params.system, user: params.user, ...(params.model !== undefined ? { model: params.model } : {}) })
      const text = 'feat: staged change\n\n- bullet one\n- bullet two'
      for (const delta of text.split(' ').map(w => `${w} `)) {
        params.onText(delta)
      }
      return text.trim()
    },
    async listModels() {
      return [{ provider: 'stub', model: 'stub-model', name: 'Stub Model' }]
    },
  }
}

describe('workspaceCwdResolver', () => {
  it('accepts workspace paths, their subtrees, and falls back for foreign ones', () => {
    const r = workspaceCwdResolver(['D:/repo-a', 'D:/repo-b'], 'D:/fallback')
    expect(r('D:/repo-a')).toBe('D:/repo-a')
    expect(r('D:/repo-b')).toBe('D:/repo-b')
    expect(r('D:/repo-a/')).toBe('D:/repo-a')
    expect(r('D:/repo-a/nested/sub')).toBe('D:/repo-a/nested/sub')
    expect(r('D:/repo-ab')).toBe('D:/fallback')
    expect(r('D:/unknown')).toBe('D:/fallback')
    expect(r('')).toBe('D:/fallback')
  })
})

describe('path helpers', () => {
  it('renderTemplate substitutes the four rule placeholders', () => {
    const out = renderTemplate('r={repo_name} b={branch} f={file_list} d={staged_diff}', {
      repo_name: 'demo',
      branch: 'main',
      file_list: 'a.txt',
      staged_diff: '+x',
    })
    expect(out).toBe('r=demo b=main f=a.txt d=+x')
  })

  it('ruleKey is stable per path and distinct per name', () => {
    expect(ruleKey('demo', 'D:/work/demo')).toBe(ruleKey('demo', 'D:\\work\\demo'))
    expect(ruleKey('demo', 'D:/work/demo')).not.toBe(ruleKey('other', 'D:/work/demo'))
  })
})

describe('repository discovery', () => {
  it('finds nested repositories, worktrees, and skips node_modules', async () => {
    const root = await mkdtemp(`${tmpdir()}/dsh-git-scan-`)
    await mkdir(join(root, 'node_modules', 'junk'), { recursive: true })
    await run('git', ['init', '-q'], { cwd: join(root, 'node_modules', 'junk') })
    const nested = join(root, 'inner', 'repo')
    await mkdir(nested, { recursive: true })
    await run('git', ['init', '-q'], { cwd: nested })
    const wtSource = join(root, 'wt-source')
    await mkdir(wtSource, { recursive: true })
    await run('git', ['init', '-q', '-b', 'main'], { cwd: wtSource })
    await run('git', ['config', 'user.email', 't@e.c'], { cwd: wtSource })
    await run('git', ['config', 'user.name', 'T'], { cwd: wtSource })
    await writeFile(join(wtSource, 'f.txt'), 'x\n')
    await run('git', ['add', 'f.txt'], { cwd: wtSource })
    await run('git', ['commit', '-q', '-m', 'c1'], { cwd: wtSource })
    const wt = join(root, 'wt')
    await run('git', ['worktree', 'add', '--detach', wt], { cwd: wtSource })
    const repos = findRepos(root)
    const paths = repos.map(r => normalizeSlashes(r.path))
    expect(paths).toContain(normalizeSlashes(nested))
    expect(paths).toContain(normalizeSlashes(wt))
    expect(paths.some(p => p.includes('node_modules'))).toBe(false)
    const worktree = repos.find(r => r.path === wt)
    expect(worktree?.isWorktree).toBe(true)
  })
})

describe('git panel host service', () => {
  it('rejects unknown routes with 404', async () => {
    const double = responseDouble()
    await handleGitRequest(
      workspaceCwdResolver([process.cwd()], process.cwd()),
      requestDouble('/git/nope?cwd=' + encodeURIComponent(process.cwd()), 'GET') as never,
      double.res as never,
    )
    expect(double.status).toBe(404)
    expect(double.body.error).toContain('unknown route')
  })

  it('rejects a non-object JSON body', async () => {
    const double = responseDouble()
    const req = {
      url: '/git/commit',
      method: 'POST',
      on(event: 'data' | 'end', fn: (chunk?: Buffer) => void) {
        if (event === 'data') fn(Buffer.from('[1,2]'))
        if (event === 'end') fn()
      },
    }
    await handleGitRequest(workspaceCwdResolver([process.cwd()], process.cwd()), req as never, double.res as never)
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('JSON body must be an object')
  })

  it('rejects commit messages that are not strings', async () => {
    const double = responseDouble()
    await handleGitRequest(
      workspaceCwdResolver([process.cwd()], process.cwd()),
      requestDouble('/git/commit', 'POST', { cwd: process.cwd(), message: 42 }) as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('non-empty string')
  })

  it('rejects diff paths that escape the repository', async () => {
    const double = responseDouble()
    await handleGitRequest(
      workspaceCwdResolver([process.cwd()], process.cwd()),
      requestDouble('/git/diff', 'POST', { cwd: process.cwd(), path: '../escape', staged: false }) as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('invalid path')
  })

  it('reports a clean working tree with branch facts', async () => {
    const repo = await makeRepo()
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/status?cwd=${encodeURIComponent(repo)}`, 'GET') as never, double.res as never)
    expect(double.status).toBe(200)
    const body = double.body as {
      isRepo: boolean
      branch: string
      ahead: number
      staged: unknown[]
      untracked: unknown[]
      mergeState: unknown
    }
    expect(body.isRepo).toBe(true)
    expect(body.branch).toBe('main')
    expect(body.ahead).toBe(0)
    expect(body.staged).toEqual([])
    expect(body.untracked).toEqual([])
    expect(body.mergeState).toBe(null)
  })

  it('groups modified, staged, and untracked files', async () => {
    const repo = await makeRepo()
    await writeFile(`${repo}/a.txt`, 'alpha changed\n')
    await writeFile(`${repo}/c.txt`, 'new\n')
    await run('git', ['add', 'c.txt'], { cwd: repo })
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/status?cwd=${encodeURIComponent(repo)}`, 'GET') as never, double.res as never)
    const body = double.body as { staged: { path: string }[]; unstaged: { path: string }[]; untracked: { path: string }[] }
    expect(body.staged.map(f => f.path)).toEqual(['c.txt'])
    expect(body.unstaged.map(f => f.path)).toEqual(['a.txt'])
    expect(body.untracked.map(f => f.path)).toEqual([])
  })

  it('reports an in-progress merge with conflicted files', async () => {
    const repo = await makeRepo()
    await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo })
    await writeFile(`${repo}/a.txt`, 'feature side\n')
    await run('git', ['commit', '-q', '-am', 'feature side'], { cwd: repo })
    await run('git', ['checkout', '-q', 'main'], { cwd: repo })
    await writeFile(`${repo}/a.txt`, 'main side\n')
    await run('git', ['commit', '-q', '-am', 'main side'], { cwd: repo })
    // The merge stops on the conflicting file with a non-zero exit status.
    await expect(run('git', ['merge', 'feature'], { cwd: repo })).rejects.toThrow()
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/status?cwd=${encodeURIComponent(repo)}`, 'GET') as never, double.res as never)
    const body = double.body as { mergeState: unknown; conflicted: { path: string }[] }
    expect(body.mergeState).toBe('merge')
    expect(body.conflicted.map(f => f.path)).toEqual(['a.txt'])
  })

  it('lists repositories under the workspace root', async () => {
    const repo = await makeRepo()
    await mkdir(join(repo, 'nested'), { recursive: true })
    await run('git', ['init', '-q'], { cwd: join(repo, 'nested') })
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/repos?cwd=${encodeURIComponent(repo)}`, 'GET') as never, double.res as never)
    const body = double.body as { repos: { path: string; isWorktree: boolean }[] }
    const paths = body.repos.map(r => normalizeSlashes(r.path))
    expect(paths).toContain(normalizeSlashes(repo))
    expect(paths).toContain(normalizeSlashes(join(repo, 'nested')))
    expect(body.repos.every(r => ! r.isWorktree)).toBe(true)
  })

  it('pages the log with hasMore and stats', async () => {
    const repo = await makeRepo()
    for (let i = 1; i <= 5; i += 1) {
      await writeFile(`${repo}/f${i}.txt`, `${i}\n`)
      await run('git', ['add', `f${i}.txt`], { cwd: repo })
      await run('git', ['commit', '-q', '-m', `c${i}`], { cwd: repo })
    }
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/log?cwd=${encodeURIComponent(repo)}&limit=3&stat=1`, 'GET') as never, double.res as never)
    const body = double.body as { commits: { subject: string; stat?: { files: number } }[]; hasMore: boolean }
    expect(body.commits.length).toBe(3)
    expect(body.hasMore).toBe(true)
    expect(body.commits[0]?.subject).toBe('c5')
    expect(body.commits[0]?.stat?.files).toBe(1)
  })

  it('commits the staged index only, with a multi-line message via stdin', async () => {
    const repo = await makeRepo()
    await writeFile(`${repo}/a.txt`, 'staged change\n')
    await run('git', ['add', 'a.txt'], { cwd: repo })
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/commit', 'POST', {
      cwd: repo,
      message: 'feat: multi line\n\n- one\n- two',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    const subject = (await run('git', ['log', '-1', '--format=%s'], { cwd: repo })).stdout.trim()
    expect(subject).toBe('feat: multi line')
    const message = (await run('git', ['log', '-1', '--format=%B'], { cwd: repo })).stdout.trim()
    expect(message).toContain('- two')
  })

  it('refuses to commit while conflicts are unresolved', async () => {
    const repo = await makeRepo()
    // Create a conflict: a side branch changes a.txt, then merge.
    await run('git', ['checkout', '-q', '-b', 'side'], { cwd: repo })
    await writeFile(`${repo}/a.txt`, 'side\n')
    await run('git', ['commit', '-q', '-am', 'side change'], { cwd: repo })
    await run('git', ['checkout', '-q', 'main'], { cwd: repo })
    await writeFile(`${repo}/a.txt`, 'main\n')
    await run('git', ['commit', '-q', '-am', 'main change'], { cwd: repo })
    const merge = await run('git', ['merge', 'side'], { cwd: repo }).catch(() => null)
    if (merge === null) {
      // Conflicted as expected.
    }
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/commit', 'POST', { cwd: repo, message: 'should fail' }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.body.error)).toContain('unmerged')
  })

  it('undo-commit only when HEAD is the given hash', async () => {
    const repo = await makeRepo()
    await run('git', ['commit', '-q', '--allow-empty', '-m', 'second'], { cwd: repo })
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    const resolve = workspaceCwdResolver([repo], repo)
    const stale = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/undo-commit', 'POST', { cwd: repo, hash: '0'.repeat(40) }) as never, stale.res as never)
    expect(stale.status).toBe(500)
    expect(String(stale.body.error)).toContain('HEAD moved')
    const ok = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/undo-commit', 'POST', { cwd: repo, hash: head }) as never, ok.res as never)
    expect(ok.status).toBe(200)
    const subject = (await run('git', ['log', '-1', '--format=%s'], { cwd: repo })).stdout.trim()
    expect(subject).toBe('initial')
  })

  it('pull without upstream fetches only and reports it', async () => {
    const repo = await makeRepo()
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/pull', 'POST', { cwd: repo }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.body.fetchedOnly).toBe(true)
  })

  it('merge-complete concludes a resolved merge', async () => {
    const repo = await makeRepo()
    await run('git', ['checkout', '-q', '-b', 'side'], { cwd: repo })
    await writeFile(`${repo}/b.txt`, 'side\n')
    await run('git', ['commit', '-q', '-am', 'side'], { cwd: repo })
    await run('git', ['checkout', '-q', 'main'], { cwd: repo })
    await run('git', ['merge', '-s', 'ours', '-m', 'merge side', 'side'], { cwd: repo })
    // Now create a real merge with a trivial conflict resolved to ours.
    await run('git', ['checkout', '-q', '-b', 'side2'], { cwd: repo })
    await writeFile(`${repo}/b.txt`, 'side2\n')
    await run('git', ['commit', '-q', '-am', 'side2'], { cwd: repo })
    await run('git', ['checkout', '-q', 'main'], { cwd: repo })
    await writeFile(`${repo}/b.txt`, 'main2\n')
    await run('git', ['commit', '-q', '-am', 'main2'], { cwd: repo })
    await run('git', ['merge', 'side2'], { cwd: repo }).catch(() => {
      // Conflict expected.
    })
    await run('git', ['checkout', '--ours', '--', 'b.txt'], { cwd: repo })
    await run('git', ['add', 'b.txt'], { cwd: repo })
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/merge-complete', 'POST', { cwd: repo }) as never, double.res as never)
    expect(double.status).toBe(200)
    const status = (await run('git', ['status', '--porcelain=v2', '-b'], { cwd: repo })).stdout
    expect(status.includes('# branch.merge')).toBe(false)
  })

  it('serves file versions as data URLs (head and worktree)', async () => {
    const repo = await makeRepo()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') // 16-byte png header
    await writeFile(`${repo}/img.png`, png)
    await run('git', ['add', 'img.png'], { cwd: repo })
    await run('git', ['commit', '-q', '-m', 'add img'], { cwd: repo })
    const modified = Buffer.concat([png, Buffer.from([1, 2, 3])])
    await writeFile(`${repo}/img.png`, modified)
    const resolve = workspaceCwdResolver([repo], repo)
    const headDouble = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/blob?cwd=${encodeURIComponent(repo)}&path=img.png&source=head`, 'GET') as never, headDouble.res as never)
    expect(headDouble.status).toBe(200)
    expect(String(headDouble.body.dataUrl)).toBe('data:image/png;base64,' + png.toString('base64'))
    const worktreeDouble = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/blob?cwd=${encodeURIComponent(repo)}&path=img.png&source=worktree`, 'GET') as never, worktreeDouble.res as never)
    expect(worktreeDouble.status).toBe(200)
    expect(String(worktreeDouble.body.dataUrl)).toBe('data:image/png;base64,' + modified.toString('base64'))
  })

  it('lists models from the bridge', async () => {
    const bridge = stubBridge()
    const double = responseDouble()
    await handleGitRequest(
      workspaceCwdResolver([process.cwd()], process.cwd()),
      requestDouble('/git/models', 'GET') as never,
      double.res as never,
      bridge,
    )
    expect(double.status).toBe(200)
    expect(double.body.models).toEqual([{ provider: 'stub', model: 'stub-model', name: 'Stub Model' }])
  })

  it('serves the builtin rule before any file exists', async () => {
    const repo = await makeRepo()
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET') as never, double.res as never)
    expect(double.status).toBe(200)
    const body = double.body as { source: string; systemPrompt: string }
    expect(body.source).toBe('builtin')
    expect(body.systemPrompt).toBe(BUILTIN_RULE.systemPrompt)
  })

  it('round-trips a repo-specific rule and resets it', async () => {
    const repo = await makeRepo()
    const resolve = workspaceCwdResolver([repo], repo)
    const save = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/rules-save', 'POST', {
      cwd: repo,
      repo: 'demo',
      scope: 'repo',
      systemPrompt: 'my custom rule',
      userContext: 'files: {file_list}\ndiff: {staged_diff}',
    }) as never, save.res as never)
    expect(save.status).toBe(200)
    const read = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET') as never, read.res as never)
    const body = read.body as { source: string; systemPrompt: string }
    expect(body.source).toBe('repo')
    expect(body.systemPrompt).toBe('my custom rule')
    const reset = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/rules-reset', 'POST', { cwd: repo, repo: 'demo', scope: 'repo' }) as never, reset.res as never)
    expect(reset.status).toBe(200)
    const after = responseDouble()
    await handleGitRequest(resolve, requestDouble(`/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET') as never, after.res as never)
    expect((after.body as { source: string }).source).toBe('builtin')
  })

  it('streams the generation as NDJSON with rendered rule placeholders', async () => {
    const repo = await makeRepo()
    await writeFile(`${repo}/a.txt`, 'staged change\n')
    await run('git', ['add', 'a.txt'], { cwd: repo })
    const bridge = stubBridge()
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/generate', 'POST', { cwd: repo, token: 'gen-1', model: 'stub-model' }) as never, double.res as never, bridge)
    expect(double.status).toBe(200)
    const lines = double.lines
    expect(lines.filter(l => l['t'] === 'text').length).toBeGreaterThan(0)
    const done = lines.find(l => l['t'] === 'done')
    expect(done !== undefined).toBe(true)
    expect(String(done?.['m'])).toContain('feat: staged change')
    // The rendered user context carries the repo facts and the staged diff.
    expect(bridge.calls[0]?.user).toContain('Repository: ' + (repo.split(/[\\/]/).pop() ?? ''))
    expect(bridge.calls[0]?.user).toContain('staged change')
    expect(bridge.calls[0]?.model).toBe('stub-model')
  })

  it('answers stop when the generation is cancelled', async () => {
    const repo = await makeRepo()
    await writeFile(`${repo}/a.txt`, 'staged change\n')
    await run('git', ['add', 'a.txt'], { cwd: repo })
    const cancelled = { value: false }
    const bridge: CommitMessageBridge = {
      async stream(params) {
        params.onText('partial')
        await new Promise<void>((resolveWait) => {
          const check = setInterval(() => {
            if (params.signal.aborted || cancelled.value) {
              clearInterval(check)
              resolveWait()
            }
          }, 5)
        })
        if (params.signal.aborted) return 'partial'
        return 'partial full'
      },
      async listModels() { return [] },
    }
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    const pending = handleGitRequest(resolve, requestDouble('/git/generate', 'POST', { cwd: repo, token: 'gen-2' }) as never, double.res as never, bridge)
    // Wait for the first streamed delta instead of a fixed delay: the request
    // reads the staged diff before it reaches the bridge, and cancelling earlier
    // would abort before any text exists.
    await new Promise<void>((resolveWait) => {
      const check = setInterval(() => {
        if (double.raw.includes('"t":"text"')) {
          clearInterval(check)
          resolveWait()
        }
      }, 5)
    })
    const cancel = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/generate-cancel', 'POST', { token: 'gen-2' }) as never, cancel.res as never, bridge)
    expect(cancel.status).toBe(200)
    await pending
    const lines = double.lines
    expect(lines.some(l => l['t'] === 'text')).toBe(true)
    expect(lines.some(l => l['t'] === 'stop')).toBe(true)
    expect(lines.some(l => l['t'] === 'err')).toBe(false)
  })
})
