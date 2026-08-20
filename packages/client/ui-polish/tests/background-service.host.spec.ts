/** Background image service: upload to disk, serve, delete. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleBackgroundRequest } from '../src/background-service.ts'

/** 1x1 red PNG. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154'
  + '789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)

function responseDouble() {
  let statusCode = 0
  let body: Buffer = Buffer.alloc(0)
  const headers: Record<string, string> = {}
  return {
    res: {
      writeHead(status: number, h?: Record<string, string>) {
        statusCode = status
        if (h !== undefined) Object.assign(headers, h)
      },
      end(payload: string | Buffer) {
        body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      },
    },
    get status(): number { return statusCode },
    get body(): Buffer { return body },
    get headers(): Record<string, string> { return headers },
    text(): string { return body.toString('utf8') },
  }
}

function requestDouble(method: string, path: string, body?: Buffer) {
  return {
    url: path,
    method,
    on(event: 'data' | 'end' | 'error', fn: (chunk?: Buffer) => void) {
      if (event === 'data' && body !== undefined) fn(body)
      if (event === 'end') fn()
    },
    destroy() {},
  }
}

let dir = ''
let imagePath = ''
const MAX = 2 * 1024 * 1024

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-bg-'))
  imagePath = join(dir, 'background-image')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('background image service', () => {
  it('uploads raw image bytes to disk and serves them back', async () => {
    const up = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('POST', '/bg/upload', PNG) as never, up.res as never)
    expect(up.status).toBe(200)
    const body = JSON.parse(up.text()) as { url: string }
    expect(body.url).toBe('/bg/current')
    expect((await readFile(imagePath)).equals(PNG)).toBe(true)

    const get = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('GET', '/bg/current') as never, get.res as never)
    expect(get.status).toBe(200)
    expect(get.body.equals(PNG)).toBe(true)
    expect(get.headers['content-type']).toBe('image/png')
  })

  it('rejects non-image uploads', async () => {
    const up = responseDouble()
    await handleBackgroundRequest(
      imagePath,
      MAX,
      requestDouble('POST', '/bg/upload', Buffer.from('not an image')) as never,
      up.res as never,
    )
    expect(up.status).toBe(500)
    const parsed = JSON.parse(up.text()) as { error?: string }
    expect(parsed.error).toContain('not a supported image')
  })

  it('rejects oversized uploads', async () => {
    const big = Buffer.alloc(MAX + 1, 0x89)
    const up = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('POST', '/bg/upload', big) as never, up.res as never)
    expect(up.status).toBe(500)
    const parsed = JSON.parse(up.text()) as { error?: string }
    expect(parsed.error).toContain('too large')
  })

  it('serves 404 before any upload', async () => {
    const get = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('GET', '/bg/current') as never, get.res as never)
    expect(get.status).toBe(404)
  })

  it('deletes the stored image', async () => {
    await handleBackgroundRequest(imagePath, MAX, requestDouble('POST', '/bg/upload', PNG) as never, responseDouble().res as never)
    const del = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('DELETE', '/bg') as never, del.res as never)
    expect(del.status).toBe(200)
    const get = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('GET', '/bg/current') as never, get.res as never)
    expect(get.status).toBe(404)
  })

  it('rejects unknown routes', async () => {
    const r = responseDouble()
    await handleBackgroundRequest(imagePath, MAX, requestDouble('GET', '/bg/nope') as never, r.res as never)
    expect(r.status).toBe(404)
  })
})
