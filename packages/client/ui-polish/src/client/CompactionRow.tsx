// Automatic context-compaction threshold row in the General settings section:
// a select of pressure ratios at which the session's compaction backend
// compacts automatically (50–80%, or the harness default when unset). The
// value persists in the ui-polish settings document; the node half reads it
// per step.

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { COMPACTION_RATIO_FIELD, type PolishSettings } from '../background-settings.ts'
import css from './BackgroundRow.module.css'

/** Options offered: ratio × 100 as the select value; empty = harness default. */
const RATIO_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: '80%（默认）' },
  { value: '50', label: '50%' },
  { value: '60', label: '60%' },
  { value: '70', label: '70%' },
  { value: '75', label: '75%' },
  { value: '80', label: '80%' },
]

/** Injected business face: read the current ratio and persist a change. */
export interface CompactionRowInjected {
  /** Current ratio × 100, or null when unset (harness default applies). */
  currentRatio: number | null
  /** Persist a ratio selection; null clears back to the harness default. */
  setRatio: (ratio: number | null) => void
}

/** Full component props: runtime share + locale seat + injected compaction face. */
export type CompactionRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'ui-polish'> & CompactionRowInjected

/**
 * Render the automatic-compaction threshold row.
 * @param props - composed slot props.
 */
export function CompactionRow({ t, currentRatio, setRatio }: CompactionRowProps) {
  const [saved, setSaved] = useState(false)
  const value = currentRatio === null ? '' : String(Math.round(currentRatio * 100))
  const onChange = (next: string): void => {
    setRatio(next === '' ? null : Number(next) / 100)
    setSaved(true)
    window.setTimeout(() => { setSaved(false) }, 1500)
  }
  return (
    <div className={css.group}>
      <div className={css.title}>{t('compaction.title')}</div>
      <div className={css.row}>
        <select
          className={css.select}
          value={value}
          onChange={(event) => { onChange(event.target.value) }}
          aria-label={t('compaction.title')}
        >
          {RATIO_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {saved && <span className={css.saved}>{t('compaction.saved')}</span>}
      </div>
      <div className={css.hint}>{t('compaction.hint')}</div>
    </div>
  )
}

/** Type-only export so the plugin's inject face stays checkable. */
export type { PolishSettings }
export { COMPACTION_RATIO_FIELD }
