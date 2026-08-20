/** Excalidraw host service: route dispatch, cwd resolution, scene persistence. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleExcalidrawRequest } from '../src/excalidraw-service.ts'
import { SCENE_RELATIVE } from '@deepseek-ai/dsh-tool-excalidraw'
import { workspaceCwdResolver } from '../src/git-service.ts'

/** Resolver used by every test: only the temp workspace is known. */
function resolverFor(workspace: string) {
  return workspaceCwdResolver([workspace], 'D:/fallback')
}

/** In-memory response double capturing status and raw body text. */
function responseDouble() {
  let statusCode = 0
  let body = ''
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      end(payload: string) { body = payload },
    },
    get status(): number { return statusCode },
    get body(): string { return body },
    get json(): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown> },
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

describe('excalidraw host service', () => {
  it('rejects the removed /excalidraw/ route with 404', async () => {
    const double = responseDouble()
    await handleExcalidrawRequest(resolverFor('D:/ws'), requestDouble('/excalidraw/', 'GET') as never, double.res as never)
    expect(double.status).toBe(404)
    expect(double.json.error).toContain('unknown route')
  })

  it('rejects unknown routes with 404', async () => {
    const double = responseDouble()
    await handleExcalidrawRequest(resolverFor('D:/ws'), requestDouble('/excalidraw/nope', 'GET') as never, double.res as never)
    expect(double.status).toBe(404)
    expect(double.json.error).toContain('unknown route')
  })

  it('returns 404 for a missing scene, then 200 after a write', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-test-'))
    try {
      const resolve = resolverFor(workspace)
      const missing = responseDouble()
      await handleExcalidrawRequest(resolve, requestDouble('/scene/current', 'POST', { cwd: workspace }) as never, missing.res as never)
      expect(missing.status).toBe(404)

      const written = responseDouble()
      const scene = { elements: [{ id: 'a', type: 'rectangle' }], appState: { theme: 'dark' } }
      await handleExcalidrawRequest(resolve, requestDouble('/scene/write', 'POST', { cwd: workspace, scene: JSON.stringify(scene) }) as never, written.res as never)
      expect(written.status).toBe(200)
      expect(written.json).toEqual({ ok: true })

      const read = responseDouble()
      await handleExcalidrawRequest(resolve, requestDouble('/scene/current', 'POST', { cwd: workspace }) as never, read.res as never)
      expect(read.status).toBe(200)
      expect(read.json).toEqual(scene)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a cwd outside the known workspaces', async () => {
    const double = responseDouble()
    await handleExcalidrawRequest(
      resolverFor('D:/ws'),
      requestDouble('/scene/current', 'POST', { cwd: 'D:/evil' }) as never,
      double.res as never,
    )
    expect(double.status).toBe(400)
    expect(double.json.error).toContain('not a known workspace')
  })

  it('rejects a non-string or invalid scene payload', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-test-'))
    try {
      const resolve = resolverFor(workspace)
      const badType = responseDouble()
      await handleExcalidrawRequest(resolve, requestDouble('/scene/write', 'POST', { cwd: workspace, scene: 42 }) as never, badType.res as never)
      expect(badType.status).toBe(400)

      const badJson = responseDouble()
      await handleExcalidrawRequest(resolve, requestDouble('/scene/write', 'POST', { cwd: workspace, scene: '{oops' }) as never, badJson.res as never)
      expect(badJson.status).toBe(400)
      expect(badJson.json.error).toContain('not valid JSON')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reports a corrupted scene file with 500', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-test-'))
    try {
      const scenePath = join(workspace, SCENE_RELATIVE)
      await mkdir(join(scenePath, '..'), { recursive: true })
      await writeFile(scenePath, '{not json', 'utf8')
      const double = responseDouble()
      await handleExcalidrawRequest(resolverFor(workspace), requestDouble('/scene/current', 'POST', { cwd: workspace }) as never, double.res as never)
      expect(double.status).toBe(500)
      expect(double.json.error).toContain('corrupted')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('persists the scene to <workspace>/.dsh/excalidraw/scene.json', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-test-'))
    try {
      const double = responseDouble()
      const scene = { elements: [], appState: {} }
      await handleExcalidrawRequest(resolverFor(workspace), requestDouble('/scene/write', 'POST', { cwd: workspace, scene: JSON.stringify(scene) }) as never, double.res as never)
      const onDisk = JSON.parse(await readFile(join(workspace, SCENE_RELATIVE), 'utf8')) as unknown
      expect(onDisk).toEqual(scene)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('requires a cwd field on scene routes', async () => {
    const double = responseDouble()
    await handleExcalidrawRequest(resolverFor('D:/ws'), requestDouble('/scene/current', 'POST', {}) as never, double.res as never)
    expect(double.status).toBe(400)
    expect(double.json.error).toContain('cwd required')
  })
})
