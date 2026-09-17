/**
 * The message of a thrown value, whatever it is.
 *
 * A parser failure can be anything a dependency throws — not only an `Error` —
 * and both office bodies must show it. Keeping the conversion here means the
 * components do not each carry the same ternary, and the non-`Error` half stays
 * reachable in a test rather than as untested defensive code.
 * @param error - the thrown value.
 * @returns its message, or its string form when it carries none.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
