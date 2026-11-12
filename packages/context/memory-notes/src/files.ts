/**
 * Memory file discovery and bounded, abort-aware provider reads.
 *
 * @module @deepseek-ai/dsh-memory-notes/files
 */

import { basename, dirname, relative, resolve } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ResolvedConfig } from './config.ts'

/** One layer of memory notes; user notes precede project notes in the injection. */
export type MemoryLayer = 'user' | 'project'

/** A memory file identified by absolute and model-facing paths. */
export interface MemoryFile {
  /** Layer owning the file: user-global or project root. */
  layer: MemoryLayer
  /** Absolute path on the host. */
  absolutePath: string
  /** Model-facing path, relative to the session cwd when possible. */
  displayPath: string
}

/** A memory file whose UTF-8 content was read successfully. */
export interface LoadedMemoryFile extends MemoryFile {
  content: string
}

interface DiscoveredMemoryFile extends MemoryFile {
  target?: FsTarget
}

/**
 * Walk upward from `cwd` until a directory holds one of `markers`.
 * @param cwd - absolute session working directory.
 * @param markers - directory entries that identify the project root.
 * @param fs - the caller-scoped filesystem.
 * @param signal - aborts the probe.
 * @returns the absolute project root, or undefined when none is found.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fs: FileSystem,
  signal: AbortSignal,
): Promise<string | undefined> {
  let current = resolve(cwd)
  for (;;) {
    signal.throwIfAborted()
    for (const marker of markers) {
      const target = await fs.resolve(marker, { cwd: current, signal })
      if (await fs.stat(target, signal) !== undefined) return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Probe one candidate file in priority order within a directory; the first
 * existing candidate wins, so an overlay name shadows its base sibling.
 * @param directory - directory to probe.
 * @param names - candidate basenames in priority order.
 * @param layer - owning memory layer.
 * @param fs - the caller-scoped filesystem.
 * @param signal - aborts the probe.
 * @returns the discovered file, or undefined when no candidate exists.
 */
async function discoverFirst(
  directory: string,
  names: readonly string[],
  layer: MemoryLayer,
  fs: FileSystem,
  signal: AbortSignal,
): Promise<DiscoveredMemoryFile | undefined> {
  for (const name of names) {
    signal.throwIfAborted()
    const target = await fs.resolve(name, { cwd: directory, signal })
    if (await fs.stat(target, signal) === undefined) continue
    return {
      layer,
      absolutePath: resolve(directory, name),
      displayPath: name,
      target,
    }
  }
  return undefined
}

/**
 * Discover memory candidates for the project layer (workspace root) and the
 * user layer (`<dsh home>/memory`).
 * @param root - resolved project root; undefined disables the project layer.
 * @param userDirectory - user memory directory; undefined disables the user layer.
 * @param config - normalized settings.
 * @param cwd - session working directory for display paths.
 * @param fs - the caller-scoped filesystem.
 * @param signal - aborts the probes.
 * @returns discovered files in injection order (user first, then project).
 */
export async function discoverMemoryFiles(
  root: string | undefined,
  userDirectory: string | undefined,
  config: ResolvedConfig,
  cwd: string,
  fs: FileSystem,
  signal: AbortSignal,
): Promise<DiscoveredMemoryFile[]> {
  const found: DiscoveredMemoryFile[] = []
  if (userDirectory !== undefined) {
    const userFile = await discoverFirst(userDirectory, config.memoryFileNames, 'user', fs, signal)
    if (userFile !== undefined) found.push(userFile)
  }
  if (root !== undefined) {
    const projectFile = await discoverFirst(root, config.memoryFileNames, 'project', fs, signal)
    if (projectFile !== undefined) {
      const display = relative(cwd, projectFile.absolutePath)
      found.push({ ...projectFile, displayPath: display.length > 0 ? display : basename(projectFile.absolutePath) })
    }
  }
  return found
}

/**
 * Read discovered memory files under the shared character budget.
 * @param discovered - files from {@link discoverMemoryFiles}.
 * @param maxChars - total text cap; non-positive reads nothing.
 * @param fs - the caller-scoped filesystem.
 * @param signal - aborts the reads.
 * @returns loaded files, later layers truncated when the budget runs out.
 */
export async function loadMemoryFiles(
  discovered: readonly DiscoveredMemoryFile[],
  maxChars: number,
  fs: FileSystem,
  signal: AbortSignal,
): Promise<LoadedMemoryFile[]> {
  if (maxChars <= 0) return []
  const loaded: LoadedMemoryFile[] = []
  let remaining = maxChars
  for (const file of discovered) {
    signal.throwIfAborted()
    if (file.target === undefined) continue
    const content = await fs.readText(file.target, signal)
    if (content.length === 0) continue
    const { content: bounded, consumed } = boundMemoryContent(content, remaining)
    loaded.push({ layer: file.layer, absolutePath: file.absolutePath, displayPath: file.displayPath, content: bounded })
    remaining -= consumed
    if (remaining <= 0) break
  }
  return loaded
}

/**
 * Trim content to a character budget, marking any surplus.
 * @param content - exact file text.
 * @param budget - remaining allowed characters.
 * @returns the bounded text and the characters it consumed.
 */
export function boundMemoryContent(content: string, budget: number): { content: string; consumed: number } {
  if (content.length <= budget) return { content, consumed: content.length }
  const tail = '\n…(truncated)'
  const slice = content.slice(0, Math.max(0, budget - tail.length))
  const bounded = slice + tail
  return { content: bounded, consumed: bounded.length }
}
