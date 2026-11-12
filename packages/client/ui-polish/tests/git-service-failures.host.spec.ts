/** Git panel service internals: process failures (timeout, bounded output,
 * stdin piping, spawn errors), blob limits, parser framing edges, and route
 * branches that need a hand-built response. Real temporary repositories drive
 * the process paths; a fake `git` on PATH covers the fixed blob timeout and
 * the single-argument error messages. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import {
  git, gitLenient, gitRunTolerant, gitShowBuffer, handleGitRequest, isGitWorktree,
  parseStatBlocks, parseStatusV2, resolveRepoPath, ruleKey, workspaceCwdResolver,
  type CommitMessageBridge,
} from '../src/git-service.ts'

const run = promisify(execFile)

/** The POSIX shell stand-ins cannot run on Windows, whose process table also
 * cannot report a signal exit; those lanes keep their real-Git paths only. */
const posixOnly = process.platform === 'win32'

let homeDir: string
let fakeGitDir: string
const previousHome: string | undefined = process.env['DSH_HOME']

beforeAll(async () => {
  homeDir = await mkdtemp(`${tmpdir()}/dsh-git-failures-home-`)
  process.env['DSH_HOME'] = homeDir
  fakeGitDir = await mkdtemp(`${tmpdir()}/dsh-git-fake-bin-`)
  await writeFile(join(fakeGitDir, 'git'), [
    '#!/bin/sh',
    'case "$1" in',
    '  show) exec sleep 30 ;;',
    '  signal) kill -9 $$ ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 })
})

afterAll(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(homeDir, { recursive: true, force: true })
  await rm(fakeGitDir, { recursive: true, force: true })
})

/** Build a throwaway git repository with an initial commit. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/dsh-git-failure-`)
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'alpha\n')
  await writeFile(join(dir, 'b.txt'), 'beta\n')
  await run('git', ['add', 'a.txt', 'b.txt'], { cwd: dir })
  await run('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
  return dir
}

/** Run `fn` with the fake git directory first on PATH. */
async function withFakeGit<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['PATH']
  process.env['PATH'] = `${fakeGitDir}${delimiter}${previous ?? ''}`
  try {
    return await fn()
  } finally {
    process.env['PATH'] = previous
  }
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
      get headersSent() { return statusCode !== 0 },
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
      if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
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

/** Poll until `fn` returns true; rejects after the deadline. */
async function waitFor(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not reached before the deadline')
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 5) })
  }
}

