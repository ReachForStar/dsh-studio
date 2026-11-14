/**
 * Memory note configuration and normalized discovery settings.
 *
 * @module @deepseek-ai/dsh-memory-notes/config
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_MEMORY_FILE_NAMES = ['MEMORY.md'] as const
const DEFAULT_MAX_CHARS = 20_000

/** User-facing memory note configuration. */
export interface Config {
  /** Directory entries that identify the project root while walking upward from the current working directory. */
  projectRootMarkers?: string[]
  /** File names, in priority order, loaded from the user memory directory and the project root. */
  memoryFileNames?: string[]
  /**
   * Hard cap, in text characters, on the complete injected note. Larger notes
   * are truncated with a marker; non-positive disables injection.
   */
  maxChars?: number
  /** Character cap for one `memory_write` note. Defaults to 4000. */
  maxWriteChars?: number
  /** Register the `memory_write` tool. Defaults to `true`; requires `tools` and `fs`. */
  writeTool?: boolean
  /**
   * Rank note entries by overlap with the current step and fill the character
   * budget with the best matches before the rest. Defaults to `true`; `false`
   * injects entries in file order and truncates the tail.
   */
  recall?: boolean
  /**
   * Age in milliseconds after which a local `MEMORY.md.lock` is treated as
   * abandoned and reclaimed. Defaults to ten minutes.
   */
  lockStaleMs?: number
}

/** User-facing memory note configuration. */
export const Config: z<Config> = z.object({
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  memoryFileNames: z.array(z.string()).default([...DEFAULT_MEMORY_FILE_NAMES]),
  maxChars: z.number().min(0).default(DEFAULT_MAX_CHARS),
  maxWriteChars: z.number().min(1).default(4000),
  writeTool: z.boolean().default(true),
  recall: z.boolean().default(true),
  lockStaleMs: z.number().min(0).default(10 * 60 * 1000),
})

/** Normalized settings used by discovery and injection. */
export interface ResolvedConfig {
  projectRootMarkers: readonly string[]
  memoryFileNames: readonly string[]
  maxChars: number
  maxWriteChars: number
  writeTool: boolean
  recall: boolean
  lockStaleMs: number
}

/**
 * Normalize plugin configuration to its effective values.
 * @param config - user-facing configuration, or undefined.
 * @returns the effective settings with defaults applied.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  return {
    projectRootMarkers: config?.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
    memoryFileNames: config?.memoryFileNames ?? DEFAULT_MEMORY_FILE_NAMES,
    maxChars: config?.maxChars ?? DEFAULT_MAX_CHARS,
    maxWriteChars: config?.maxWriteChars ?? 4000,
    writeTool: config?.writeTool ?? true,
    recall: config?.recall ?? true,
    lockStaleMs: config?.lockStaleMs ?? 10 * 60 * 1000,
  }
}

/**
 * Resolve the user memory directory for one mount.
 * @returns `<dsh home>/memory`.
 */
export function userMemoryDirectory(): string {
  return join(resolveDshHome(), 'memory')
}
