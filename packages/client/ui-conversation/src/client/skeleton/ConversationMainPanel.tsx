import { useCallback, useRef, useState } from 'react'
import type { ConversationSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { ConversationContent } from './ConversationContent.tsx'
import css from './ConversationRoot.module.css'

/** localStorage key for the chosen transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a chosen content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Column budget the content leaves free: 88px per side, the figure this axis
 * has always reserved for its edge clearances. An unchanged budget keeps a
 * stored width the size it had when it was chosen. */
const CONTENT_EDGE_BUDGET = 176

/** The content-width range one rendered column can offer. */
export interface WidthAxis {
  /** Lowest width the slider offers. */
  min: number
  /** Highest width this column can show without consuming its edge budget. */
  max: number
  /** Width the column is showing. */
  value: number
}

/**
 * Highest content width this column can show.
 * @param columnWidth - the conversation column's rendered width in px.
 * @returns the widest content width the column budget allows.
 */
function maxContentWidth(columnWidth: number): number {
  return Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
}

/** Reads the persisted width preference; durable-storage boundary, so a
 * missing or corrupt value resolves to "no preference".
 * @returns the stored width in px, or null when unset or invalid. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis would show for a column width.
 * @param columnWidth - the conversation column's rendered width in px.
 * @param preference - the chosen preference, or null for the adaptive clamp.
 * @returns the resolved content width in px (mirrors the CSS clamp). */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = maxContentWidth(columnWidth)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/**
 * Render the existing main Conversation frame around the extracted content.
 * @param props - the original `main.conversation` Slot props.
 * @returns the unchanged root, Header, content, and width-control subtree.
 */
export function ConversationMainPanel(props: ConversationSlotProps) {
  const { sessionId, useSession, useSessions, useConversation, renderSlot } = props
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  const [widthAxis, setWidthAxis] = useState<WidthAxis | undefined>(undefined)
  const rootEl = useRef<HTMLDivElement | null>(null)

  // Publishes the chosen width as the shared width axis (see the .root CSS)
  // and re-clamps it against the shrunken column WITHOUT rewriting the stored
  // preference — widening the window restores it (the AppFrame sidebar-drag
  // rule). Same callback-ref pattern as the seat observer.
  const publishWidths = useCallback((root: HTMLDivElement, preference: number | null): void => {
    const column = root.offsetWidth
    const max = maxContentWidth(column)
    const value = resolveContentWidth(column, preference)
    if (preference === null) root.style.removeProperty('--dsh-chat-user-width')
    else root.style.setProperty('--dsh-chat-user-width', `${value}px`)
    // Identity is kept when nothing moved: the observer runs on every column
    // resize, and a fresh object would re-render the slider for no change.
    setWidthAxis(current => current !== undefined && current.max === max && current.value === value
      ? current
      : { min: CONTENT_MIN, max, value })
  }, [])
  const rootObserver = useRef<ResizeObserver | null>(null)
  const publishColumnWidth = useCallback((): void => {
    const root = rootEl.current
    if (root === null) return
    root.style.setProperty('--dsh-conversation-column-width', `${root.offsetWidth}px`)
  }, [])
  const rootResizeRef = useCallback((root: HTMLDivElement | null): void => {
    rootObserver.current?.disconnect()
    rootObserver.current = null
    rootEl.current = root
    if (root === null) return
    rootObserver.current = new ResizeObserver(() => {
      publishColumnWidth()
      publishWidths(root, readWidthPreference())
    })
    rootObserver.current.observe(root)
    publishColumnWidth()
    publishWidths(root, readWidthPreference())
  }, [publishColumnWidth, publishWidths])

  // Slider plumbing: every step publishes the chosen width (the CSS override
  // and the slider's own position), and the choice is stored as it moves — a
  // range input has no "press without travel" state to protect the stored
  // preference from.
  const onContentWidthChange = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- the slider renders inside the root, so the ref is always attached. */
    if (root === null) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
    publishWidths(root, width)
  }, [publishWidths])

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  // Exemption: a session the list summary already proves blank can only
  // land on the hero, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session is the hero before its open starts (`cold`) and
  // after one fails (`error`) for the same reason — there is no history.
  // A restored continuable subagent also stays settled until its eagerly
  // loaded parent catalog establishes availability. This keeps the composer
  // hidden instead of briefly rendering the parent-offline takeover.
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = sessionId !== undefined && (
    (shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  )
  const hero = sessionId === undefined
    || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'

  return (
    <div ref={rootResizeRef} className={css.root} data-phase={phase}>
      {sessionId === undefined ? null : renderSlot('conversation.session.header', {})}
      <ConversationContent
        {...props}
        session={session}
        phase={phase}
        hero={hero}
        widthAxis={widthAxis}
        onContentWidthChange={onContentWidthChange}
      />
    </div>
  )
}
