/**
 * HTTP plumbing shared by the paper library and translation surfaces: bounded
 * body reads and JSON responses. A request the surface answers with a specific
 * status is a {@link PaperRequestError}; anything else is a server fault.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** A request the surface answers with a specific status instead of a server fault. */
export class PaperRequestError extends Error {
  /** HTTP status the surface answers with. */
  readonly status: number

  /**
   * @param status - HTTP status to answer with.
   * @param message - diagnostic body text.
   */
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Read a request body up to a byte cap.
 * @param req - incoming request.
 * @param cap - largest accepted body.
 * @returns the complete body.
 * @throws {PaperRequestError} when the body exceeds the cap.
 */
export function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) {
        reject(new PaperRequestError(413, `paper: request exceeds ${String(cap)} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/**
 * Answer with one JSON body and no caching.
 * @param res - server response.
 * @param status - HTTP status.
 * @param body - JSON body.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
