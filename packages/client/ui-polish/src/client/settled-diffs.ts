// Settled file-mutation (diff-card) detection for the file panel: a root Tool
// lifecycle whose settled result carries the `card: 'diff'` render intent (the
// write/edit family) or the `card: 'read'` intent (the read tool) names files
// worth opening. Reads only the runtime block's own view fields.

import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** One settled file-mutation call with the applied hunks the panel draws. */
export interface SettledDiffCall {
  callId: string
  /** Tool display name, falling back to the callId when the head left the window. */
  name: string
  /** Validated applied hunks. */
  diffs: DiffHunk[]
}

/** One tool-operated file path with the tool that touched it. */
export interface TouchedFile {
  /** Tool display name (read/edit/write/…). */
  tool: string
  /** Repository/workspace-relative file path. */
  path: string
}

/**
 * Narrow a wire `card:'diff'` view's `diffs` to well-formed hunks. The view
 * crosses the wire, so a version mismatch or an anomalous plugin can deliver a
 * `diff` card whose `diffs` is absent, not an array, or carries malformed
 * hunks; returning null routes the call out instead of crashing DiffBlock.
 * @param diffs - the view's `diffs` field, unverified.
 * @returns the validated hunks, or null when the payload is not usable.
 */
export function narrowDiffs(diffs: unknown): DiffHunk[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: DiffHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

/**
 * Collect the session's settled file-mutation calls in node-store iteration
 * order. A running or errored mutation is excluded: without an applied diff
 * there is nothing to show.
 * @param snapshot - the session's conversation snapshot.
 * @returns settled diff calls with their applied hunks, in store order.
 */
export function settledDiffCalls(snapshot: ConversationSnapshot): SettledDiffCall[] {
  const out: SettledDiffCall[] = []
  for (const node of snapshot.chat.nodes.values()) {
    if (node.kind !== 'tool-call') continue
    const root = (node as ChatNode<'tool-call'>).data.root
    if (!('kind' in root) || root.resultView?.card !== 'diff') continue
    const diffs = narrowDiffs(root.resultView.diffs)
    if (diffs === null) continue
    out.push({ callId: root.callId, name: root.call?.name ?? root.callId, diffs })
  }
  return out
}

/**
 * Collect every file path a settled tool call operated on (read/edit/write),
 * deduplicated in store order. Read cards carry the file path in `resultView.path`;
 * diff cards carry it per hunk.
 * @param snapshot - the session's conversation snapshot.
 * @returns touched file paths with the tool that touched them.
 */
export function touchedFiles(snapshot: ConversationSnapshot): TouchedFile[] {
  const seen = new Set<string>()
  const out: TouchedFile[] = []
  for (const node of snapshot.chat.nodes.values()) {
    if (node.kind !== 'tool-call') continue
    const root = (node as ChatNode<'tool-call'>).data.root
    if (!('kind' in root)) continue
    const view = root.resultView
    if (view === null) continue
    const tool = root.call?.name ?? root.callId
    if (view.card === 'read' && typeof view.path === 'string') {
      const path = view.path
      if (!seen.has(path)) {
        seen.add(path)
        out.push({ tool, path })
      }
      continue
    }
    if (view.card === 'diff') {
      const diffs = narrowDiffs(view.diffs)
      if (diffs === null) continue
      for (const hunk of diffs) {
        if (seen.has(hunk.path)) continue
        seen.add(hunk.path)
        out.push({ tool, path: hunk.path })
      }
    }
  }
  return out
}
