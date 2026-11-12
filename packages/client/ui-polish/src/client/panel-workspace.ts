/** Workspace lookup shared by the ui-polish conversation-view panels. */
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Resolve the workspace path that owns the current session.
 * @param sessionId - current session id, or undefined before selection.
 * @param items - the caller-projected workspace list.
 * @returns the owning workspace path, or undefined when none accounts for the session.
 */
export function workspacePathOf(
  sessionId: string | undefined,
  items: readonly WorkspaceView[],
): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find(item => item.sessionIds.includes(sessionId as SessionId))?.path
}
