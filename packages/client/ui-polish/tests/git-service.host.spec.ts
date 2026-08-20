/** Git panel host service: route dispatch, cwd resolution, and path validation. */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { handleGitRequest, workspaceCwdResolver } from '../src/git-service.ts'

/** Resolver used by every test: only the host cwd is a known workspace. */
const resolve = workspaceCwdResolver([process.cwd()], process.cwd())

/** In-memory response double capturing status and JSON body (getters are live). */
function responseDouble() {
  let statusCode = 0
  let body = ''
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      end(payload: string) { body = payload },
    },
    get status(): number { return statusCode },
    get body(): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown> },
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

describe('workspaceCwdResolver', () => {
  it('accepts known workspace paths and falls back for unknown ones', () => {
    const r = workspaceCwdResolver(['D:/repo-a', 'D:/repo-b'], 'D:/fallback')
    expect(r('D:/repo-a')).toBe('D:/repo-a')
    expect(r('D:/repo-b')).toBe('D:/repo-b')
    expect(r('D:/repo-a/')).toBe('D:/repo-a')
    expect(r('D:/unknown')).toBe('D:/fallback')
    expect(r('')).toBe('D:/fallback')
  })
})

describe('git panel host service', () => {
  it('rejects unknown routes with 404', async () => {
    const double = responseDouble()
    await handleGitRequest(resolve, requestDouble('/git/nope?cwd=' + encodeURIComponent(process.cwd()), 'GET') as never, double.res as never)
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
    await handleGitRequest(resolve, req as never, double.res as never)
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('JSON body must be an object')
  })

  it('rejects commit messages that are not strings', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/commit', 'POST', { cwd: process.cwd(), message: 42 }) as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('non-empty string')
  })

  it('rejects diff paths that escape the repository', async () => {
    for (const bad of ['../outside', '/etc/passwd', 'sub\\..\\escape']) {
      const double = responseDouble()
      await handleGitRequest(
        resolve,
        requestDouble('/git/diff', 'POST', { cwd: process.cwd(), path: bad }) as never,
        double.res as never,
      )
      expect(double.status).toBe(500)
      expect(double.body.error).toContain('invalid path')
    }
  })

  it('serves /git/status as JSON for a known workspace', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/status?cwd=' + encodeURIComponent(process.cwd()), 'GET') as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    expect(double.body).toHaveProperty('branch')
    expect(double.body).toHaveProperty('entries')
    expect(double.body).toHaveProperty('isRepo')
  })

  it('requires cwd on mutating routes', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/push', 'POST', {}) as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('non-empty string')
  })

  it('reads a workspace file through /git/read', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/read', 'POST', { cwd: process.cwd(), path: 'package.json' }) as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    const body = double.body as { content: string }
    expect(body.content).toContain('"name"')
  })

  it('reads an image file as a read-only data URL preview', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-git-image-'))
    try {
      // Minimal 1x1 PNG bytes.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      )
      await writeFile(join(workspace, 'pic.png'), png)
      const imageResolve = workspaceCwdResolver([workspace], 'D:/fallback')
      const double = responseDouble()
      await handleGitRequest(
        imageResolve,
        requestDouble('/git/read', 'POST', { cwd: workspace, path: 'pic.png' }) as never,
        double.res as never,
      )
      expect(double.status).toBe(200)
      const body = double.body as { isImage: boolean; mime: string; dataUrl: string }
      expect(body.isImage).toBe(true)
      expect(body.mime).toBe('image/png')
      expect(body.dataUrl).toContain('data:image/png;base64,')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects read paths that escape the repository', async () => {
    for (const bad of ['../outside', '/etc/passwd', 'sub\\..\\escape']) {
      const double = responseDouble()
      await handleGitRequest(
        resolve,
        requestDouble('/git/read', 'POST', { cwd: process.cwd(), path: bad }) as never,
        double.res as never,
      )
      expect(double.status).toBe(500)
      expect(double.body.error).toContain('invalid path')
    }
  })

  it('writes a workspace file through /git/write', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-write-'))
    const target = path.join(dir, 'note.txt')
    await fs.writeFile(target, 'before', 'utf8')
    const cwd = dir
    const resolver = workspaceCwdResolver([dir], process.cwd())
    const double = responseDouble()
    await handleGitRequest(
      resolver,
      requestDouble('/git/write', 'POST', { cwd, path: 'note.txt', content: 'after' }) as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    expect(await fs.readFile(target, 'utf8')).toBe('after')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('rejects non-string content on /git/write', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/write', 'POST', { cwd: process.cwd(), path: 'x.txt', content: 42 }) as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('content')
  })

  it('lists the workspace root with files and directories', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/list', 'POST', { cwd: process.cwd() }) as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    const body = double.body as { items: { name: string; type: 'dir' | 'file'; path: string }[] }
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.some(item => item.name === 'package.json' && item.type === 'file')).toBe(true)
    expect(body.items.some(item => item.type === 'dir')).toBe(true)
    // Directories sort before files.
    const firstDir = body.items.findIndex(item => item.type === 'dir')
    const firstFile = body.items.findIndex(item => item.type === 'file')
    expect(firstDir).not.toBe(-1)
    expect(firstFile).toBeGreaterThan(firstDir)
  })

  it('lists a workspace subdirectory', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/list', 'POST', { cwd: process.cwd(), dir: 'packages' }) as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    const body = double.body as { items: { path: string }[] }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every(item => item.path.startsWith('packages/'))).toBe(true)
  })

  it('rejects listing outside the repository', async () => {
    const double = responseDouble()
    await handleGitRequest(
      resolve,
      requestDouble('/git/list', 'POST', { cwd: process.cwd(), dir: '../outside' }) as never,
      double.res as never,
    )
    expect(double.status).toBe(500)
    expect(double.body.error).toContain('invalid path')
  })
})
