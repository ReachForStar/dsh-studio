/** Browser state for one open side-question dialog. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Which Session's side-question dialog is open. */
export interface BtwState {
  readonly sessionId: SessionId | null
}

/** Owns the single open dialog; opening another Session replaces it. */
export class BtwController {
  readonly store = createSnapshotStore<BtwState>({ sessionId: null })

  /**
   * Open the dialog for one Session.
   * @param sessionId - the Session whose history answers the question.
   */
  open(sessionId: SessionId): void {
    this.store.set({ sessionId })
  }

  /** Close the dialog and drop its Session. */
  close(): void {
    this.store.set({ sessionId: null })
  }
}
