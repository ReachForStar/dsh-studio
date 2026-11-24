/**
 * Opt-in Linux integration: the exported bundle patch loads the real Cua Driver
 * SDK provider, registers its tools, and tears down. It captures no screenshot,
 * delivers no input, and requests no permissions.
 */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader, { interpolate, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type {} from '@deepseek-ai/dsh-computer-use'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'linux' || process.env.DSH_CUA_LINUX_E2E !== '1')(
  'mounts the exported Linux provider and exposes the Cua Driver tools',
  { retry: 0 },
  async () => {
    const patch = parseEntryYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { insert: EntryOptions[] }[]
    const ctx = new Context()
    await ctx.plugin(Loader)
    if (!ctx.loader.internal) throw new Error('Loader module importer is unavailable')
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      for (const row of patch[0]!.insert) {
        await ctx.loader.create({ ...row, disabled: Boolean(interpolate({ process: { platform: process.platform } }, row.disabled)) })
      }
      await ctx.loader.await()
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
      const names = ctx.tools.schemas().map(tool => tool.name)
      expect(names).toContain('cua_driver_native__get_screen_size')
      expect(names.every(name => name.startsWith('cua_driver_native__'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  },
)
