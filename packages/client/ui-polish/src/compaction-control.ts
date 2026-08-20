// Automatic compaction control: lets the user pick the context-pressure ratio
// at which the session's compaction backend compacts, instead of the harness
// default (0.8). The Web composition mounts compaction-basic inside the agent
// preset's isolated realm, so this host-side plugin cannot reconfigure that
// instance — instead it intercepts `agent/pre-step`, and when the configured
// ratio is below the harness default it measures pressure and asks the
// agent's own compaction service to compact first. At ratios at or above the
// harness default this is a no-op (the built-in automatic listener owns it).

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agentPresets Context merge (ctx.agentPresets).
import type {} from '@deepseek-ai/dsh-agent-presets'
// Type-only: pulls the llm Context merge (ctx.llm).
import type {} from '@deepseek-ai/dsh-llm'
// Type-only: pulls the tokenMeter Context merge (ctx.tokenMeter).
import type {} from '@deepseek-ai/dsh-token-meter'
// Type-only: pulls the compaction Context merge (ctx.compaction) so the
// agent-addressed service face typechecks.
import type {} from '@deepseek-ai/dsh-compaction'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { PolishSettings } from './background-settings.ts'

/** The harness default automatic threshold (compaction-basic DEFAULT_THRESHOLD_RATIO). */
const HARNESS_DEFAULT_RATIO = 0.8

/** Error while resolving the model's context capacity: not compacts. */
class PressureUnavailableError extends Error {}

/**
 * The user-chosen ratio read from the settings scope, or undefined when not set.
 * @param scope - the ui-polish settings scope (already bound by the caller).
 * @returns the ratio when configured, else undefined (harness default applies).
 */
export function configuredRatio(scope: SettingsScope<PolishSettings>): number | undefined {
  const value = scope.get().compactionThresholdRatio
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Measure one agent session's current pressure ratio (totalTokens / contextWindow).
 * @param ctx - host context with llm + tokenMeter services.
 * @param agent - the agent whose session to measure.
 * @returns the pressure ratio, or undefined when the model capacity is unknown.
 */
async function pressureRatioOf(ctx: Context, agent: Agent): Promise<number | undefined> {
  const session = agent.session
  const target = { provider: agent.options.provider ?? '', model: agent.options.model ?? '' }
  if (target.provider === '' || target.model === '') return undefined
  try {
    const info = await ctx.llm.resolveModelInfo(target.provider, target.model, new AbortController().signal)
    const window = info.context?.contextWindow
    if (typeof window !== 'number' || window <= 0) throw new PressureUnavailableError('no contextWindow')
    const measurement = ctx.tokenMeter.measure(session)
    return measurement.totalTokens / window
  } catch {
    return undefined
  }
}

/**
 * Install the configurable automatic-compaction listener. It fires before the
 * harness's own pre-step listener (this plugin registers at app start, before
 * preset mounts) and only when the user's ratio is strictly below the harness
 * default, so it can never double-compact with the built-in 0.8 listener.
 * @param ctx - host context with settings, agentPresets, llm, tokenMeter.
 * @param scope - the ui-polish settings scope (bound by the caller).
 */
export function installCompactionControl(
  ctx: Context,
  scope: SettingsScope<PolishSettings>,
): void {
  const disposePreStep = ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ) => {
    const ratio = configuredRatio(scope)
    if (ratio === undefined || ratio >= HARNESS_DEFAULT_RATIO) return next()
    if (signal.aborted) return next()
    try {
      const pressure = await pressureRatioOf(ctx, agent)
      if (pressure === undefined || pressure < ratio) return await next()
      // The agent's preset mounts compaction inside its isolated realm; reach
      // that instance through the roster's agent-addressed service face.
      const compaction = ctx.agentPresets.serviceFor(agent, 'compaction')
      if (compaction === undefined) return await next()
      await compaction.compactNow(agent, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`ui-polish auto-compaction failed: ${message}; continuing the turn`)
    }
    return next()
  })

  ctx.effect(() => () => { disposePreStep() }, 'ui-polish: compaction control dispose')
}
