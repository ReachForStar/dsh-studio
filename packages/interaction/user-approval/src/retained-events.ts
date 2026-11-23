/**
 * Declarations retained only so sessions written by released builds stay readable.
 *
 * `approval/full-access` lost its producer when the fork removed the approval
 * capabilities it adopted from codex and ZCode. The declaration stays in the
 * owning package so the persistence catalog resolves `ApprovalRequestId`
 * exactly as before: dropping the member would make the reader reject an
 * existing log, because it refuses unknown types unless the record carries
 * `ignorable`. The event was log-only, so no projection in this build folds it.
 *
 * @module @deepseek-ai/dsh-user-approval/retained-events
 */

import type { ApprovalRequestId } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One full-access grant committed from a pending approval prompt — log-only
     * (like the other `approval/*` events, no `surfaceOp`): durable receipt of
     * the exact prompt and the input identities it covered at commit time.
     * Input queued later is outside that receipt, and a retried grant for the
     * same request id reuses these targets instead of widening the grant.
     */
    'approval/full-access': {
      requestId: ApprovalRequestId
      /** Pending input identities captured when the grant committed, in inbox order. */
      targets: readonly string[]
    }
  }
}
