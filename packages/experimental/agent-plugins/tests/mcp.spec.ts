import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandVariables, loadPluginMcpServers, PLUGIN_MCP_SCHEMA, serverKey } from '../src/mcp.ts'

const created: string[] = []

async function pluginRoot(mcp?: unknown, raw?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-mcp-'))
  created.push(dir)
  if (raw !== undefined) await writeFile(join(dir, 'mcp.json'), raw)
  else if (mcp !== undefined) await writeFile(join(dir, 'mcp.json'), JSON.stringify(mcp))
  return dir
}

function mcpFile(servers: Record<string, unknown>): Record<string, unknown> {
  return { $schema: PLUGIN_MCP_SCHEMA, mcpServers: servers }
}

async function load(root: string, name = 'demo'): Promise<Awaited<ReturnType<typeof loadPluginMcpServers>>> {
  return await loadPluginMcpServers({ root, name, dataRoot: join(root, '.data') })
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('loadPluginMcpServers', () => {
  it('returns nothing without an mcp.json', async () => {
    await expect(load(await pluginRoot())).resolves.toEqual([])
  })

  it('rejects malformed JSON', async () => {
    await expect(load(await pluginRoot(undefined, '{ nope'))).rejects.toThrow(/not valid JSON/)
  })

  it.each([
    ['unsupported schema', { $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json', mcpServers: {} }],
    ['missing servers object', { $schema: PLUGIN_MCP_SCHEMA }],
    ['a non-object entry', mcpFile({ broken: 'stdio' })],
  ])('disables MCP for %s', async (_label, value) => {
    await expect(load(await pluginRoot(value))).resolves.toEqual([])
  })

  it('normalizes stdio entries and creates the package namespace', async () => {
    const root = await pluginRoot(mcpFile({
      'files.read': {
        type: 'stdio',
        command: '${PLUGIN_ROOT}/bin/server',
        args: ['--data', '${PLUGIN_DATA}'],
        env: { DATA: '${PLUGIN_DATA}' },
      },
    }))
    const servers = await load(root)
    expect(servers).toEqual([{
      serverName: 'demo-files-read',
      registration: {
        transport: 'stdio',
        command: join(root, 'bin', 'server'),
        args: ['--data', join(root, '.data')],
        env: { DATA: join(root, '.data'), PLUGIN_ROOT: root, PLUGIN_DATA: join(root, '.data') },
        cwd: root,
      },
    }])
  })

  it('keeps an absolute cwd from the entry', async () => {
    const root = await pluginRoot(mcpFile({ files: { type: 'stdio', command: 'server', cwd: '/opt/work' } }))
    await expect(load(root)).resolves.toMatchObject([{ registration: { cwd: '/opt/work' } }])
  })

  it.each([
    ['a blank command', { type: 'stdio', command: '   ' }],
    ['a relative cwd', { type: 'stdio', command: 'server', cwd: './bin' }],
    ['a non-absolute cwd', { type: 'stdio', command: 'server', cwd: 'bin' }],
  ])('skips a stdio entry with %s', async (_label, entry) => {
    await expect(load(await pluginRoot(mcpFile({ broken: entry })))).resolves.toEqual([])
  })

  it('accepts streamable HTTP entries', async () => {
    const root = await pluginRoot(mcpFile({ remote: { type: 'streamable-http', url: 'https://mcp.example/dev', headers: { 'x-tenant': 'demo' } } }))
    await expect(load(root)).resolves.toEqual([{
      serverName: 'demo-remote',
      registration: { transport: 'streamable-http', url: 'https://mcp.example/dev', headers: { 'x-tenant': 'demo' } },
    }])
  })

  it.each([
    ['a non-HTTP url', { type: 'streamable-http', url: 'ftp://mcp.example/dev' }],
    ['a missing url', { type: 'streamable-http' }],
    ['a client-owned header', { type: 'streamable-http', url: 'https://mcp.example/dev', headers: { Authorization: 'Bearer token' } }],
  ])('skips an HTTP entry with %s', async (_label, entry) => {
    await expect(load(await pluginRoot(mcpFile({ broken: entry })))).resolves.toEqual([])
  })

  it.each([
    ['legacy SSE', { type: 'sse', url: 'https://mcp.example/dev' }],
    ['an unknown transport', { type: 'websocket', url: 'wss://mcp.example/dev' }],
  ])('skips %s', async (_label, entry) => {
    await expect(load(await pluginRoot(mcpFile({ broken: entry })))).resolves.toEqual([])
  })
})

describe('expandVariables', () => {
  it('replaces both portable variables', () => {
    expect(expandVariables('${PLUGIN_ROOT}/${PLUGIN_DATA}', { root: '/pkg', dataRoot: '/data' })).toBe('/pkg//data')
    expect(expandVariables('plain', { root: '/pkg', dataRoot: '/data' })).toBe('plain')
  })
})

describe('serverKey', () => {
  it('joins the package and entry names', () => {
    expect(serverKey('demo', 'files')).toBe('demo-files')
  })

  it('replaces characters outside the MCP namespace pattern', () => {
    expect(serverKey('demo.plugin', 'files/read')).toBe('demo-plugin-files-read')
  })

  it('keeps a stable hash suffix when the joined name is too long', () => {
    const key = serverKey('demo', 'a'.repeat(40))
    expect(key).toHaveLength(32)
    expect(key).toBe(serverKey('demo', 'a'.repeat(40)))
    expect(key).not.toBe(serverKey('demo', 'a'.repeat(39)))
  })
})
describe('loadPluginMcpServers stdio defaults', () => {
  it('skips a stdio entry without a command', async () => {
    await expect(load(await pluginRoot(mcpFile({ broken: { type: 'stdio' } })))).resolves.toEqual([])
  })

  it('defaults args and env when the entry omits them', async () => {
    const root = await pluginRoot(mcpFile({ files: { type: 'stdio', command: 'server' } }))
    await expect(load(root)).resolves.toMatchObject([{ registration: { args: [], env: { PLUGIN_ROOT: root } } }])
  })
})
