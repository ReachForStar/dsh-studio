import { useCallback, useLayoutEffect, useState } from 'react'
import { Slider } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationWidthControlsProps } from '../contract/slots.ts'
import css from './ConversationRoot.module.css'

/** localStorage key for the chosen transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a chosen content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Horizontal room the column reserves for its own edges and gutter. */
const CONTENT_EDGE_BUDGET = 176

/** Read a valid persisted width preference, or null when absent or corrupt. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Highest content width one measured column can show. */
function maxContentWidth(columnWidth: number): number {
  return Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
}

/** Resolve the width displayed for one measured Conversation column. */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), maxContentWidth(columnWidth))
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/** The content-width range and value one rendered column offers. */
interface WidthAxis {
  readonly min: number
  readonly max: number
  readonly value: number
}

/**
 * Install the Conversation width axis and render its slider above the
 * scrollport. The strip sits in the flow rather than over the transcript, its
 * own length is the width it sets, and every step publishes and stores the
 * chosen width (a range input has no press-without-change state to protect the
 * stored preference from). The written variables live on the Conversation
 * root, so the choice sizes this panel only.
 * @param props - Mounted Conversation body, its presentation phase, and the localized labels.
 * @returns the width slider while a transcript is on screen, otherwise no control.
 */
export function ConversationWidthControls({ container, phase, widthLabel, widthValueText }: ConversationWidthControlsProps) {
  const [axis, setAxis] = useState<WidthAxis | undefined>(undefined)

  const apply = useCallback((column: number, preference: number | null): void => {
    const max = maxContentWidth(column)
    const value = resolveContentWidth(column, preference)
    // Identity is kept when nothing moved: the observer runs on every column
    // resize, and a fresh object would re-render the slider for no change.
    setAxis(current => current !== undefined && current.max === max && current.value === value
      ? current
      : { min: CONTENT_MIN, max, value })
  }, [])

  useLayoutEffect(() => {
    if (container === null) return
    const target = container.parentElement ?? container
    const publish = (): void => {
      const column = container.offsetWidth
      target.style.setProperty('--dsh-conversation-column-width', `${column}px`)
      const preference = readWidthPreference()
      if (preference === null) target.style.removeProperty('--dsh-chat-user-width')
      else target.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
      apply(column, preference)
    }
    const observer = new ResizeObserver(publish)
    observer.observe(container)
    publish()
    return () => { observer.disconnect() }
  }, [container, apply])

  const onChange = useCallback((width: number): void => {
    if (container === null) return
    const target = container.parentElement ?? container
    const column = container.offsetWidth
    const resolved = resolveContentWidth(column, width)
    localStorage.setItem(WIDTH_PREF_KEY, `${resolved}`)
    target.style.setProperty('--dsh-chat-user-width', `${resolved}px`)
    apply(column, width)
  }, [container, apply])

  if (container === null || phase !== 'active' || axis === undefined) return null
  // A column narrower than the floor plus its edge budget offers no range;
  // rendering a slider whose min equals its max would only show a fixed width.
  if (axis.max <= axis.min) return null
  return (
    <div className={css.widthSlider} data-conversation-width-slider="">
      <Slider
        min={axis.min}
        max={axis.max}
        value={axis.value}
        onChange={onChange}
        label={widthLabel}
        valueText={widthValueText(axis.value)}
      />
    </div>
  )
}