describe('gitRunTolerant process failures', () => {
  it('kills a command that waits on stdin after the timeout', async () => {
    const repo = await makeRepo()
    const started = Date.now()
    await expect(gitRunTolerant({ cwd: repo, args: ['hash-object', '--stdin'], timeoutMs: 150 }))
      .rejects.toThrow(/git hash-object --stdin timed out after 150 ms/)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('names the timeout for a command without arguments', async () => {
    const repo = await makeRepo()
    const started = Date.now()
    await expect(gitRunTolerant({ cwd: repo, args: ['am'], timeoutMs: 150 }))
      .rejects.toThrow(/git am\s+timed out after 150 ms/)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('rejects bounded stderr with the argument pair in the message', async () => {
    const repo = await makeRepo()
    await expect(gitRunTolerant({ cwd: repo, args: ['rev-parse', '--verify', 'missing-ref'], maxBuffer: 1 }))
      .rejects.toThrow(/git rev-parse --verify output exceeds 1 bytes/)
  })

  it('rejects bounded stderr for a command without a second argument', async () => {
    const repo = await makeRepo()
    await expect(gitRunTolerant({ cwd: repo, args: ['pull'], maxBuffer: 1 }))
      .rejects.toThrow(/git pull\s+output exceeds 1 bytes/)
  })

  it('rejects bounded stdout for a single-argument command', async () => {
    const repo = await makeRepo()
    await expect(gitRunTolerant({ cwd: repo, args: ['ls-files'], maxBuffer: 0 }))
      .rejects.toThrow(/git ls-files\s+output exceeds 0 bytes/)
  })

  it('rejects bounded stdout and names both arguments', async () => {
    const repo = await makeRepo()
    await expect(gitRunTolerant({ cwd: repo, args: ['rev-parse', 'HEAD'], maxBuffer: 0 }))
      .rejects.toThrow(/git rev-parse HEAD output exceeds 0 bytes/)
  })

  it.skipIf(posixOnly)('resolves with the fallback exit code when a command dies from a signal', async () => {
    const repo = await makeRepo()
    const result = await withFakeGit(() => gitRunTolerant({ cwd: repo, args: ['signal'] }))
    expect(result.code).toBe(-1)
  })

  it('ignores an EPIPE while writing stdin to a command that never reads it', async () => {
    const repo = await makeRepo()
    const result = await gitRunTolerant({
      cwd: repo,
      args: ['rev-parse', 'HEAD'],
      stdin: 'x'.repeat(4 * 1024 * 1024),
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toHaveLength(40)
    // The rejected stdin write arrives after the child closed; the listener
    // owns it so it never becomes an unhandled stream error.
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 100) })
  })

  it('runs git with an explicit timeout', async () => {
    const repo = await makeRepo()
    expect((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000)).trim()).toBe('main')
    expect(await gitLenient(repo, ['rev-parse', '--verify', 'missing-ref'], 10_000)).toBe('')
  })
})

describe('gitShowBuffer failures', () => {
  it('rejects a spawn failure for a missing directory', async () => {
    const missing = await mkdtemp(`${tmpdir()}/dsh-git-gone-`)
    await rm(missing, { recursive: true, force: true })
    await expect(gitShowBuffer(missing, 'HEAD:a.txt')).rejects.toThrow(/ENOENT/)
  })

  it('rejects a blob above the preview cap and ignores the remaining chunks', async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo, 'big.bin'), Buffer.alloc(16 * 1024 * 1024, 1))
      await run('git', ['add', 'big.bin'], { cwd: repo })
      await run('git', ['commit', '-q', '-m', 'big blob'], { cwd: repo })
      await expect(gitShowBuffer(repo, 'HEAD:big.bin')).rejects.toThrow(/git show HEAD:big.bin exceeds 8388608 bytes/)
      // Chunks already queued by the killed child still arrive after the cap.
      await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 200) })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it.skipIf(posixOnly)('times out a hanging git show after 30 seconds', async () => {
    const repo = await makeRepo()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = withFakeGit(() => gitShowBuffer(repo, 'HEAD:a.txt'))
      const rejected = expect(pending).rejects.toThrow(/git show HEAD:a.txt timed out/)
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('path and worktree probes', () => {
  it('reports a missing directory as not a worktree', async () => {
    const missing = await mkdtemp(`${tmpdir()}/dsh-git-nogit-`)
    await rm(missing, { recursive: true, force: true })
    expect(isGitWorktree(missing)).toBe(false)
  })

  it('rejects a path that resolves outside a repository rooted at the separator', () => {
    // A root whose resolved spelling ends with the separator only differs from
    // its children by the separator the check appends; no separator-free
    // relative path can clear the prefix there.
    expect(() => resolveRepoPath('/', 'etc')).toThrow('git panel: path escapes the workspace')
  })
})

describe('status parsing edges', () => {
  it('parses the legacy layout, empty branch facts, and rename sources', () => {
    const raw = [
      '# branch.head',
      '# branch.upstream',
      '# branch.ab',
      '# branch.ab +2',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +4 -5',
      '? loose.txt',
      '?',
      '1 ZZ N... 100644 100644 100644 aaa bbb ignored.txt',
      ' M N... 100644 100644 100644 aaa bbb legacy-unstaged.txt',
      ' M N... truncated',
      '2 R. N... 100644 100644 100644 aaa bbb R100 plain-rename.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 known-rename.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 \ta-before.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc modern-conflict.txt',
      'UU N... 100644 100644 100644 100644 aaa bbb ccc legacy-conflict.txt',
    ].join('\n')
    const parsed = parseStatusV2(raw, new Map([['known-rename.txt', 'was.txt']]))

    expect(parsed.branch).toBe('main')
    expect(parsed.upstream).toBe('origin/main')
    expect(parsed.ahead).toBe(4)
    expect(parsed.behind).toBe(5)
    expect(parsed.untracked).toEqual([{ status: '??', path: 'loose.txt' }, { status: '??', path: '' }])
    expect(parsed.unstaged).toEqual([
      { status: ' M', path: 'legacy-unstaged.txt' },
      { status: ' M', path: '' },
    ])
    expect(parsed.staged).toEqual([
      { status: 'R ', path: 'plain-rename.txt' },
      { status: 'R ', path: 'known-rename.txt', renameFrom: 'was.txt' },
      { status: 'R ', path: '', renameFrom: 'a-before.txt' },
    ])
    expect(parsed.conflicted).toEqual([
      { status: 'UU', path: 'modern-conflict.txt' },
      // A legacy unmerged row carries its path one field before the index the
      // current layout uses, so this row contributes no path.
      { status: 'UU', path: '' },
    ])
  })
})

describe('stat blocks', () => {
  it('reports deletion-only and empty commits', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'lines.txt'), '1\n2\n3\n4\n')
    await run('git', ['add', 'lines.txt'], { cwd: repo })
    await run('git', ['commit', '-q', '-m', 'add lines'], { cwd: repo })
    await run('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: repo })
    await writeFile(join(repo, 'lines.txt'), '1\n')
    await run('git', ['commit', '-q', '-am', 'delete lines'], { cwd: repo })

    const deletions = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    const empty = (await run('git', ['rev-parse', 'HEAD~1'], { cwd: repo })).stdout.trim()
    const stats = await parseStatBlocks(repo, 10, 0)
    expect(stats.get(deletions)).toEqual({ files: 1, insertions: 0, deletions: 3 })
    expect(stats.has(empty)).toBe(false)
  })
})

