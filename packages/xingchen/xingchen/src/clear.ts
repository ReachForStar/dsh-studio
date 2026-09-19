/**
 * Human-facing `/clear` command: clears the session context through a full
 * compaction (the session log is append-only, so clearing means compressing
 * the history into a summary the model keeps).
 *
 * Mounted inside a preset's compaction group: the compaction service is
 * entry-local there, and only a row sharing that realm can resolve it.
 *
 * @module @reachforstar/dsh-xingchen/clear
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-compaction'

export const name = 'xingchen-clear'
export const inject = ['commands', 'compaction']

const USAGE = 'Usage: /clear (no arguments)'

/** Run one full compaction and report the cleared amount. */
async function executeClear(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  if (invocation.rawInput.trim() !== '') return { kind: 'error', text: USAGE }
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: '暂无可清理的上下文。' }
    return {
      kind: 'success',
      text: `上下文已清理：${result.shadowedSeqs.length} 条历史被压缩为摘要（约 ${result.shadowedTokenCount} tokens）。`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: '清理已取消。' }
    if (error instanceof ManualCompactionError) {
      return { kind: 'error', text: `上下文清理失败（${error.code}）；该轮尝试已记录在会话日志中。` }
    }
    throw error
  }
}

/**
 * Register `/clear` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeClear(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: brandString<CommandDefinitionId>('@reachforstar/dsh-xingchen/clear'),
      name: 'clear',
      description: '清理上下文（将历史压缩为摘要）',
      handler,
    })
  }, 'xingchen-clear lifecycle')
}
