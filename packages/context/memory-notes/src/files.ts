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
 * @param query - current step text used to rank note entries; empty keeps file order.
 * @param recall - whether relevance ranking applies before the budget truncates.
 * @returns loaded files, later layers truncated when the budget runs out.
 */
export async function loadMemoryFiles(
  discovered: readonly DiscoveredMemoryFile[],
  maxChars: number,
  fs: FileSystem,
  signal: AbortSignal,
  query = '',
  recall = true,
): Promise<LoadedMemoryFile[]> {
  if (maxChars <= 0) return []
  const loaded: LoadedMemoryFile[] = []
  let remaining = maxChars
  for (const file of discovered) {
    signal.throwIfAborted()
    if (file.target === undefined) continue
    const content = await fs.readText(file.target, signal)
    if (content.length === 0) continue
    const { content: bounded, consumed } = recall
      ? selectMemoryContent(content, query, remaining)
      : boundMemoryContent(content, remaining)
    loaded.push({ layer: file.layer, absolutePath: file.absolutePath, displayPath: file.displayPath, content: bounded })
    remaining -= consumed
    if (remaining <= 0) break
  }
  return loaded
}

/** Query tokens that participate in recall ranking: at least three characters. */
function recallTokens(query: string): ReadonlySet<string> {
  return new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length >= 3))
}

/** One bullet and its continuation lines, in file order. */
interface MemoryEntry {
  readonly index: number
  readonly text: string
}

/** Split note bullets out of the file, keeping everything before the first bullet as the prefix. */
function splitEntries(content: string): { prefix: string; entries: MemoryEntry[] } {
  const lines = content.split('\n')
  const firstBullet = lines.findIndex(line => line.startsWith('- '))
  if (firstBullet < 0) return { prefix: content, entries: [] }
  const prefix = lines.slice(0, firstBullet).join('\n')
  const entries: MemoryEntry[] = []
  let current: string[] = []
  for (const line of lines.slice(firstBullet)) {
    if (line.startsWith('- ') && current.length > 0) {
      entries.push({ index: entries.length, text: current.join('\n') })
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) entries.push({ index: entries.length, text: current.join('\n') })
  return { prefix, entries }
}

/**
 * Select note content for one model step. Every bullet is scored by how many
 * distinct query tokens it contains, then the best entries fill the remaining
 * budget in their original order; the leading header survives when it fits.
 * Without bullets, or without query tokens, selection degrades to the plain
 * bounded read so a note never disappears just because nothing matched.
 * @param content - exact file text.
 * @param query - current step text, possibly empty.
 * @param budget - remaining allowed characters.
 * @returns the selected text and the characters it consumed.
 */
export function selectMemoryContent(content: string, query: string, budget: number): { content: string; consumed: number } {
  const tokens = recallTokens(query)
  if (tokens.size === 0) return boundMemoryContent(content, budget)
  const { prefix, entries } = splitEntries(content)
  if (entries.length === 0) return boundMemoryContent(content, budget)
  const scored = entries.map(entry => ({
    entry,
    score: [...recallTokens(entry.text)].filter(token => tokens.has(token)).length,
  }))
  scored.sort((left, right) => right.score - left.score || left.entry.index - right.entry.index)
  const selected: MemoryEntry[] = []
  let used = prefix.length === 0 ? 0 : prefix.length + 1
  for (const { entry } of scored) {
    const cost = (selected.length === 0 ? 0 : 1) + entry.text.length
    if (used + cost > budget) continue
    selected.push(entry)
    used += cost
  }
  if (selected.length === 0) return boundMemoryContent(content, budget)
  selected.sort((left, right) => left.index - right.index)
  const body = selected.map(entry => entry.text).join('\n')
  const text = prefix.length === 0 ? body : `${prefix}\n${body}`
  return { content: text, consumed: text.length }
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