describe('log record framing', () => {
  it('skips an empty hash and falls back for a record without fields', async () => {
    const repo = await makeRepo()
    const messages = join(repo, 'messages')
    await mkdir(messages, { recursive: true })
    // The record separator inside the message splits the stream: a subject
    // that ends with it leaves a hash-less record, and a trailing body segment
    // leaves a record without any of the metadata fields.
    await writeFile(join(messages, 'old'), 'old subject\n\nbody\x1ed\n')
    await run('git', ['commit', '-q', '--allow-empty', '-F', join(messages, 'old')], { cwd: repo })
    await writeFile(join(messages, 'new'), 'new\x1e\n')
    await run('git', ['commit', '-q', '--allow-empty', '-F', join(messages, 'new')], { cwd: repo })

    const double = await call(repo, `/git/log?cwd=${encodeURIComponent(repo)}`, 'GET')
    const commits = (double.body as {
      commits: { hash: string; parents: string[]; author: string; email: string; date: string; subject: string; body: string }[]
    }).commits
    expect(commits).toHaveLength(4)
    const stray = commits.find(c => c.author === '')
    expect(stray).toMatchObject({ parents: [], email: '', date: '', subject: '', body: '' })
    expect(commits.some(c => c.hash === '')).toBe(false)
  })
})

