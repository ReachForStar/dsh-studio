/** workspaceFiles.write: atomic text replacement guarded by version and confined to the workspace. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => { harness = await openWorkspace('dsh-workspace-files-write-') })
afterEach(async () => { await harness.dispose() })

describe('workspaceFiles.write', () => {
  it('replaces the file and reports the version the write produced', async () => {
    const path = join(harness.workspace, 'file.txt')
    await writeFile(path, 'old')
    const result = await harness.endpoint().write(harness.scope, 'file.txt', 'new text', {}, signal())

    expect(await readFile(path, 'utf8')).toBe('new text')
    expect(result.absolutePath).toBe(path)
    expect(result.version).toBe((await harness.endpoint().stat(harness.scope, 'file.txt', signal())).version)
  })

  it('writes through a version guard the caller read', async () => {
    await writeFile(join(harness.workspace, 'guarded.txt'), 'old')
    const before = await harness.endpoint().stat(harness.scope, 'guarded.txt', signal())

    await harness.endpoint().write(harness.scope, 'guarded.txt', 'next', { expectedVersion: before.version }, signal())

    expect(await readFile(join(harness.workspace, 'guarded.txt'), 'utf8')).toBe('next')
  })

  it('refuses a stale guard instead of discarding newer content', async () => {
    const path = join(harness.workspace, 'stale.txt')
    await writeFile(path, 'old')
    const before = await harness.endpoint().stat(harness.scope, 'stale.txt', signal())
    await writeFile(path, 'someone else wrote this')

    expect(await failureOf(harness.endpoint().write(harness.scope, 'stale.txt', 'mine', { expectedVersion: before.version }, signal())))
      .toEqual({ code: 'workspace-file/stale-version', details: { path: 'stale.txt' } })
    expect(await readFile(path, 'utf8')).toBe('someone else wrote this')
  })

  it('keeps writes inside the workspace', async () => {
    const outside = join(harness.outside, 'reachable.txt')
    await writeFile(outside, 'outside')

    expect(await failureOf(harness.endpoint().write(harness.scope, outside, 'changed', {}, signal())))
      .toEqual({ code: 'workspace-file/outside-workspace', details: { path: outside } })
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('retains the missing-file and kind gates', async () => {
    await mkdir(join(harness.workspace, 'directory'))
    const files = harness.endpoint()
    expect((await failureOf(files.write(harness.scope, 'missing.txt', 'x', {}, signal()))).code)
      .toBe('workspace-file/not-found')
    expect((await failureOf(files.write(harness.scope, 'directory', 'x', {}, signal()))).code)
      .toBe('workspace-file/not-regular-file')
  })

  it('refuses oversized content before touching the backend', async () => {
    const path = join(harness.workspace, 'big.txt')
    await writeFile(path, 'old')
    const write = vi.spyOn(harness.ctx.fs, 'writeText')

    expect(await failureOf(harness.endpoint({ maxFileBytes: 4 }).write(harness.scope, 'big.txt', 'abcde', {}, signal())))
      .toEqual({ code: 'workspace-file/too-large', details: { path: 'big.txt', limit: 4 } })
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe('old')
  })

  it('writes an empty file', async () => {
    const path = join(harness.workspace, 'empty.txt')
    await writeFile(path, 'content')

    await harness.endpoint().write(harness.scope, 'empty.txt', '', {}, signal())

    expect(await readFile(path, 'utf8')).toBe('')
  })
})
