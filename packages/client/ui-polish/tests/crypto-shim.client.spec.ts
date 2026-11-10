// @vitest-environment jsdom
/** Browser crypto shim: Web Crypto wrappers, MD5/SHA-1 digests, and the Buffer fallback. */
import { createHash as nodeCreateHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import shim, {
  createHash, getRandomValues, randomBytes, randomFillSync, randomUUID, webcrypto,
} from '../src/client/crypto-shim.ts'

afterEach(() => {
  vi.resetModules()
})

/** Lower-case hex of a digest. */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** Reference digest from Node's crypto for the same algorithm and input. */
function nodeDigest(algorithm: 'md5' | 'sha1', input: Uint8Array | string): string {
  return nodeCreateHash(algorithm).update(input).digest('hex')
}

describe('random helpers', () => {
  it('fills a buffer in place with random bytes', () => {
    const buffer = new Uint8Array(16)
    expect(randomFillSync(buffer)).toBe(buffer)
    expect(buffer.some(byte => byte !== 0)).toBe(true)
  })

  it('returns a fresh buffer of the requested size', () => {
    const bytes = randomBytes(8)
    expect(bytes).toHaveLength(8)
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it('returns a v4 UUID', () => {
    expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('exposes the platform Web Crypto object and fills any view', () => {
    expect(webcrypto).toBe(crypto)
    const view = new Uint32Array(4)
    expect(getRandomValues(view)).toBe(view)
  })
})

describe('createHash', () => {
  it('matches Node MD5 and SHA-1 across padding and block boundaries', () => {
    for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 1_000]) {
      const input = new Uint8Array(length).map((_, index) => (index * 37) % 256)
      for (const algorithm of ['md5', 'sha1'] as const) {
        const hash = createHash(algorithm)
        hash.update(input)
        expect(hex(hash.digest())).toBe(nodeDigest(algorithm, input))
      }
    }
  })

  it('accepts strings and chains updates', () => {
    const hash = createHash('sha1')
    expect(hash.update('abc')).toBe(hash)
    hash.update(new Uint8Array([0x64]))
    expect(hex(hash.digest())).toBe(nodeDigest('sha1', 'abcd'))
    const empty = createHash('md5')
    empty.update('')
    expect(hex(empty.digest())).toBe(nodeDigest('md5', ''))
  })

  it('is reachable through the default export', () => {
    expect(shim.createHash).toBe(createHash)
    expect(shim.randomFillSync).toBe(randomFillSync)
    expect(shim.randomBytes).toBe(randomBytes)
    expect(shim.randomUUID).toBe(randomUUID)
    expect(shim.webcrypto).toBe(webcrypto)
    expect(shim.getRandomValues).toBe(getRandomValues)
  })
})

describe('Buffer fallback', () => {
  it('installs a minimal Buffer when the platform has none', async () => {
    const holder = globalThis as { Buffer?: unknown }
    const saved = holder.Buffer
    try {
      delete holder.Buffer
      vi.resetModules()
      await import('../src/client/crypto-shim.ts')
      const fallback = holder.Buffer as {
        allocUnsafe: (size: number) => Uint8Array
        from: (value: unknown) => Uint8Array
      }
      expect(fallback.allocUnsafe(3)).toHaveLength(3)
      expect([...fallback.from('ab')]).toEqual([0x61, 0x62])
      expect([...fallback.from([1, 2])]).toEqual([1, 2])
      expect(fallback.from(new Uint8Array([3]))).toEqual(new Uint8Array([3]))
      expect(() => fallback.from(42)).toThrow(/Buffer\.from/)
    } finally {
      holder.Buffer = saved
    }
  })
})