describe('route branches', () => {
  it('requires a blob source', async () => {
    const repo = await makeRepo()
    const double = await call(repo, `/git/blob?cwd=${encodeURIComponent(repo)}&path=a.txt`, 'GET')
    expect(double.status).toBe(500)
    expect(String(double.body['error'])).toContain('source must be head, index, or worktree')
  })

  it('lists branches without an upstream', async () => {
    const repo = await makeRepo()
    const double = await call(repo, `/git/branches?cwd=${encodeURIComponent(repo)}`, 'GET')
    expect(double.status).toBe(200)
    expect(double.body['current']).toBe('main')
    expect(double.body['upstream']).toBeUndefined()
  })

  it('defaults the log page size and skips the stat pass', async () => {
    const repo = await makeRepo()
    const double = await call(repo, `/git/log?cwd=${encodeURIComponent(repo)}&limit=0`, 'GET')
    const body = double.body as { commits: { subject: string; stat?: unknown }[] }
    expect(body.commits.map(c => c.subject)).toEqual(['initial'])
    expect(body.commits[0]?.stat).toBeUndefined()
  })

  it('discards worktree changes without the staged step', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'a.txt'), 'changed\n')
    const double = await call(repo, '/git/discard', 'POST', { cwd: repo, paths: ['a.txt'] })
    expect(double.status).toBe(200)
    expect((await run('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('')
  })

  it('reports a push failure with the upstream present', async () => {
    const bare = await mkdtemp(`${tmpdir()}/dsh-git-gone-bare-`)
    await run('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare })
    const repo = await makeRepo()
    await run('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo })
    await rm(bare, { recursive: true, force: true })
    const double = await call(repo, '/git/push', 'POST', { cwd: repo })
    expect(double.status).toBe(500)
    expect(double.body['noUpstream']).toBeUndefined()
  })

  it('reports a non-Error bridge failure as text', async () => {
    const bridge: CommitMessageBridge = {
      async stream() { return '' },
      async listModels() { throw 'bridge offline' },
    }
    const double = await call(process.cwd(), '/git/models', 'GET', undefined, bridge)
    expect(double.status).toBe(500)
    expect(double.body['error']).toBe('bridge offline')
  })

  it('answers the root route when the request carries no URL or method', async () => {
    const double = responseDouble()
    const req = { on() {} }
    await handleGitRequest(workspaceCwdResolver([process.cwd()], process.cwd()), req as never, double.res as never)
    expect(double.status).toBe(404)
    expect(String(double.body['error'])).toContain('unknown route GET /')
  })
})

describe('audit degradation', () => {
  it('warns once and stays quiet on later audit failures', async () => {
    const repo = await makeRepo()
    const blocked = await mkdtemp(`${tmpdir()}/dsh-git-blocked-`)
    const homeFile = join(blocked, 'not-a-directory')
    await writeFile(homeFile, 'x\n')
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = homeFile
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await call(repo, '/git/stage', 'POST', { cwd: repo, paths: ['a.txt'] })
      await call(repo, '/git/stage', 'POST', { cwd: repo, paths: ['b.txt'] })
      await waitFor(() => warn.mock.calls.length > 0)
      await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 50) })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      await rm(blocked, { recursive: true, force: true })
    }
  })
})

