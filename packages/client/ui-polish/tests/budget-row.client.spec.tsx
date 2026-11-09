// @vitest-environment jsdom
/** BudgetRow behavior: seeding from the store, commit on blur or Enter, clearing. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BudgetRow } from '../src/client/BudgetRow.tsx'
import type { BudgetRowProps } from '../src/client/BudgetRow.tsx'
import { createBudgetRowStore } from '../src/client/settings-store.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'budget.title': 'Monthly budget (CNY)',
  'budget.placeholder': 'Unlimited',
  'budget.hint': 'Estimated token spend for the current month.',
}

function mount(budget: number | null = null) {
  const store = createBudgetRowStore().create()
  store.actions.sync(budget, 0)
  const setBudget = vi.fn()
  const props = {
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setBudget,
  } as unknown as BudgetRowProps
  render(<BudgetRow {...props} />)
  return { store, setBudget, input: screen.getByLabelText<HTMLInputElement>('Monthly budget (CNY)') }
}

describe('BudgetRow', () => {
  it('seeds the field from the store and shows the placeholder when unset', () => {
    const b = mount(null)
    expect(b.input.value).toBe('')
    expect(b.input.placeholder).toBe('Unlimited')
  })

  it('commits a typed amount on blur', () => {
    const b = mount(20)
    expect(b.input.value).toBe('20')
    fireEvent.change(b.input, { target: { value: '50' } })
    fireEvent.blur(b.input)
    expect(b.setBudget).toHaveBeenCalledWith(50)
  })

  it('commits on Enter and clears a blank field', () => {
    const b = mount(20)
    const blur = vi.spyOn(b.input, 'blur')
    fireEvent.change(b.input, { target: { value: '' } })
    fireEvent.keyDown(b.input, { key: 'Enter' })
    // Enter leaves the field, which commits the cleared value on blur.
    expect(blur).toHaveBeenCalled()
    fireEvent.blur(b.input)
    expect(b.setBudget).toHaveBeenCalledWith(null)
  })

  it('ignores a negative amount and restores the committed value', () => {
    const b = mount(20)
    fireEvent.change(b.input, { target: { value: '-1' } })
    fireEvent.blur(b.input)
    expect(b.setBudget).not.toHaveBeenCalled()
    expect(b.input.value).toBe('20')
  })

  it('restores an empty field when an invalid amount is typed with no budget set', () => {
    const b = mount(null)
    fireEvent.change(b.input, { target: { value: '-1' } })
    fireEvent.blur(b.input)
    expect(b.setBudget).not.toHaveBeenCalled()
    expect(b.input.value).toBe('')
  })

  it('ignores another key', () => {
    const b = mount(20)
    const blur = vi.spyOn(b.input, 'blur')
    fireEvent.keyDown(b.input, { key: 'a' })
    expect(blur).not.toHaveBeenCalled()
  })

  it('re-seeds the field when the store adopts another value', () => {
    const b = mount(20)
    act(() => { b.store.actions.sync(35, 1) })
    expect(screen.getByLabelText<HTMLInputElement>('Monthly budget (CNY)').value).toBe('35')
  })
})
