/**
 * The face's write path: a save reports the committed version, keeps the
 * Host's refusal, writes nothing for a tab whose record already ended, and
 * drops a settlement the tab outlived.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileStat, WorkspaceFileText } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { textFace } from '../src/client/face.ts'
import type { ReadDocumentBytes, ReadWorkspaceFilePage, WriteWorkspaceFile, WriteWorkspaceFileBytes } from '../src/client/rpc.ts'
import { createTextStore } from '../src/client/store.ts'
import { ABSOLUTE_PATH, FILE, PATH } from './fixtures.client.ts'

const TAB = 'tab-save' as TabId

/** One write awaiting the spec's answer. */
interface PendingWrite {
  resolve(result: RemoteResult<WorkspaceFileStat>): void
}

/** A store, a face over a pending write, and the write's settlement. */
function bench(): {
  readonly instance: ReturnType<ReturnType<typeof createTextStore>['create']>
  readonly face: ReturnType<ReturnType<typeof textFace>>
  readonly write: ReturnType<typeof vi.fn<WriteWorkspaceFile>>
  readonly writeBytes: ReturnType<typeof vi.fn<WriteWorkspaceFileBytes>>
  readonly pending: PendingWrite
} {
  const instance = createTextStore().create()
  const read = vi.fn<ReadWorkspaceFilePage>(() => Promise.resolve({
    ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 1, text: 'one', lines: 1, eof: true, bytes: 3 },
  } satisfies RemoteResult<WorkspaceFileText>))
  const bytes = vi.fn<ReadDocumentBytes>()
  const pending: PendingWrite = { resolve: () => undefined }
  const write = vi.fn<WriteWorkspaceFile>(() => new Promise<RemoteResult<WorkspaceFileStat>>((resolve) => {
    pending.resolve = resolve
  }))
  const writeBytes = vi.fn<WriteWorkspaceFileBytes>(() => new Promise<RemoteResult<WorkspaceFileStat>>((resolve) => {
    pending.resolve = resolve
  }))
  return {
    instance,
    face: textFace(read, bytes, write, writeBytes)('s-1' as never, instance.actions),
    write,
    writeBytes,
    pending,
  }
}

/** Let a settled promise reach the face. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('face.save', () => {
  it('records the version a committed write reports', async () => {
    const { face, instance, write, pending } = bench()
    face.save(TAB, FILE, 'next', 'v1', new AbortController().signal)

    expect(write).toHaveBeenCalledWith(FILE, 'next', 'v1', expect.anything())
    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ writing: true })

    pending.resolve({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v2', bytes: 4 } })
    await settle()

    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ writing: false, version: 'v2', writeFailure: undefined })
  })

  it('keeps the Host refusal', async () => {
    const { face, instance, pending } = bench()
    face.save(TAB, FILE, 'next', 'v1', new AbortController().signal)
    pending.resolve({
      ok: false,
      error: { code: 'workspace-file/stale-version', message: 'moved', details: { path: PATH } } as never,
    })
    await settle()

    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({
      writing: false,
      writeFailure: { code: 'workspace-file/stale-version' },
    })
  })

  it('writes nothing for a tab whose record already ended', () => {
    const { face, write } = bench()
    const controller = new AbortController()
    controller.abort()
    face.save(TAB, FILE, 'next', 'v1', controller.signal)
    expect(write).not.toHaveBeenCalled()
  })

  it('drops a settlement the tab outlived', async () => {
    const { face, instance, pending } = bench()
    const controller = new AbortController()
    face.save(TAB, FILE, 'next', 'v1', controller.signal)
    controller.abort()
    pending.resolve({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v9', bytes: 4 } })
    await settle()

    // The record's end forgot the bucket, so the settlement had nothing to write.
    expect(instance.getSnapshot().byTab[TAB]).toBeUndefined()
  })
})

describe('face.saveBytes', () => {
  it('records the version a committed binary write reports', async () => {
    const { face, instance, writeBytes, pending } = bench()
    const data = Uint8Array.from([1, 2])
    face.saveBytes(TAB, FILE, data, 'v1', new AbortController().signal)

    expect(writeBytes).toHaveBeenCalledWith(FILE, data, 'v1', expect.anything())
    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ writing: true })

    pending.resolve({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v3', bytes: 2 } })
    await settle()

    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ writing: false, version: 'v3' })
  })

  it('keeps a refused binary write and writes nothing after the record ended', async () => {
    const { face, instance, writeBytes, pending } = bench()
    face.saveBytes(TAB, FILE, Uint8Array.from([1]), 'v1', new AbortController().signal)
    pending.resolve({
      ok: false,
      error: { code: 'workspace-file/binary-unsupported', message: 'text only', details: { path: PATH } } as never,
    })
    await settle()
    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ writeFailure: { code: 'workspace-file/binary-unsupported' } })

    const controller = new AbortController()
    controller.abort()
    face.saveBytes(TAB, FILE, Uint8Array.from([2]), 'v1', controller.signal)
    expect(writeBytes).toHaveBeenCalledTimes(1)
  })

  it('drops a binary settlement whose read generation moved on', async () => {
    const { face, instance, pending } = bench()
    face.saveBytes(TAB, FILE, Uint8Array.from([1]), 'v1', new AbortController().signal)
    // A mode change retires the reads — and the writes — of the old generation.
    face.reloadPages(TAB, FILE, new AbortController().signal)
    pending.resolve({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v9', bytes: 1 } })
    await settle()

    expect(instance.getSnapshot().byTab[TAB]?.version).not.toBe('v9')
  })
})
