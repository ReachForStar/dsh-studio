/**
 * Agent Plugins v1 root manifest (`plugin.json`). The manifest is the only
 * package file that may declare the package identity; every other component is
 * resolved relative to the directory that holds it.
 * @module @deepseek-ai/dsh-agent-plugins/manifest
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resolveContained } from './paths.ts'

/** File name of the root manifest inside an Agent Plugins v1 package. */
export const PLUGIN_MANIFEST_FILE = 'plugin.json'

/** Canonical `$schema` value of an Agent Plugins v1 root manifest. */
export const PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/** Version assumed when the manifest omits `version`. */
const DEFAULT_PLUGIN_VERSION = '1.0.0'

/** Name rule from the v1 specification: lowercase, no leading, trailing, or doubled separators. */
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

const ManifestSchema = z.object({
  $schema: z.string(),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
})

/** Identity of one loaded Agent Plugins v1 package. */
export interface AgentPluginManifest {
  /** Package name from the manifest; it is also the MCP server-name prefix. */
  readonly name: string
  /** Package version, or `1.0.0` when the manifest omits it. */
  readonly version: string
  /** Optional one-line package description. */
  readonly description?: string
}

/**
 * Read and validate one package manifest.
 * @param pluginRoot - absolute package directory that holds `plugin.json`.
 * @returns the validated package identity.
 * @throws when the manifest is missing, escapes the root, is not JSON, is not
 *   an Agent Plugins v1 manifest, or carries an invalid name.
 */
export async function loadManifest(pluginRoot: string): Promise<AgentPluginManifest> {
  const manifestPath = await resolveContained(pluginRoot, join(pluginRoot, PLUGIN_MANIFEST_FILE))
  const parsed = ManifestSchema.safeParse(parseManifestJson(await readFile(manifestPath, 'utf8'), manifestPath))
  if (!parsed.success) {
    throw new Error(`Agent Plugins manifest "${manifestPath}" is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`)
  }
  if (parsed.data.$schema !== PLUGIN_MANIFEST_SCHEMA) {
    throw new Error(`Agent Plugins manifest "${manifestPath}" declares unsupported schema "${parsed.data.$schema}"; expected "${PLUGIN_MANIFEST_SCHEMA}".`)
  }
  const { name } = parsed.data
  if (!PLUGIN_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(`Agent Plugins manifest "${manifestPath}" carries an invalid name "${name}": use 1-64 lowercase letters, digits, dots, or hyphens without leading, trailing, or doubled separators.`)
  }
  const version = parsed.data.version?.trim()
  const description = parsed.data.description?.trim()
  return {
    name,
    version: version === undefined || version === '' ? DEFAULT_PLUGIN_VERSION : version,
    ...description === undefined || description === '' ? {} : { description },
  }
}

function parseManifestJson(raw: string, manifestPath: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Agent Plugins manifest "${manifestPath}" is not valid JSON: ${String(error)}`)
  }
}
