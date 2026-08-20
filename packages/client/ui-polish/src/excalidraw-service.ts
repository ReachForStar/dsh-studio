/**
 * Excalidraw canvas host service: persists workspace scene files for the
 * embedded whiteboard (the Excalidraw component runs in the client bundle
 * directly — no separate page). Exposed routes (all under the `/scene`
 * prefix, registered by the plugin apply):
 *
 *  - `POST /scene/current` {cwd}    → the workspace scene JSON, or 404.
 *  - `POST /scene/write` {cwd, scene} → overwrite the workspace scene file.
 *
 * The target workspace is chosen per request from `cwd`, resolved against the
 * host's known workspace paths — an unknown directory is rejected, so the
 * surface can never be pointed at an arbitrary path (same guard as the git
 * panel). Scenes live at `<workspace>/.dsh/excalidraw/scene.json`, keeping
 * them out of the visible working tree. Responses are JSON; errors carry an
 * `error` field.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SCENE_RELATIVE } from '@deepseek-ai/dsh-tool-excalidraw'
import { normalizeSlashes, type GitCwdResolver } from './git-service.ts'

/**
 * Write a JSON response with the given status code.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Read the JSON request body (small payloads only). */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Handle one `/scene` request.
 * @param resolveCwd - workspace-path resolver (see {@link GitCwdResolver}).
 * @param req - incoming HTTP request.
 * @param res - server response.
 */
export async function handleExcalidrawRequest(
  resolveCwd: GitCwdResolver,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://excalidraw-service')
  const path = url.pathname
  const method = req.method ?? 'GET'

  try {
    // Read the workspace scene file (404 when none exists yet).
    if (method === 'POST' && path === '/scene/current') {
      const body = await readJson(req)
      const requestedCwd = typeof body['cwd'] === 'string' ? body['cwd'] : ''
      if (requestedCwd.length === 0) {
        json(res, 400, { error: 'excalidraw: cwd required' })
        return
      }
      const resolved = resolveCwd(requestedCwd)
      if (normalizeSlashes(resolved) !== normalizeSlashes(requestedCwd)) {
        json(res, 400, { error: 'excalidraw: cwd not a known workspace' })
        return
      }
      const scenePath = join(resolved, SCENE_RELATIVE)
      let text: string
      try {
        text = await readFile(scenePath, 'utf8')
      } catch {
        json(res, 404, { error: 'excalidraw: no scene yet' })
        return
      }
      let scene: unknown
      try {
        scene = JSON.parse(text)
      } catch {
        json(res, 500, { error: 'excalidraw: corrupted scene file' })
        return
      }
      json(res, 200, scene)
      return
    }

    // Overwrite the workspace scene file.
    if (method === 'POST' && path === '/scene/write') {
      const body = await readJson(req)
      const requestedCwd = typeof body['cwd'] === 'string' ? body['cwd'] : ''
      if (requestedCwd.length === 0) {
        json(res, 400, { error: 'excalidraw: cwd required' })
        return
      }
      const resolved = resolveCwd(requestedCwd)
      if (normalizeSlashes(resolved) !== normalizeSlashes(requestedCwd)) {
        json(res, 400, { error: 'excalidraw: cwd not a known workspace' })
        return
      }
      const scene = body['scene']
      if (typeof scene !== 'string') {
        json(res, 400, { error: 'excalidraw: scene must be a JSON string' })
        return
      }
      // Validate it parses before persisting.
      let normalized: string
      try {
        normalized = JSON.stringify(JSON.parse(scene))
      } catch {
        json(res, 400, { error: 'excalidraw: scene is not valid JSON' })
        return
      }
      const scenePath = join(resolved, SCENE_RELATIVE)
      await mkdir(dirname(scenePath), { recursive: true })
      await writeFile(scenePath, normalized, 'utf8')
      json(res, 200, { ok: true })
      return
    }

    json(res, 404, { error: `excalidraw: unknown route ${method} ${path}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    json(res, 500, { error: message })
  }
}
