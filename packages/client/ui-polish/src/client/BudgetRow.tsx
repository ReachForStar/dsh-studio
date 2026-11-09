// Monthly budget row in the General settings section: the CNY cap the stats
// float compares against the current calendar month's estimated spend. The
// value persists in the ui-polish settings document; an empty field clears it.
// The input commits on blur or Enter so a typed amount is not written digit by
// digit, and its `key` follows the store revision so an adopted value (own
// save or another client's edit) re-seeds the uncontrolled field.

import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createBudgetRowStore } from './settings-store.ts'
import css from './BackgroundRow.module.css'

/** Injected business face: persist a budget change. */
export interface BudgetRowInjected {
  /** Persist a monthly budget; null clears it. */
  setBudget: (budget: number | null) => void
}

/** Full component props: runtime share + locale seat + store + injected budget face. */
export type BudgetRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'ui-polish'>
  & PropsStore<ReturnType<typeof createBudgetRowStore>> & BudgetRowInjected

/**
 * Parse one committed field value; a blank field clears the budget.
 * @param text - the input's current text.
 * @returns the budget to persist, or null to clear it.
 */
function budgetFrom(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return Number(trimmed)
}

/**
 * Render the monthly budget row.
 * @param props - composed slot props.
 */
export function BudgetRow({ t, setBudget, useStore }: BudgetRowProps) {
  const budget = useStore(s => s.budget)
  const revision = useStore(s => s.revision)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('budget.title')}</div>
      <div className={css.row}>
        <input
          key={revision}
          type="number"
          min={0}
          step={1}
          className={css.number}
          defaultValue={budget === null ? '' : String(budget)}
          placeholder={t('budget.placeholder')}
          aria-label={t('budget.title')}
          onBlur={(event) => {
            const text = event.currentTarget.value
            const next = budgetFrom(text)
            // A non-finite or negative amount is ignored: restore the committed
            // value instead of clearing a budget the user never meant to drop.
            if (text.trim() !== '' && (next === null || !Number.isFinite(next) || next < 0)) {
              event.currentTarget.value = budget === null ? '' : String(budget)
              return
            }
            setBudget(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </div>
      <div className={css.hint}>{t('budget.hint')}</div>
    </div>
  )
}
