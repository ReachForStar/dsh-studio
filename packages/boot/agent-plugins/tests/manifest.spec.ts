import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadManifest, PLUGIN_MANIFEST_SCHEMA } from '../src/manifest.ts'

const created: string[] = []

async function pluginDir(manifest?: unknown, raw?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-manifest-'))
  created.push(dir)
  if (raw !== undefined) await writeFile(join(dir, 'plugin.json'), raw)
  else if (manifest !== undefined) await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
  return dir
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: PLUGIN_MANIFEST_SCHEMA, name: 'demo-plugin', ...overrides }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('loadManifest', () => {
  it('returns the identity and defaults the version', async () => {
    await expect(loadManifest(await pluginDir(valid()))).resolves.toEqual({ name: 'demo-plugin', version: '1.0.0' })
  })

  it('keeps the declared version and description', async () => {
    const dir = await pluginDir(valid({ version: '2.1.0', description: 'Portable tools' }))
    await expect(loadManifest(dir)).resolves.toEqual({ name: 'demo-plugin', version: '2.1.0', description: 'Portable tools' })
  })

  it('ignores blank optional fields', async () => {
    const dir = await pluginDir(valid({ version: '   ', description: '   ' }))
    await expect(loadManifest(dir)).resolves.toEqual({ name: 'demo-plugin', version: '1.0.0' })
  })

  it('rejects a missing manifest', async () => {
    await expect(loadManifest(await pluginDir())).rejects.toThrow()
  })

  it('rejects malformed JSON', async () => {
    const dir = await pluginDir(undefined, '{ not json')
    await expect(loadManifest(dir)).rejects.toThrow(/not valid JSON/)
  })

  it('rejects a manifest that is not an object', async () => {
    const dir = await pluginDir(undefined, '[]')
    await expect(loadManifest(dir)).rejects.toThrow(/is invalid/)
  })

  it('rejects an unsupported schema', async () => {
    const dir = await pluginDir(valid({ $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' }))
    await expect(loadManifest(dir)).rejects.toThrow(/unsupported schema/)
  })

  it.each([
    ['uppercase', 'Demo'],
    ['leading hyphen', '-demo'],
    ['trailing hyphen', 'demo-'],
    ['doubled hyphen', 'demo--plugin'],
    ['too long', 'a'.repeat(65)],
  ])('rejects an invalid name: %s', async (_label, name) => {
    const dir = await pluginDir(valid({ name }))
    await expect(loadManifest(dir)).rejects.toThrow(/invalid name/)
  })

  it('rejects a manifest that escapes the package through a symlink', async () => {
    const dir = await pluginDir()
    const outside = await pluginDir(valid())
    await symlink(join(outside, 'plugin.json'), join(dir, 'plugin.json'))
    await expect(loadManifest(dir)).rejects.toThrow(/resolves outside the package root/)
  })
})
