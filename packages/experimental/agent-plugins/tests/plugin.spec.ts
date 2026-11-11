import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { apply } from '../src/index.ts'
import { PLUGIN_MANIFEST_SCHEMA } from '../src/manifest.ts'
import { PLUGIN_MCP_SCHEMA } from '../src/mcp.ts'

const created: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-agent-plugins-apply-${prefix}-`))
  created.push(dir)
  return dir
}

interface RegisteredServer {
  name: string
  entry: McpServerRegistration
}

interface McpManagerStub {
  manager: { register(name: string, entry: McpServerRegistration): () => void }
  servers: RegisteredServer[]
  disposed: string[]
}

interface PluginOptions {
  name?: string
  skills?: boolean
  mcp?: boolean
}

function stubMcpManager(): McpManagerStub {
  const servers: RegisteredServer[] = []
  const disposed: string[] = []
  return {
    manager: {
      register(name: string, entry: McpServerRegistration): () => void {
        servers.push({ name, entry })
        return () => { disposed.push(name) }
      },
    },
    servers,
    disposed,
  }
}

async function writePlugin(root: string, options: PluginOptions = {}): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'plugin.json'), JSON.stringify({
    $schema: PLUGIN_MANIFEST_SCHEMA,
    name: options.name ?? 'demo-plugin',
    version: '1.0.0',
  }))
  if (options.skills === true) {
    await mkdir(join(root, 'skills', 'alpha-skill'), { recursive: true })
    await writeFile(join(root, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: Alpha\n---\nbody')
  }
  if (options.mcp === true) {
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: PLUGIN_MCP_SCHEMA,
      mcpServers: { files: { type: 'stdio', command: 'server' } },
    }))
  }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('apply', () => {
  it('does nothing without configured packages', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const stub = stubMcpManager()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stub.manager)
    await apply(ctx, { dataRoot: await tempDir('empty') })
    expect(stub.servers).toEqual([])
    await expect(ctx.skills.list()).resolves.toEqual([])
  })

  it('publishes skills, registers servers, and creates the package data directory', async () => {
    const root = await tempDir('package')
    await writePlugin(root, { skills: true, mcp: true })
    const dataRoot = await tempDir('data')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const stub = stubMcpManager()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stub.manager)

    await apply(ctx, { plugins: [root], dataRoot })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['alpha-skill'])
    expect((await ctx.skills.get('alpha-skill'))?.content).toBe('body')
    expect(stub.servers.map(server => server.name)).toEqual(['demo-plugin-files'])
    expect(stub.servers[0]?.entry).toMatchObject({ transport: 'stdio', command: 'server' })
    expect(await readdir(join(dataRoot, 'demo-plugin'))).toEqual([])
  })

  it('withdraws registered servers when the mounting plugin disposes', async () => {
    const root = await tempDir('dispose')
    await writePlugin(root, { mcp: true })
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const stub = stubMcpManager()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stub.manager)

    const fiber = await ctx.plugin({ apply, inject: ['skills', 'mcpManager'] }, { plugins: [root], dataRoot: await tempDir('dispose-data') })
    expect(stub.servers.map(server => server.name)).toEqual(['demo-plugin-files'])
    await fiber.dispose()

    expect(stub.disposed).toEqual(['demo-plugin-files'])
  })

  it('skips a duplicate server name and reports it', async () => {
    const first = await tempDir('duplicate-a')
    const second = await tempDir('duplicate-b')
    await writePlugin(first, { mcp: true })
    await writePlugin(second, { mcp: true })
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const stub = stubMcpManager()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stub.manager)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await apply(ctx, { plugins: [first, second], dataRoot: await tempDir('duplicate-data') })

    expect(stub.servers.map(server => server.name)).toEqual(['demo-plugin-files'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered'))
  })

  it('rejects a configured directory without a valid manifest', async () => {
    const root = await tempDir('invalid')
    const ctx = new Context()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stubMcpManager().manager)
    await expect(apply(ctx, { plugins: [root], dataRoot: await tempDir('invalid-data') })).rejects.toThrow()
  })
})
describe('apply defaults', () => {
  it('derives the data root from the harness home when none is configured', async () => {
    const root = await tempDir('default-data')
    await writePlugin(root, { mcp: true })
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const stub = stubMcpManager()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stub.manager)

    await apply(ctx, { plugins: [root] })

    expect(stub.servers.map(server => server.name)).toEqual(['demo-plugin-files'])
  })

  it('leaves the package data directory alone for a package without stdio servers', async () => {
    const root = await tempDir('http-only')
    await writePlugin(root)
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: PLUGIN_MCP_SCHEMA,
      mcpServers: { remote: { type: 'streamable-http', url: 'https://mcp.example/dev' } },
    }))
    const dataRoot = await tempDir('http-only-data')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const stub = stubMcpManager()
    ctx.provide('mcpManager')
    ctx.set('mcpManager', stub.manager)

    await apply(ctx, { plugins: [root], dataRoot })

    expect(stub.servers.map(server => server.name)).toEqual(['demo-plugin-remote'])
    await expect(readdir(join(dataRoot, 'demo-plugin'))).rejects.toThrow()
  })
})