describe('rule file fallbacks', () => {
  it('accepts a rule file without a system prompt and falls back to the builtin', async () => {
    const repo = await makeRepo()
    const home = await mkdtemp(`${tmpdir()}/dsh-git-ruleless-home-`)
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      const dir = join(home, 'git-panel', 'rules')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${ruleKey('demo', repo)}.yaml`), 'user_context: files {file_list}\n')
      const double = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect(double.body).toMatchObject({ source: 'builtin', scope: 'unset' })
    } finally {
      process.env['DSH_HOME'] = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  it('falls back to the builtin rule when a registered repo file and the global file are gone', async () => {
    const repo = await makeRepo()
    const home = await mkdtemp(`${tmpdir()}/dsh-git-rulefallback-home-`)
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      await call(repo, '/git/rules-save', 'POST', { cwd: repo, repo: 'demo', scope: 'repo', systemPrompt: 'repo rule' })
      await rm(join(home, 'git-panel', 'rules', `${ruleKey('demo', repo)}.yaml`))
      const double = await call(repo, `/git/rules?cwd=${encodeURIComponent(repo)}&repo=demo`, 'GET')
      expect(double.body).toMatchObject({ source: 'builtin', scope: 'repo' })
    } finally {
      process.env['DSH_HOME'] = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('response cleanup failures', () => {
  /** A response double whose header write reports the socket closing. */
  function headerFailureDouble(alreadyEnded: boolean) {
    let headersSent = false
    let ends = 0
    return {
      res: {
        writeHead() { headersSent = true; throw new Error('socket closed') },
        write() {},
        end() { ends += 1 },
        get headersSent() { return headersSent },
        get writableEnded() { return alreadyEnded },
      },
      get ends(): number { return ends },
    }
  }

  it('ends the response after a failure that follows the headers', async () => {
    const repo = await makeRepo()
    const failure = headerFailureDouble(false)
    await handleGitRequest(
      workspaceCwdResolver([repo], repo),
      requestDouble(`/git/status?cwd=${encodeURIComponent(repo)}`, 'GET') as never,
      failure.res as never,
    )
    expect(failure.ends).toBe(1)
  })

  it('leaves an already ended response alone after a failure', async () => {
    const repo = await makeRepo()
    const failure = headerFailureDouble(true)
    await handleGitRequest(
      workspaceCwdResolver([repo], repo),
      requestDouble(`/git/status?cwd=${encodeURIComponent(repo)}`, 'GET') as never,
      failure.res as never,
    )
    expect(failure.ends).toBe(0)
  })
})

describe('generation stream edge cases', () => {
  /** A bridge that records calls and streams a fixed message. */
  function recordingBridge() {
    const calls: unknown[] = []
    return {
      calls,
      async stream(params: Parameters<CommitMessageBridge['stream']>[0]) {
        calls.push(params)
        params.onText('feat: x')
        return 'feat: x'
      },
      async listModels() { return [] },
    } satisfies CommitMessageBridge & { calls: unknown[] }
  }

  it('stops a generation cancelled before the staged diff is read', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'a.txt'), 'staged\n')
    await run('git', ['add', 'a.txt'], { cwd: repo })
    const bridge = recordingBridge()
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    const pending = handleGitRequest(
      resolve,
      requestDouble('/git/generate', 'POST', { cwd: repo, token: 'gen-early' }) as never,
      double.res as never,
      bridge,
    )
    await handleGitRequest(
      resolve,
      requestDouble('/git/generate-cancel', 'POST', { token: 'gen-early' }) as never,
      responseDouble().res as never,
      bridge,
    )
    await pending
    expect(double.lines).toEqual([{ t: 'stop' }])
    expect(bridge.calls).toHaveLength(0)
  })

  it('answers stop when the bridge throws after the cancel', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'a.txt'), 'staged\n')
    await run('git', ['add', 'a.txt'], { cwd: repo })
    let started = false
    const bridge: CommitMessageBridge = {
      async stream(params) {
        started = true
        await new Promise<void>((resolveWait) => {
          params.signal.addEventListener('abort', () => { resolveWait() }, { once: true })
        })
        throw new Error('generation aborted')
      },
      async listModels() { return [] },
    }
    const resolve = workspaceCwdResolver([repo], repo)
    const double = responseDouble()
    const pending = handleGitRequest(
      resolve,
      requestDouble('/git/generate', 'POST', { cwd: repo, token: 'gen-throw' }) as never,
      double.res as never,
      bridge,
    )
    await waitFor(() => started)
    await handleGitRequest(
      resolve,
      requestDouble('/git/generate-cancel', 'POST', { token: 'gen-throw' }) as never,
      responseDouble().res as never,
      bridge,
    )
    await pending
    expect(double.lines).toEqual([{ t: 'stop' }])
  })

  it('writes nothing to a response that already ended', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'a.txt'), 'staged\n')
    await run('git', ['add', 'a.txt'], { cwd: repo })
    let headers = 0
    let writes = 0
    let ends = 0
    const closed = {
      writeHead() { headers += 1 },
      write() { writes += 1 },
      end() { ends += 1 },
      writableEnded: true,
      headersSent: true,
    }
    await handleGitRequest(
      workspaceCwdResolver([repo], repo),
      requestDouble('/git/generate', 'POST', { cwd: repo, token: 'gen-closed' }) as never,
      closed as never,
      recordingBridge(),
    )
    expect(headers).toBe(1)
    expect(writes).toBe(0)
    expect(ends).toBe(0)
  })
})
