import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { OverlayFileSystem } from '../src/overlay.ts'

let root: string
let workspaceRoot: string
let overlayRoot: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-overlay-'))
  workspaceRoot = join(root, 'repo')
  overlayRoot = join(root, 'overlay')
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(overlayRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(root, { recursive: true, force: true })
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: workspaceRoot })
  const base = ctx.fs
  const proxyCtx = new Context()
  contexts.push(proxyCtx)
  const overlay = new OverlayFileSystem({ base, workspaceRoot, overlayRoot, ctx: proxyCtx })
  return { base, overlay }
}

describe('OverlayFileSystem', () => {
  it('writes into the overlay and leaves the workspace untouched until commit', async () => {
    const { base, overlay } = await harness()
    await writeFile(join(workspaceRoot, 'a.txt'), 'original')
    const target = await overlay.resolve('a.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'speculated')
    expect(await readFile(join(workspaceRoot, 'a.txt'), 'utf8')).toBe('original')
    expect(await readFile(join(overlayRoot, 'a.txt'), 'utf8')).toBe('speculated')
    // reads prefer the overlay copy
    expect(await overlay.readText(target)).toBe('speculated')
    const committed = await overlay.commit()
    expect(committed).toEqual([join(workspaceRoot, 'a.txt')])
    expect(await readFile(join(workspaceRoot, 'a.txt'), 'utf8')).toBe('speculated')
    void base
  })

  it('discards overlay content without touching the workspace', async () => {
    const { overlay } = await harness()
    await writeFile(join(workspaceRoot, 'b.txt'), 'original')
    const target = await overlay.resolve('b.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'speculated')
    const removed = await overlay.discard()
    expect(removed).toHaveLength(1)
    expect(await overlay.readText(target)).toBe('original')
    expect(await readFile(join(workspaceRoot, 'b.txt'), 'utf8')).toBe('original')
  })

  it('refuses writes outside the workspace', async () => {
    const { overlay } = await harness()
    const outside = await overlay.resolve('/tmp', { cwd: workspaceRoot })
    await expect(overlay.writeText(outside, 'x')).rejects.toThrow('path outside workspace')
  })

  it('serves reads from the workspace when the overlay has no copy', async () => {
    const { overlay } = await harness()
    await writeFile(join(workspaceRoot, 'c.txt'), 'workspace')
    const target = await overlay.resolve('c.txt', { cwd: workspaceRoot })
    expect(await overlay.readText(target)).toBe('workspace')
    expect(await overlay.stat(target)).toBeDefined()
  })

  it('removes overlay copies through the path-based removal', async () => {
    const { overlay } = await harness()
    await writeFile(join(workspaceRoot, 'd.txt'), 'original')
    const target = await overlay.resolve('d.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'speculated')
    await overlay.remove(join(workspaceRoot, 'd.txt'))
    await expect(overlay.readText(target)).resolves.toBe('original')
  })
})

describe('OverlayFileSystem delegation', () => {
  it('delegates path and containment helpers to the base provider', async () => {
    const { overlay } = await harness()
    const target = await overlay.resolve('a.txt', { cwd: workspaceRoot })
    expect(overlay.processPath(target)).toBe(join(workspaceRoot, 'a.txt'))
    expect(overlay.fileUrl(target)).toContain('file://')
    expect(overlay.contains(target, target)).toBe(true)
  })

  it('serves streamed, ranged, listed, and lstat reads through the overlay', async () => {
    const { overlay } = await harness()
    await writeFile(join(workspaceRoot, 'e.txt'), 'workspace text')
    const target = await overlay.resolve('e.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'overlay text')

    const chunks: string[] = []
    for await (const chunk of await overlay.streamText(target)) chunks.push(chunk)
    expect(chunks.join('')).toBe('overlay text')

    const bytes = await overlay.readBytes(target, undefined, 64)
    expect(new TextDecoder().decode(bytes)).toBe('overlay text')
    const range = await overlay.readByteRange(target, { offset: 0, length: 7 })
    expect(new TextDecoder().decode(range)).toBe('overlay')

    const dir = await overlay.resolve('.', { cwd: workspaceRoot })
    expect((await overlay.listDir(dir)).length).toBeGreaterThan(0)
    expect(await overlay.lstat('e.txt', { cwd: workspaceRoot })).toBeDefined()
  })

  it('routes edit, patch, delete, and move into the overlay', async () => {
    const { base, overlay } = await harness()
    await writeFile(join(workspaceRoot, 'f.txt'), 'one\ntwo\n')
    const target = await overlay.resolve('f.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'one\ntwo\n')
    const editSpy = vi.spyOn(base, 'editText').mockResolvedValue({
      version: 'v' as never, before: 'one\ntwo\n', after: 'one\nthree\n',
    })
    const edited = await overlay.editText(target, { oldString: 'two', newString: 'three', replaceAll: false })
    expect(edited.after).toContain('three')
    expect(editSpy).toHaveBeenCalled()
    editSpy.mockRestore()
    expect(await readFile(join(workspaceRoot, 'f.txt'), 'utf8')).toBe('one\ntwo\n')

    await overlay.writeText(target, 'changed\n')
    // The spy returns before touching the overlay, so the file keeps this content.
    const spy = vi.spyOn(base, 'patchText').mockResolvedValue({
      version: 'v' as never, before: 'changed\n', after: 'changed\n',
    })
    await overlay.patchText(target, [])
    expect(await overlay.readText(target)).toBe('changed\n')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()

    const source = await overlay.resolve('f.txt', { cwd: workspaceRoot })
    const destination = await overlay.resolve('g.txt', { cwd: workspaceRoot })
    await overlay.moveFile(source, destination)
    expect(await readFile(join(overlayRoot, 'g.txt'), 'utf8')).toContain('changed')

    await overlay.deleteFile(destination)
    await expect(overlay.readText(destination)).rejects.toThrow()
  })

  it('maps the workspace root itself and honours abort signals', async () => {
    const { overlay } = await harness()
    const rootTarget = await overlay.resolve('.', { cwd: workspaceRoot })
    expect(await overlay.stat(rootTarget)).toBeDefined()
    const signal = new AbortController().signal
    expect(await overlay.lstat('.', { cwd: workspaceRoot }, signal)).toBeDefined()
    await writeFile(join(workspaceRoot, 'i.txt'), 'original')
    const target = await overlay.resolve('i.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'speculated')
    await overlay.remove(join(workspaceRoot, 'i.txt'), undefined, signal)
    expect(await overlay.readText(target)).toBe('original')
  })

  it('skips discarded overlays that no longer exist', async () => {
    const { overlay } = await harness()
    await writeFile(join(workspaceRoot, 'j.txt'), 'original')
    const target = await overlay.resolve('j.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'speculated')
    await rm(join(overlayRoot, 'j.txt'), { force: true })
    expect(await overlay.discard()).toEqual([])
  })

  it('reports skipped overlays during commit and discard', async () => {
    const { overlay } = await harness()
    await writeFile(join(workspaceRoot, 'h.txt'), 'original')
    const target = await overlay.resolve('h.txt', { cwd: workspaceRoot })
    await overlay.writeText(target, 'speculated')
    // A recorded overlay path that no longer exists is skipped, not committed.
    await overlay.remove(join(workspaceRoot, 'h.txt'))
    expect(await overlay.commit()).toEqual([])
    void target
  })
})
