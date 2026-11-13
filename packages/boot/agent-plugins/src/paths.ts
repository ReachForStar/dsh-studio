/**
 * Path containment checks for Agent Plugins v1 package components. A plugin
 * package is untrusted input: any component path that resolves outside the
 * package root (directly or through a symlink) must be rejected before its
 * contents reach a skill catalog or an MCP registration.
 * @module @deepseek-ai/dsh-agent-plugins/paths
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

/**
 * Decide whether a resolved path stays inside a resolved root.
 * @param root - absolute path of the package root, already resolved.
 * @param target - absolute path of the component, already resolved.
 * @returns whether `target` is `root` or one of its descendants.
 */
export function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve both paths and refuse a component that escapes the package root.
 * @param root - package root as configured; it must exist.
 * @param target - component path; it must exist.
 * @returns the resolved component path.
 * @throws when either path cannot be resolved or the component escapes.
 */
export async function resolveContained(root: string, target: string): Promise<string> {
  const resolvedRoot = await realpath(root)
  const resolvedTarget = await realpath(target)
  if (!isContained(resolvedRoot, resolvedTarget)) {
    throw new Error(`Agent Plugins component "${target}" resolves outside the package root "${resolvedRoot}".`)
  }
  return resolvedTarget
}
/**
 * Resolve an optional component and treat every unusable outcome as absence.
 * A missing path, an unreadable path, and a path that escapes the package root
 * all mean the same thing for a component: it contributes nothing, and the
 * rest of the package stays usable.
 * @param root - package root; it must resolve.
 * @param target - component path inside the package.
 * @returns the resolved component path, or `undefined` when it is unusable.
 */
export async function resolveContainedOrUnusable(root: string, target: string): Promise<string | undefined> {
  const resolvedRoot = await realpath(root)
  const resolvedTarget = await realpath(target).catch(() => undefined)
  if (resolvedTarget === undefined) return undefined
  return isContained(resolvedRoot, resolvedTarget) ? resolvedTarget : undefined
}
