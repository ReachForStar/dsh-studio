// Model rate card row in the General settings section: edit the JSON rate
// card (CNY per 1M tokens) that prices the session stats float. The built-in
// seed card is the default; saving here persists a user card in the ui-polish
// settings document and re-prices the float immediately. The textarea carries
// the full card (`default` + `models`), matching the `model-pricing.json`
// shape; validation errors show inline and nothing is persisted until the
// JSON parses and every price is finite.

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SEED_RATE_CARD } from './cost.ts'
import css from './BackgroundRow.module.css'

/** Injected business face: read the current card text and persist a change. */
export interface PricingRowInjected {
  /** Current card JSON text (the user card when set, else the formatted seed). */
  currentJson: string
  /** Whether a user card is currently set (false = the seed card applies). */
  hasCustom: boolean
  /**
   * Validate and persist a card from JSON text.
   * @param json - rate card JSON text.
   * @throws {Error} with a field-level message when the card is invalid.
   */
  save: (json: string) => void
  /** Clear the user card back to the built-in seed. */
  reset: () => void
}

/** Full component props: runtime share + locale seat + injected pricing face. */
export type PricingRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'ui-polish'> & PricingRowInjected

/**
 * Render the model rate card row.
 * @param props - composed slot props.
 */
export function PricingRow({ t, currentJson, hasCustom, save, reset }: PricingRowProps) {
  const [text, setText] = useState(currentJson)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const onSave = (): void => {
    try {
      save(text)
      setError(null)
      setSaved(true)
      window.setTimeout(() => { setSaved(false) }, 1500)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  const onReset = (): void => {
    reset()
    setText(JSON.stringify(SEED_RATE_CARD, null, 2))
    setError(null)
  }
  return (
    <div className={css.group}>
      <div className={css.title}>{t('pricing.title')}</div>
      <div className={css.row}>
        <textarea
          className={css.priceCard}
          value={text}
          spellCheck={false}
          onChange={(event) => { setText(event.target.value) }}
          aria-label={t('pricing.title')}
          rows={10}
        />
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      <div className={css.row}>
        <button type="button" className={css.button} onClick={onSave}>{t('pricing.save')}</button>
        <button type="button" className={css.button} onClick={onReset} disabled={!hasCustom}>
          {t('pricing.reset')}
        </button>
        {saved && <span className={css.saved}>{t('pricing.saved')}</span>}
      </div>
      <div className={css.hint}>{t('pricing.hint')}</div>
    </div>
  )
}
