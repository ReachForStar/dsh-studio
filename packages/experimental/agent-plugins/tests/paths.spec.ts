import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isContained, resolveContained, resolveContainedOrUnusable } from '../src/paths.ts'

const created: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-agent-plugins-${prefix}-`))
  created.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('isContained', () => {
  it('accepts the root itself and descendants', () => {
    expect(isContained('/a/b', '/a/b')).toBe(true)
    expect(isContained('/a/b', '/a/b/c/d.md')).toBe(true)
  })

  it('rejects siblings, parents, and absolute paths outside the root', () => {
    expect(isContained('/a/b', '/a/bc')).toBe(false)
    expect(isContained('/a/b', '/a')).toBe(false)
    expect(isContained('/a/b', '/c/d')).toBe(false)
  })
})

describe('resolveContained', () => {
  it('resolves a component inside the root', async () => {
    const root = await tempDir('contained')
    await writeFile(join(root, 'plugin.json'), '{}')
    await expect(resolveContained(root, join(root, 'plugin.json'))).resolves.toBe(await realpath(join(root, 'plugin.json')))
  })

  it('rejects a component that a symlink moves outside the root', async () => {
    const root = await tempDir('escape-root')
    const outside = await tempDir('escape-outside')
    await writeFile(join(outside, 'target.md'), '# outside')
    await symlink(join(outside, 'target.md'), join(root, 'link.md'))
    await expect(resolveContained(root, join(root, 'link.md'))).rejects.toThrow(/resolves outside the package root/)
  })
})

describe('resolveContainedOrUnusable', () => {
  it('returns the resolved path for a contained component', async () => {
    const root = await tempDir('unusable-ok')
    await mkdir(join(root, 'skills'), { recursive: true })
    await expect(resolveContainedOrUnusable(root, join(root, 'skills'))).resolves.toBe(await realpath(join(root, 'skills')))
  })

  it('returns undefined for a missing component', async () => {
    const root = await tempDir('unusable-missing')
    await expect(resolveContainedOrUnusable(root, join(root, 'mcp.json'))).resolves.toBeUndefined()
  })

  it('returns undefined when the component resolves outside the root', async () => {
    const root = await tempDir('unusable-escape')
    const outside = await tempDir('unusable-target')
    await symlink(outside, join(root, 'skills'))
    await expect(resolveContainedOrUnusable(root, join(root, 'skills'))).resolves.toBeUndefined()
  })
})
