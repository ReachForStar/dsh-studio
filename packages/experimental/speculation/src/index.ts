/**
 * Speculation gate and overlay path planning.
 *
 * Speculative execution runs work ahead of the user's input. It is safe only
 * when every tool call is either read-only or redirected into an overlay, and
 * when writes never reach the workspace without the user's consent. This module
 * owns that decision as pure logic; a speculation runner supplies the tool
 * classification, the workspace root, and the overlay root.
 *
 * @module @deepseek-ai/dsh-speculation
 */

import z from '@deepseek-ai/schemastery'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** What one speculative tool call may do. */
export type SpeculationAction = 'allow' | 'redirect' | 'boundary'

/** Outcome of gating one speculative tool call. */
export interface SpeculationDecision {
  /** Effect on the speculative run. */
  action: SpeculationAction
  /** Tool name the decision applies to. */
  tool: string
  /** Filesystem argument key whose value the runner must rewrite, when redirecting. */
  redirectKey?: string
  /** Overlay path the argument must be rewritten to, when redirecting. */
  redirectPath?: string
  /** Machine-readable reason for a boundary or redirect decision. */
  reason?: string
}

/** Speculation policy configuration. */
export interface Config {
  /** Absolute workspace root whose files the overlay mirrors. */
  workspaceRoot: string
  /** Absolute overlay root that receives speculative writes. */
  overlayRoot: string
  /**
   * Whether write tools may be redirected into the overlay. When false, every
   * write tool stops speculation; callers expose this only after the user
   * opted into unattended edits.
   */
  allowWrites: boolean
  /** Tool names that never modify state; empty means the built-in set applies. */
  readOnlyTools?: string[]
  /** Tool names that write files; empty means the built-in set applies. */
  writeTools?: string[]
  /** Argument keys carrying a filesystem path. */
  pathArgumentKeys?: string[]
}

export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(),
  overlayRoot: z.string().required(),
  allowWrites: z.boolean().default(false),
  readOnlyTools: z.array(z.string()),
  writeTools: z.array(z.string()),
  pathArgumentKeys: z.array(z.string()),
})

/** Built-in read-only tool names of the default tool set. */
export const DEFAULT_READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'lsp'] as const

/** Built-in file-writing tool names of the default tool set. */
export const DEFAULT_WRITE_TOOLS = ['write', 'edit'] as const

/** Built-in argument keys that carry a filesystem path. */
export const DEFAULT_PATH_ARGUMENT_KEYS = ['file_path', 'path', 'directory'] as const

/** Tools that always stop speculation, even when a caller allows writes. */
export const BOUNDARY_TOOLS: readonly string[] = [
  'agent',
  'task',
  'skill',
  'todo_write',
  'ask_user_question',
  'web_fetch',
  'web_search',
]

/**
 * Resolve the effective policy lists, replacing empty overrides with defaults.
 * @param config - user configuration.
 * @returns normalized tool and path-key lists.
 */
export function resolvePolicy(config: Config): {
  readOnlyTools: readonly string[]
  writeTools: readonly string[]
  pathArgumentKeys: readonly string[]
} {
  return {
    readOnlyTools: config.readOnlyTools === undefined || config.readOnlyTools.length === 0
      ? DEFAULT_READ_ONLY_TOOLS
      : config.readOnlyTools,
    writeTools: config.writeTools === undefined || config.writeTools.length === 0
      ? DEFAULT_WRITE_TOOLS
      : config.writeTools,
    pathArgumentKeys: config.pathArgumentKeys === undefined || config.pathArgumentKeys.length === 0
      ? DEFAULT_PATH_ARGUMENT_KEYS
      : config.pathArgumentKeys,
  }
}

/**
 * Map one workspace path into the overlay without leaving it.
 * @param workspaceRoot - absolute workspace root.
 * @param overlayRoot - absolute overlay root.
 * @param path - path as written by the model, absolute or relative to the workspace.
 * @returns the overlay path, or undefined when the path escapes the workspace.
 */
export function overlayPath(
  workspaceRoot: string,
  overlayRoot: string,
  path: string,
): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
  const suffix = relative(resolve(workspaceRoot), absolute)
  if (suffix.length === 0) return resolve(overlayRoot)
  if (suffix.startsWith('..') || isAbsolute(suffix)) return undefined
  return join(resolve(overlayRoot), suffix)
}

/**
 * Gate one speculative tool call.
 *
 * Read-only tools are allowed unchanged, file writers redirect into the overlay
 * only when the policy allows writes, and everything else stops speculation.
 * @param tool - tool name the model asked for.
 * @param args - tool call arguments as parsed from the model.
 * @param config - speculation policy.
 * @returns the decision, including the rewrite target when redirecting.
 */
export function gateToolCall(
  tool: string,
  args: Record<string, unknown>,
  config: Config,
): SpeculationDecision {
  const policy = resolvePolicy(config)
  if (policy.readOnlyTools.includes(tool)) return { action: 'allow', tool }
  if (policy.writeTools.includes(tool)) {
    if (!config.allowWrites) return { action: 'boundary', tool, reason: `write_not_allowed:${tool}` }
    const redirect = redirectTarget(args, policy.pathArgumentKeys, config)
    if (redirect === undefined) return { action: 'boundary', tool, reason: `path_outside_workspace:${tool}` }
    return { action: 'redirect', tool, reason: `write_redirected:${tool}`, ...redirect }
  }
  return { action: 'boundary', tool, reason: `unsupported_tool:${tool}` }
}

/**
 * Find the path argument a redirect must rewrite.
 * @param args - tool call arguments.
 * @param keys - argument keys that may carry a path.
 * @param config - speculation policy providing both roots.
 * @returns the key and overlay path, or undefined when no path is contained.
 */
function redirectTarget(
  args: Record<string, unknown>,
  keys: readonly string[],
  config: Config,
): { redirectKey: string; redirectPath: string } | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    const mapped = overlayPath(config.workspaceRoot, config.overlayRoot, value.trim())
    if (mapped === undefined) return undefined
    return { redirectKey: key, redirectPath: mapped }
  }
  return undefined
}

/**
 * Apply a redirect decision to a tool call's arguments.
 * @param args - arguments to mutate; the original object is left unchanged.
 * @param decision - decision returned by {@link gateToolCall}.
 * @returns the arguments with the redirected key, or the original copy for other actions.
 */
export function rewriteArguments(
  args: Record<string, unknown>,
  decision: SpeculationDecision,
): Record<string, unknown> {
  if (decision.action !== 'redirect') return { ...args }
  if (decision.redirectKey === undefined || decision.redirectPath === undefined) return { ...args }
  return { ...args, [decision.redirectKey]: decision.redirectPath }
}

/** One tool call a speculative run proposed. */
export interface SpeculationStep {
  /** Tool name. */
  tool: string
  /** Parsed arguments. */
  args: Record<string, unknown>
}

/**
 * Gate a whole speculative plan, stopping at the first boundary.
 * @param steps - proposed calls in model order.
 * @param config - speculation policy.
 * @returns the decisions that may run, in order, plus the boundary that stopped the plan.
 */
export function gatePlan(
  steps: readonly SpeculationStep[],
  config: Config,
): { allowed: { step: SpeculationStep; decision: SpeculationDecision }[]; stopped?: SpeculationDecision } {
  const allowed: { step: SpeculationStep; decision: SpeculationDecision }[] = []
  for (const step of steps) {
    const decision = gateToolCall(step.tool, step.args, config)
    if (decision.action === 'boundary') return { allowed, stopped: decision }
    allowed.push({ step, decision })
  }
  return { allowed }
}
