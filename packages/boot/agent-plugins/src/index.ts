/**
 * Agent Plugins v1 loader. It turns configured portable packages into harness
 * capabilities: `skills/<dir>/SKILL.md` components join the `ctx.skills`
 * catalog, and root `mcp.json` entries register with `ctx.mcpManager`. Package
 * files are read, never rewritten, so the same directory keeps working for
 * every tool that understands the v1 layout.
 * @module @deepseek-ai/dsh-agent-plugins
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { loadManifest } from './manifest.ts'
import { loadPluginMcpServers } from './mcp.ts'
import { AgentPluginSkillProvider } from './skills.ts'
import type { AgentPluginSkillSource } from './skills.ts'

export const name = 'agent-plugins'
export const inject = ['skills', 'mcpManager']

/** Duplicate-name rank assigned to plugin skills by default; equal to a custom skill root. */
const DEFAULT_SKILL_RANK = 300

/** Agent Plugins loader configuration. */
export interface Config {
  /** Package directories, absolute or relative to the process working directory. */
  plugins?: string[]
  /**
   * Directory that receives one `PLUGIN_DATA` subtree per package. Defaults to
   * `<dsh home>/plugin-data`; the loader creates each subtree before registering
   * that package's stdio servers.
   */
  dataRoot?: string
  /** Rank used when a plugin skill collides with another provider's skill name. */
  skillRank?: number
}

/** Schemastery configuration for the Agent Plugins loader. */
export const Config: z<Config> = z.object({
  plugins: z.array(String).default([]),
  dataRoot: z.string(),
  skillRank: z.number().default(DEFAULT_SKILL_RANK),
})

/**
 * Load every configured package and publish its skills and MCP servers.
 * @param ctx - host context carrying `ctx.skills` and `ctx.mcpManager`.
 * @param config - package list, data root, and skill rank.
 * @throws when a configured package root is missing, escapes through a
 *   symlink, or carries an invalid v1 manifest.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const roots = (config.plugins ?? []).map(path => resolve(path))
  if (roots.length === 0) return
  const dataRoot = resolve(config.dataRoot ?? join(resolveDshHome(), 'plugin-data'))
  const sources: AgentPluginSkillSource[] = []
  const registered = new Set<string>()
  for (const root of roots) {
    const manifest = await loadManifest(root)
    const pluginDataRoot = join(dataRoot, manifest.name)
    sources.push({ root })
    const servers = await loadPluginMcpServers({ root, name: manifest.name, dataRoot: pluginDataRoot })
    if (servers.some(server => server.registration.transport === 'stdio')) await mkdir(pluginDataRoot, { recursive: true })
    for (const server of servers) {
      if (registered.has(server.serverName)) {
        ctx.logger.warn(`agent-plugins: server name "${server.serverName}" is already registered; the entry from package "${manifest.name}" is skipped.`)
        continue
      }
      registered.add(server.serverName)
      ctx.effect(
        () => ctx.mcpManager.register(server.serverName, server.registration),
        `agent-plugins.register("${server.serverName}")`,
      )
    }
  }
  ctx.skills.registerProvider(() => new AgentPluginSkillProvider(sources, config.skillRank ?? DEFAULT_SKILL_RANK))
}
