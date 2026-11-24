/** A text-only backend must refuse binary writes instead of truncating bytes. */
import { describe, expect, it } from 'vitest'
import { FileSystem } from '../src/index.ts'

describe('text-only backend binary writes', () => {
  it('rejects writeBytes with FS_UNSUPPORTED_BINARY_WRITE', async () => {
    // The base implementation reads no state, so a prototype-backed instance is enough.
    const backend = Object.create(FileSystem.prototype) as FileSystem
    await expect(backend.writeBytes({} as never, new Uint8Array([1, 2]), undefined, undefined, undefined))
      .rejects.toMatchObject({
        code: 'FS_UNSUPPORTED_BINARY_WRITE',
        message: 'this filesystem backend carries text only and cannot store binary content',
      })
  })
})
