// Background image host service: persists the whole-app background image as a
// file on disk instead of a base64 data URL in the settings document, and
// serves it back. Routes (registered by the plugin apply):
//
//  - `POST   /bg/upload`  → raw image bytes; stored to the profile dir.
//  - `GET    /bg/current` → the stored image bytes (or 404).
//  - `DELETE /bg`         → remove the stored image.
//
// The browser stores the served URL (`/bg/current`) in the ui-polish settings
// field, so the settings document carries a short path, never megabytes of
// base64.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** The on-disk image file (profile-directory sibling; survives restarts). */
export const BACKGROUND_IMAGE_FILE = 'background-image'

/** Detect the image MIME from the magic bytes (PNG/JPEG/GIF/WebP), else null. */
function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return null
}

/** Read the raw request body up to a cap. */
function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) {
        reject(new Error('background: image too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () =>{  resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/**
 * Handle one `/bg` request.
 * @param imagePath - absolute path of the persisted image file.
 * @param maxBytes - upload cap.
 * @param req - incoming HTTP request.
 * @param res - server response.
 */
export async function handleBackgroundRequest(
  imagePath: string,
  maxBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://bg-service')
  const path = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (method === 'POST' && path === '/bg/upload') {
      const bytes = await readBody(req, maxBytes)
      if (bytes.length === 0) throw new Error('background: empty upload')
      const mime = sniffMime(bytes)
      if (mime === null) throw new Error('background: not a supported image')
      await mkdir(dirname(imagePath), { recursive: true })
      await writeFile(imagePath, bytes)
      const payload = JSON.stringify({ url: '/bg/current' })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(payload)
      return
    }

    if (method === 'GET' && path === '/bg/current') {
      let bytes: Buffer
      try {
        bytes = await readFile(imagePath)
      } catch {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'background: no image stored' }))
        return
      }
      const mime = sniffMime(bytes) ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' })
      res.end(bytes)
      return
    }

    if (method === 'DELETE' && path === '/bg') {
      await rm(imagePath, { force: true })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: `background: unknown route ${method} ${path}` }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: message }))
  }
}
