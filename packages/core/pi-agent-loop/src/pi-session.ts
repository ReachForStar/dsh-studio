/**
 * Thin wrapper around the Pi coding-agent SDK so the loop's session creation
 * stays injectable. Tests replace this with a stub; the real integration calls
 * Pi's own services + in-memory session manager, so Pi uses its own model and
 * tools (stage-2 POC scope).
 *
 * @module dsh-pi-agent-loop/pi-session
 */

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { PiAgentSessionLike } from './agent.ts'

/** Inputs for opening one Pi AgentSession tied to a dsh session cwd. */
export interface OpenPiSessionOptions {
  readonly cwd: string
}

/** One opened Pi AgentSession plus its disposal. */
export interface OpenedPiSession {
  readonly session: PiAgentSessionLike
  dispose(): void
}

/**
 * Open a Pi AgentSession backed by Pi's own services and an in-memory session
 * manager. The session uses Pi's default tool set and model resolution.
 * @param options - target cwd for the Pi session.
 * @returns the live session surface and its synchronous disposer.
 */
export async function openPiSession(options: OpenPiSessionOptions): Promise<OpenedPiSession> {
  const services = await createAgentSessionServices({ cwd: options.cwd })
  const sessionManager = SessionManager.inMemory(options.cwd)
  const { session } = await createAgentSessionFromServices({ services, sessionManager })
  return { session, dispose: () => { session.dispose() } }
}
