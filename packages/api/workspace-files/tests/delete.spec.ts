/**
 * workspaceFiles.delete: path-addressed removal confined to the workspace.
 *
 * The gates are the point: a link is removed as the link (never as what it
 * points at), the parent's canonical path is what proves containment, and a
 * directory with contents goes only when the caller says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceFiles, type WorkspaceFileScope } from '../src/index.ts'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => { harness = await openWorkspace('dsh-workspace-files-remove-') })
afterEach(async () => { await harness.dispose() })

/** Whether a path exists, without caring which syscall says so. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

describe('workspaceFiles.delete', () => {
  it('deletes a file and reports what it was', async () => {
    await writeFile(join(harness.workspace, 'file.txt'), 'gone soon')

    expect(await harness.endpoint().delete(harness.scope, 'file.txt', {}, signal())).toEqual({ kind: 'file' })
    expect(await exists(join(harness.workspace, 'file.txt'))).toBe(false)
  })

  it('deletes an empty directory without the recursive flag', async () => {
    await mkdir(join(harness.workspace, 'empty'))

    expect(await harness.endpoint().delete(harness.scope, 'empty', {}, signal())).toEqual({ kind: 'directory' })
    expect(await exists(join(harness.workspace, 'empty'))).toBe(false)
  })

  it('refuses a non-empty directory without recursive, and removes it with it', async () => {
    await mkdir(join(harness.workspace, 'tree', 'deep'), { recursive: true })
    await writeFile(join(harness.workspace, 'tree', 'deep', 'leaf.txt'), 'leaf')

    expect(await failureOf(harness.endpoint().delete(harness.scope, 'tree', {}, signal())))
      .toEqual({ code: 'workspace-file/not-empty', details: { path: 'tree' } })
    expect(await exists(join(harness.workspace, 'tree', 'deep', 'leaf.txt'))).toBe(true)

    expect(await harness.endpoint().delete(harness.scope, 'tree', { recursive: true }, signal()))
      .toEqual({ kind: 'directory' })
    expect(await exists(join(harness.workspace, 'tree'))).toBe(false)
  })

  it('deletes a link as the link, leaving what it points at', async () => {
    const target = join(harness.outside, 'pointed-at.txt')
    await writeFile(target, 'still here')
    await symlink(target, join(harness.workspace, 'link.txt'))

    expect(await harness.endpoint().delete(harness.scope, 'link.txt', {}, signal())).toEqual({ kind: 'symlink' })
    expect(await exists(join(harness.workspace, 'link.txt'))).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('still here')
  })

  it('refuses a path outside the workspace, and one reached through a link that leaves it', async () => {
    const outside = join(harness.outside, 'reachable.txt')
    await writeFile(outside, 'outside')
    await symlink(harness.outside, join(harness.workspace, 'out'))

    expect(await failureOf(harness.endpoint().delete(harness.scope, outside, {}, signal())))
      .toEqual({ code: 'workspace-file/outside-workspace', details: { path: outside } })
    expect(await failureOf(harness.endpoint().delete(harness.scope, join(harness.workspace, 'out', 'reachable.txt'), {}, signal())))
      .toEqual({
        code: 'workspace-file/outside-workspace',
        details: { path: join(harness.workspace, 'out', 'reachable.txt') },
      })
    expect(await exists(outside)).toBe(true)
  })

  it('refuses the workspace root itself', async () => {
    expect(await failureOf(harness.endpoint().delete(harness.scope, harness.workspace, { recursive: true }, signal())))
      .toEqual({ code: 'workspace-file/outside-workspace', details: { path: harness.workspace } })
    expect(await exists(harness.workspace)).toBe(true)
  })

  it('propagates any other backend refusal with its own code', async () => {
    // The real backend cannot produce a third refusal here, so this one case uses
    // a stub: what it pins is that the service maps only `FS_NOT_EMPTY` and lets
    // every other refusal reach the caller as itself.
    const ctx = new Context()
    ctx.provide('fs', {
      resolve: async (path: string) => ({ targetKey: FsTargetKey(path), displayPath: path }),
      processPath: (target: { targetKey: unknown }) => String(target.targetKey),
      lstat: async () => ({ version: FsVersion('v1'), type: 'file' }),
      contains: () => true,
      remove: async () => { throw new FsError('the disk caught fire', 'FS_IO_ERROR') },
    } as never)
    const scope: WorkspaceFileScope = { sessionId: SessionId('s-test'), workspaceRoot: '/work' }
    const service = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 10, maxEntries: 10 })

    await expect(service.delete(scope, '/work/file.txt', {}, signal())).rejects.toThrow('the disk caught fire')
  })

  it('reports a missing entry as not-found', async () => {
    expect(await failureOf(harness.endpoint().delete(harness.scope, 'never-was.txt', {}, signal())))
      .toEqual({ code: 'workspace-file/not-found', details: { path: 'never-was.txt' } })
  })
})
