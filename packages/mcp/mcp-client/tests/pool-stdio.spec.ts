/** One spawned server process shared by two instances over real stdio. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveReconnectPolicy, startConnection } from '../src/connection.ts'
import type { Config } from '../src/index.ts'
import McpPool from '../src/pool.ts'
import { McpStatusCell } from '../src/status.ts'

const fixtureServerPath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))

/** Process ids the fixture server recorded at startup. */
function spawns(marker: string): string[] {
  return readFileSync(marker, 'utf8').split('\n').filter(line => line !== '')
}

it('reuses one handshake and process set for two instances of one configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-pool-stdio-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const marker = join(home, 'spawns')
  writeFileSync(marker, '')
  const config: Config = {
    transport: 'stdio', serverName: 'shared', command: process.execPath, args: [fixtureServerPath],
    env: { DSH_MCP_FIXTURE_SPAWN_MARKER: marker }, cwd: packageDir,
    toolCallTimeoutMs: 15_000, resourceWatchTimeoutMs: 30_000, maxResourceWatchTimeoutMs: 300_000,
    startupTimeoutMs: 30_000, closeTimeoutMs: 5_000,
    expandTemplates: false, failOnStartupError: false,
  }
  const ctx = new Context()
  onTestFinished(() => { void ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpPool)
  const policy = resolveReconnectPolicy({ enabled: false }, 'fixture')
  const alpha = startConnection(ctx, { ...config, serverName: 'alpha' }, policy, new McpStatusCell(() => {}))
  const beta = startConnection(ctx, { ...config, serverName: 'beta' }, policy, new McpStatusCell(() => {}))
  onTestFinished(async () => { await alpha.dispose(); await beta.dispose() })

  await alpha.ready
  // Era negotiation may probe with a disposable sibling process, so the first
  // instance fixes the baseline rather than assuming a single spawn.
  const baseline = spawns(marker).length
  expect(baseline).toBeGreaterThan(0)
  await beta.ready
  expect(spawns(marker)).toHaveLength(baseline)

  expect(ctx.tools.get('mcp__alpha__add')).toBeDefined()
  expect(ctx.tools.get('mcp__beta__add')).toBeDefined()

  await alpha.dispose()
  expect(spawns(marker)).toHaveLength(baseline)
  expect(ctx.tools.get('mcp__beta__add')).toBeDefined()
}, 60_000)
