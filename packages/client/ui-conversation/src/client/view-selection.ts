import type { ViewTab } from './contract/views.ts'

/**
 * Fallback View preference order for a Session with no stored selection: the
 * transcript is the shipped default and the last resort.
 */
const FALLBACK_VIEW_IDS = ['chat'] as const

/**
 * Resolve a preferred registered View, then the fallback order, without
 * choosing an unregistered View.
 * @param tabs - currently registered Views.
 * @param selectedId - preferred View identity, when one is stored.
 * @returns the selected View, the first registered fallback, or undefined when none is registered.
 */
export function resolveActiveView(
  tabs: readonly ViewTab[],
  selectedId: string | null,
): ViewTab | undefined {
  const selected = selectedId === null ? undefined : tabs.find(view => view.id === selectedId)
  if (selected !== undefined) return selected
  for (const id of FALLBACK_VIEW_IDS) {
    const fallback = tabs.find(view => view.id === id)
    if (fallback !== undefined) return fallback
  }
  return undefined
}
