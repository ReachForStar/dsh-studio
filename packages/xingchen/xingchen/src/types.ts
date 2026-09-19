/**
 * Pure types of the Xingchen (星辰) domain: the four star-domain roles, the
 * `xingchen` projection fold state, and the stop-reason view. No host-side
 * value imports. `./types` serves host consumers and `./client` serves client
 * aggregates; both project this single source.
 *
 * @module @reachforstar/dsh-xingchen/types
 */

/**
 * A star-domain role. `qiming` is the native router agent (this harness's own
 * coding agent); the three specialists are external agents reached through
 * A2A peers.
 */
export type XingchenRoleId = 'qiming' | 'tianquan' | 'yaoguang' | 'tianliang'

/** A specialist role, addressable as an A2A peer. */
export type XingchenSpecialistId = 'tianquan' | 'yaoguang' | 'tianliang'

/**
 * Cropped view of how a turn ended, for the session list's stop-reason
 * label. The `error` detail is deliberately not projected; the full reason
 * stays in the `turn/end` log event.
 */
export type XingchenTurnReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted'; readonly cause: 'user' | 'parent' | 'hook' | 'disposed' | 'legacy' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'error' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }

/** Wire value of the `xingchen` projection. */
export interface XingchenProjection {
  /** The role the latest dispatch targeted; null before the first dispatch. */
  lastRole: XingchenRoleId | null
  /** Specialist dispatches this session has logged, from commands or the tool. */
  dispatchCount: number
  /** How the latest turn ended; null before the first turn end. */
  lastTurnReason: XingchenTurnReason | null
}

/** Host fold state; one-to-one with the wire value. */
export type XingchenUnitState = XingchenProjection

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Xingchen role and stop-reason fold state. */
    xingchen: XingchenUnitState
  }
  interface SessionProjectionMap {
    /** Star-domain routing folded from dispatching commands, the route tool, and turn ends. */
    xingchen: XingchenProjection
  }
}
