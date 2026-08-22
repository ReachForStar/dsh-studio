// Automatic compaction control: lets the user pick the context-pressure ratio
// at which the session's compaction backend compacts, instead of the harness
// default (0.8). The Web composition mounts compaction-basic inside the agent
// preset's isolated realm, so this host-side plugin cannot reconfigure that
// instance — instead it intercepts `agent/pre-step` and asks the agent's own
// compaction service to compact with the user's ratio as a per-call threshold
// override on the mid-turn-safe `compactIfNeeded` pressure path, which owns
// range selection, retention, and retry. That path never touches the
// idle-session maintenance machinery manual `/compact` uses, so it cannot
// block it. At ratios at or above the harness default this is a no-op (the
// built-in automatic listener owns it).

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agent event declarations (agent/pre-step) into scope.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agentPresets Context merge (ctx.agentPresets).
import type {} from '@deepseek-ai/dsh-agent-presets'
// Type-only: pulls the compaction Context merge (ctx.compaction) so the
// agent-addressed service face typechecks.
import type {} from '@deepseek-ai/dsh-compaction'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { PolishSettings } from './background-settings.ts'

/** The harness default automatic threshold (compaction-basic DEFAULT_THRESHOLD_RATIO). */
const HARNESS_DEFAULT_RATIO = 0.8

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
 * Install the configurable automatic-compaction listener. It fires before the
 * harness's own pre-step listener (this plugin registers at app start, before
 * preset mounts) and only when the user's ratio is strictly below the harness
 * default, so it can never double-compact with the built-in 0.8 listener: the
 * pressure trigger with a per-call threshold override compacts until pressure
 * sits below the user's ratio, and the built-in listener then measures below
 * its own 0.8 bar.
 * @param ctx - host context with settings and agentPresets.
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
      // The agent's preset mounts compaction inside its isolated realm; reach
      // that instance through the roster's agent-addressed service face.
      const compaction = ctx.agentPresets.serviceFor(agent, 'compaction')
      if (compaction === undefined) return await next()
      await compaction.compactIfNeeded(agent, 'pressure', signal, { thresholdRatio: ratio })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`ui-polish auto-compaction failed: ${message}; continuing the turn`)
    }
    return next()
  })

  ctx.effect(() => () => { disposePreStep() }, 'ui-polish: compaction control dispose')
}
