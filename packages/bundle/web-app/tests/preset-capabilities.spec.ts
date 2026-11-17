/** Shipped agent presets carry the adopted agent-layer capabilities in the default preset. */

import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

/** The capabilities adopted from qwen-code that a default session must mount. */
const DEFAULT_CAPABILITIES = [
  ['tool-search', '@deepseek-ai/dsh-tool-search'],
  ['memory-notes', '@deepseek-ai/dsh-memory-notes'],
  ['tool-summary', '@deepseek-ai/dsh-step-summary'],
  ['followup', '@deepseek-ai/dsh-followup'],
] as const

/** Non-xingchen capability rows the star-domain preset carries over the default one. */
const EXTRA_CAPABILITIES = [
  ['tool-ssh', '@reachforstar/dsh-tool-ssh'],
  ['tool-subagent-codex', '@deepseek-ai/dsh-tool-subagent'],
  ['tool-subagent-claude-code', '@deepseek-ai/dsh-tool-subagent'],
] as const

/** Plugin rows of one shipped agent preset, including rows nested in `cordis:group` realms. */
function presetPlugins(preset: string): { id: string; name: string; disabled?: boolean }[] {
  const [row] = loadOverlayPatches(preset, fileURLToPath(new URL(`../presets/${preset}.patch.yml`, import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  type PluginRow = { id: string; name: string; disabled?: boolean; group?: boolean; config?: unknown }
  const plugins = (row!.config as { plugins: PluginRow[] }).plugins
  return plugins.flatMap(plugin => plugin.group === true && Array.isArray(plugin.config)
    ? (plugin.config as { id: string; name: string; disabled?: boolean }[])
    : [plugin])
}

it.each(['standard', 'xingchen-qiming'])('mounts the adopted agent-layer capabilities in %s', (preset) => {
  const plugins = presetPlugins(preset)
  for (const [id, name] of DEFAULT_CAPABILITIES) {
    expect(plugins.filter(row => row.id === id), `${preset} row ${id}`).toEqual([{ id, name }])
  }
})

it('mounts every non-xingchen capability in the default preset', () => {
  const plugins = presetPlugins('standard')
  for (const [id, name] of EXTRA_CAPABILITIES) {
    expect(plugins.filter(row => row.id === id).map(row => ({ id: row.id, name: row.name })), `standard row ${id}`)
      .toEqual([{ id, name }])
  }
  // The external provider seats load a provider package that is not part of the
  // default product, so they stay off until a profile override enables them.
  const disabled = (id: string) => presetPlugins('standard').find(row => row.id === id)?.disabled === true
  expect(disabled('tool-subagent-codex')).toBe(true)
  expect(disabled('tool-subagent-claude-code')).toBe(true)
  expect(presetPlugins('standard').find(row => row.id === 'tool-ssh')?.disabled).toBeUndefined()
})

it('keeps the star-domain rows out of the default preset', () => {
  const ids = presetPlugins('standard').map(row => row.id)
  for (const id of ['xingchen', 'xingchen-router', 'skill-xingchen', 'command-xingchen-clear']) {
    expect(ids, id).not.toContain(id)
  }
})
