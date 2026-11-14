/**
 * Persistent project and user memory notes: `MEMORY.md` baseline context kept
 * current by re-reading on every pre-step.
 *
 * Notes enter the model-visible surface as `user/message` events with an
 * attribution-only `memory-notes` source, so the log rebuilds them exactly and
 * no session-format change is needed. User notes load from `<dsh home>/memory`,
 * project notes from the nearest directory holding a configured root marker;
 * user notes precede project notes under one shared `maxChars` budget.
 *
 * @module @deepseek-ai/dsh-memory-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Config, resolveConfig, userMemoryDirectory, type ResolvedConfig } from './config.ts'
import { registerMemoryWriteTool } from './write.ts'
import {
  discoverMemoryFiles,
  findProjectRoot,
  loadMemoryFiles,
  type LoadedMemoryFile,
} from './files.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Persistent memory notes this package maintains on the user's behalf.
     * Readers preserve the message without the producer.
     * @persistenceAttribution
     */
    'memory-notes': { kind: 'memory-notes' }
  }
}

export { Config }
export type { Config as MemoryNotesConfig } from './config.ts'
export {
  findProjectRoot,
  loadMemoryFiles,
  type LoadedMemoryFile,
  type MemoryFile,
  type MemoryLayer,
} from './files.ts'
export { resolveConfig } from './config.ts'
export { userMemoryDirectory } from './config.ts'

export const name = 'memory-notes'

/** Services required by memory note projection. */
export const inject = ['agents', 'workingDirectory']

/**
 * Narrow a user message to this package's memory note payload.
 * @param message - the user message to test.
 * @returns whether the message carries a `memory-notes` source.
 */
export function isMemoryNoteMessage(message: UserMessage): boolean {
  return message.source.kind === 'memory-notes'
}

function sameNotePayload(left: UserMessage, right: UserMessage): boolean {
  return isMemoryNoteMessage(left) && isMemoryNoteMessage(right)
    && isDeepStrictEqual(left.content, right.content)
}

/**
 * Render loaded memory files into the model-facing note text.
 * @param files - loaded files in injection order.
 * @returns the bounded note text.
 */
export function renderMemoryNote(files: readonly LoadedMemoryFile[]): string {
  const blocks = files.map((file) => {
    const layer = file.layer === 'user' ? 'USER' : 'PROJECT'
    return `--- BEGIN ${layer} MEMORY (${file.displayPath}) ---\n${file.content}\n--- END ${layer} MEMORY ---`
  })
  const body = blocks.join('\n\n')
  return `Persistent memory notes. Prefer these recorded facts over speculation.\n\n${body}`
}

/**
 * Compose the memory note message for one session context.
 * @param fs - the caller-scoped filesystem.
 * @param cwd - session working directory.
 * @param config - normalized settings.
 * @param signal - aborts discovery and reads.
 * @returns the note user message, or undefined when no memory exists.
 */
export async function loadMemoryNote(
  fs: FileSystem,
  cwd: string,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<UserMessage | undefined> {
  const root = await findProjectRoot(cwd, config.projectRootMarkers, fs, signal)
  const discovered = await discoverMemoryFiles(
    root, userMemoryDirectory(), config, cwd, fs, signal,
  )
  const loaded = await loadMemoryFiles(discovered, config.maxChars, fs, signal)
  if (loaded.length === 0) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: renderMemoryNote(loaded) }],
    source: { kind: 'memory-notes' },
  })
}

/**
 * Decorate one pre-step decision with the current memory note. Rejection
 * decisions pass through untouched; without memory files an existing note is
 * removed; a restated note is a no-op.
 * @param ctx - harness context carrying `fs` and `workingDirectory`.
 * @param agent - the agent entering the step.
 * @param decision - the downstream pre-step decision.
 * @param claimed - messages claimed for this step, anchoring the fold position.
 * @param config - normalized memory note settings.
 * @param signal - aborts memory discovery and reads.
 * @returns the decision with the note folded after the claimed batch.
 */
export async function applyPreStepMemory(
  ctx: Context,
  agent: Agent,
  decision: PreStepDecision,
  claimed: readonly UserMessage[],
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<PreStepDecision> {
  if (decision.kind === 'reject') return decision
  const fileSystem = ctx.get('fs')
  if (fileSystem === undefined) return decision
  signal.throwIfAborted()
  const cwd = await ctx.workingDirectory.ensure(agent, signal)
  const desired = await loadMemoryNote(fileSystem, cwd, config, signal)
  const hasExisting = decision.messages.some(isMemoryNoteMessage)
  if (desired === undefined) {
    if (!hasExisting) return decision
    return { ...decision, messages: decision.messages.filter(message => !isMemoryNoteMessage(message)) }
  }
  if (decision.messages.some(message => sameNotePayload(message, desired))) return decision
  const retained = decision.messages.filter(message => !isMemoryNoteMessage(message))
  // Fold the note right after the claimed batch, so the direct prompt
  // precedes it and driver-appended runtime context follows it.
  const lastClaimedIndex = retained.findLastIndex(message => claimed.includes(message))
  const entered = retained.toSpliced(lastClaimedIndex + 1, 0, desired)
  return { ...decision, messages: entered }
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  if (resolved.writeTool) registerMemoryWriteTool(ctx, resolved)
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    return applyPreStepMemory(ctx, agent, decision, messages, resolved, signal)
  })
}
