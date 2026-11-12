/**
 * Overlay filesystem proxy for speculative execution.
 *
 * Reads prefer overlay copies; writes always land in the overlay, so a
 * speculative run never mutates the workspace. `commit` copies overlay content
 * back into the workspace after the user accepts, and `discard` drops it.
 *
 * @module @deepseek-ai/dsh-speculation/overlay
 */

import { Context } from '@deepseek-ai/cordis'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/** Arguments for one overlay proxy. */
export interface OverlayOptions {
  /** Provider serving both the workspace and the overlay directory. */
  base: FileSystem
  /** Absolute workspace root the overlay mirrors. */
  workspaceRoot: string
  /** Absolute overlay root that receives speculative writes. */
  overlayRoot: string
  /** Context this proxy registers against; it is separate from the product context. */
  ctx: Context
}

/**
 * A filesystem that redirects writes into a mirror directory.
 *
 * Targets handed to the base provider always name real absolute paths: reads
 * probe `<overlayRoot>/<relative>` first, writes use it unconditionally.
 */
export class OverlayFileSystem extends FileSystem {
  readonly #base: FileSystem
  readonly #workspaceRoot: string
  readonly #overlayRoot: string
  /** Paths rewritten since construction, overlay-relative, for commit reporting. */
  readonly written = new Set<string>()

  /**
   * Build one overlay proxy.
   * @param options - provider, roots, and registration context.
   */
  constructor(options: OverlayOptions) {
    super(options.ctx)
    this.#base = options.base
    this.#workspaceRoot = options.workspaceRoot
    this.#overlayRoot = options.overlayRoot
  }

  /** Overlay path mirroring one workspace path, or undefined outside the workspace. */
  #overlayFor(target: FsTarget): string | undefined {
    const absolute = this.#base.processPath(target)
    const prefix = `${this.#workspaceRoot.replace(/\/+$/u, '')}/`
    if (absolute === this.#workspaceRoot) return this.#overlayRoot
    if (!absolute.startsWith(prefix)) return undefined
    return `${this.#overlayRoot}/${absolute.slice(prefix.length)}`
  }

  /** Workspace path mirroring one recorded overlay path; only recorded paths are passed. */
  #workspaceForOverlay(absolute: string): string {
    return `${this.#workspaceRoot}/${absolute.slice(this.#overlayRoot.length + 1)}`
  }

  async #overlayTarget(target: FsTarget): Promise<FsTarget | undefined> {
    const overlay = this.#overlayFor(target)
    if (overlay === undefined) return undefined
    return this.#base.resolve(overlay)
  }

  async #readTarget(target: FsTarget, signal?: AbortSignal): Promise<FsTarget> {
    const overlay = await this.#overlayTarget(target)
    if (overlay !== undefined && await this.#base.stat(overlay, signal) !== undefined) return overlay
    return target
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.#base.resolve(path, opts)
  }

  override processPath(target: FsTarget): string {
    return this.#base.processPath(target)
  }

  override fileUrl(target: FsTarget): string {
    return this.#base.fileUrl(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return this.#base.contains(parent, child)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.#base.stat(await this.#readTarget(target, signal), signal)
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    const target = await this.#base.resolve(path, { ...opts, ...signal === undefined ? {} : { signal } })
    return this.#base.lstat(this.#base.processPath(await this.#readTarget(target, signal)), opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.#base.readText(await this.#readTarget(target, signal), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.#base.streamText(await this.#readTarget(target, signal), signal)
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    return this.#base.readBytes(await this.#readTarget(target, signal), signal, maxBytes)
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#base.readByteRange(await this.#readTarget(target, signal), range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.#base.listDir(await this.#readTarget(target, signal), signal)
  }

  async #writeTarget(target: FsTarget): Promise<FsTarget> {
    const overlay = await this.#overlayTarget(target)
    if (overlay === undefined) throw new Error(`speculation overlay: path outside workspace: ${this.#base.processPath(target)}`)
    this.written.add(this.#base.processPath(overlay))
    return overlay
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
  ): Promise<FsWriteOutcome> {
    return this.#base.writeText(await this.#writeTarget(target), content, expected)
  }

  override async editText(target: FsTarget, edit: FsEditRequest): Promise<FsEditOutcome> {
    return this.#base.editText(await this.#writeTarget(target), edit)
  }

  override async patchText(
    target: FsTarget,
    hunks: Parameters<FileSystem['patchText']>[1],
    expected?: Parameters<FileSystem['patchText']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: Parameters<FileSystem['patchText']>[4],
  ): ReturnType<FileSystem['patchText']> {
    return this.#base.patchText(await this.#writeTarget(target), hunks, expected, signal, sandboxPolicy)
  }

  override async deleteFile(
    target: FsTarget,
    expected?: Parameters<FileSystem['deleteFile']>[1],
    signal?: AbortSignal,
    sandboxPolicy?: Parameters<FileSystem['deleteFile']>[3],
  ): ReturnType<FileSystem['deleteFile']> {
    return this.#base.deleteFile(await this.#writeTarget(target), expected, signal, sandboxPolicy)
  }

  override async remove(
    path: string,
    opts?: Parameters<FileSystem['remove']>[1],
    signal?: AbortSignal,
    sandboxPolicy?: Parameters<FileSystem['remove']>[3],
  ): ReturnType<FileSystem['remove']> {
    const target = await this.#writeTarget(await this.#base.resolve(path, signal === undefined ? {} : { signal }))
    return this.#base.remove(this.#base.processPath(target), opts, signal, sandboxPolicy)
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options?: Parameters<FileSystem['moveFile']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: Parameters<FileSystem['moveFile']>[4],
  ): ReturnType<FileSystem['moveFile']> {
    const resolvedSource = await this.#writeTarget(source)
    const resolvedDestination = await this.#writeTarget(destination)
    return this.#base.moveFile(resolvedSource, resolvedDestination, options ?? {}, signal, sandboxPolicy)
  }

  /**
   * Copy every produced overlay file back into the workspace.
   * @param signal - aborts the commit between files.
   * @returns workspace paths written by the commit, in overlay order.
   */
  async commit(signal?: AbortSignal): Promise<string[]> {
    const written: string[] = []
    for (const overlayAbsolute of [...this.written]) {
      signal?.throwIfAborted()
      const workspaceAbsolute = this.#workspaceForOverlay(overlayAbsolute)
      const overlayTarget = await this.#base.resolve(overlayAbsolute)
      if (await this.#base.stat(overlayTarget, signal) === undefined) continue
      const content = await this.#base.readText(overlayTarget, signal)
      await this.#base.writeText(await this.#base.resolve(workspaceAbsolute), content)
      written.push(workspaceAbsolute)
    }
    return written
  }

  /**
   * Drop every produced overlay file, leaving the workspace untouched.
   * @param signal - aborts the discard between files.
   * @returns overlay paths removed.
   */
  async discard(signal?: AbortSignal): Promise<string[]> {
    const removed: string[] = []
    for (const overlayAbsolute of [...this.written]) {
      signal?.throwIfAborted()
      const overlayTarget = await this.#base.resolve(overlayAbsolute)
      if (await this.#base.stat(overlayTarget, signal) === undefined) continue
      await this.#base.remove(this.#base.processPath(overlayTarget))
      removed.push(overlayAbsolute)
    }
    this.written.clear()
    return removed
  }
}
