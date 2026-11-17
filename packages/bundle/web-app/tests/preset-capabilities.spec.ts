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

/** Plugin rows of one shipped agent preset. */
function presetPlugins(preset: string): { id: string; name: string }[] {
  const [row] = loadOverlayPatches(preset, fileURLToPath(new URL(`../presets/${preset}.patch.yml`, import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
  return (row!.config as { plugins: { id: string; name: string }[] }).plugins
}

it.each(['standard', 'xingchen-qiming'])('mounts the adopted agent-layer capabilities in %s', (preset) => {
  const plugins = presetPlugins(preset)
  for (const [id, name] of DEFAULT_CAPABILITIES) {
    expect(plugins.filter(row => row.id === id), `${preset} row ${id}`).toEqual([{ id, name }])
  }
})
