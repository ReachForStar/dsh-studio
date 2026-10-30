/** Exact, directional exceptions to the shipped SDK/Desktop capability comparison. */
export type ToolMode = 'standard' | 'ptc'

interface Exception {
  tool: string
  side: 'sdk' | 'desktop'
  reason: string
}

/** The fork's canvas tools ride the graphical client, which the headless profile lacks. */
const canvasReason = 'The fork ships the Excalidraw canvas with the Web/Desktop client, so that preset admits the canvas tools; the headless SDK profile has no canvas surface.'
/** The fork's ssh and sftp tools ride its remote-workspace profile, which Desktop lacks. */
const sshReason = 'The fork reaches remote workspaces over SSH/SFTP, so its SDK profile admits the ssh and sftp tools; the Desktop preset runs against the local filesystem.'

/** Intentional product differences; obsolete entries fail alongside undeclared differences. */
export const toolParityExceptions: Record<ToolMode, readonly Exception[]> = {
  standard: [{ tool: 'list_subagent_models', side: 'desktop',
    reason: 'Desktop enables subagent model discovery; SDK delegation inherits the caller model by default.' },
  { tool: 'excalidraw_draw', side: 'desktop', reason: canvasReason },
  { tool: 'excalidraw_export', side: 'desktop', reason: canvasReason },
  { tool: 'excalidraw_read', side: 'desktop', reason: canvasReason },
  { tool: 'excalidraw_write', side: 'desktop', reason: canvasReason },
  { tool: 'sftp_list', side: 'sdk', reason: sshReason },
  { tool: 'sftp_mkdir', side: 'sdk', reason: sshReason },
  { tool: 'sftp_read', side: 'sdk', reason: sshReason },
  { tool: 'sftp_rename', side: 'sdk', reason: sshReason },
  { tool: 'sftp_rm', side: 'sdk', reason: sshReason },
  { tool: 'sftp_stat', side: 'sdk', reason: sshReason },
  { tool: 'sftp_write', side: 'sdk', reason: sshReason },
  { tool: 'ssh_connect', side: 'sdk', reason: sshReason },
  { tool: 'ssh_connections', side: 'sdk', reason: sshReason },
  { tool: 'ssh_disconnect', side: 'sdk', reason: sshReason },
  { tool: 'ssh_exec', side: 'sdk', reason: sshReason },
  { tool: 'ssh_test', side: 'sdk', reason: sshReason },
  ],
  ptc: [
    { tool: 'list_subagent_models', side: 'desktop',
      reason: 'Desktop enables subagent model discovery; SDK delegation inherits the caller model by default.' },
    { tool: 'plugin_manager', side: 'sdk',
      reason: 'SDK PTC changes are persisted for restart without replacing active bindings because HMR is disabled; Desktop PTC excludes management in its HMR-enabled preset.' },
    { tool: 'workflow', side: 'sdk',
      reason: 'The SDK PTC overlay changes only the executor so existing base workflow callers keep working; Desktop PTC uses run_code orchestration and omits the separate workflow surface.' },
    { tool: 'sftp_list', side: 'sdk', reason: sshReason },
    { tool: 'sftp_mkdir', side: 'sdk', reason: sshReason },
    { tool: 'sftp_read', side: 'sdk', reason: sshReason },
    { tool: 'sftp_rename', side: 'sdk', reason: sshReason },
    { tool: 'sftp_rm', side: 'sdk', reason: sshReason },
    { tool: 'sftp_stat', side: 'sdk', reason: sshReason },
    { tool: 'sftp_write', side: 'sdk', reason: sshReason },
    { tool: 'ssh_connect', side: 'sdk', reason: sshReason },
    { tool: 'ssh_connections', side: 'sdk', reason: sshReason },
    { tool: 'ssh_disconnect', side: 'sdk', reason: sshReason },
    { tool: 'ssh_exec', side: 'sdk', reason: sshReason },
    { tool: 'ssh_test', side: 'sdk', reason: sshReason },
  ],
}

/**
 * Compare actual step-admitted sets, rejecting both drift and unused exceptions.
 * @param mode - matching SDK executor and Desktop preset.
 * @param sdk - SDK capability names.
 * @param desktop - Desktop capability names.
 * @param exceptions - exact one-sided product differences with their rationale.
 */
export function assertToolParity(
  mode: ToolMode, sdk: readonly string[], desktop: readonly string[],
  exceptions = toolParityExceptions[mode],
): void {
  if (sdk.length === 0 || desktop.length === 0) throw new Error(`Empty tool inventory: ${mode}`)
  const only = {
    sdk: new Set(sdk.filter(name => !desktop.includes(name))),
    desktop: new Set(desktop.filter(name => !sdk.includes(name))),
  }
  const stale: string[] = []
  for (const exception of exceptions) {
    if (!exception.reason.trim()) throw new Error(`Tool exception requires a reason: ${exception.tool}`)
    if (!only[exception.side].delete(exception.tool)) stale.push(`${exception.side}:${exception.tool}`)
  }
  if (only.sdk.size || only.desktop.size || stale.length) {
    throw new Error([
      `SDK/Desktop tool mismatch: ${mode}`,
      `Missing from SDK: ${[...only.desktop].sort().join(', ') || '(none)'}`,
      `Only in SDK: ${[...only.sdk].sort().join(', ') || '(none)'}`,
      `Stale exceptions: ${stale.sort().join(', ') || '(none)'}`,
    ].join('\n'))
  }
}
