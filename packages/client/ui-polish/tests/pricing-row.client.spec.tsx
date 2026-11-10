// @vitest-environment jsdom
/** PricingRow behavior: seeded card text, save validation errors, and reset. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PricingRow } from '../src/client/PricingRow.tsx'
import type { PricingRowProps } from '../src/client/PricingRow.tsx'
import { createPricingRowStore } from '../src/client/settings-store.ts'
import { SEED_RATE_CARD } from '../src/client/cost.ts'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const COPY: Record<string, string> = {
  'pricing.title': 'Model rate card',
  'pricing.save': 'Save',
  'pricing.reset': 'Reset to built-in',
  'pricing.saved': 'Saved',
  'pricing.hint': 'CNY per 1M tokens.',
}

const SEED_TEXT = JSON.stringify(SEED_RATE_CARD, null, 2)

function mount(hasCustom = false) {
  const store = createPricingRowStore().create()
  store.actions.sync(hasCustom ? '{"default":{"inputPerMillion":2,"outputPerMillion":3},"models":{}}' : SEED_TEXT, hasCustom, 0)
  const save = vi.fn()
  const reset = vi.fn()
  const props = {
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    save,
    reset,
  } as unknown as PricingRowProps
  render(<PricingRow {...props} />)
  return {
    store,
    save,
    reset,
    card: screen.getByLabelText<HTMLTextAreaElement>('Model rate card'),
    resetButton: screen.getByRole<HTMLButtonElement>('button', { name: 'Reset to built-in' }),
  }
}

describe('PricingRow', () => {
  it('seeds the editor from the store and disables reset without a user card', () => {
    const b = mount(false)
    expect(b.card.value).toBe(SEED_TEXT)
    expect(b.resetButton.disabled).toBe(true)
  })

  it('enables reset when a user card is set', () => {
    expect(mount(true).resetButton.disabled).toBe(false)
  })

  it('saves the edited text and flashes the saved notice', () => {
    vi.useFakeTimers()
    const b = mount(false)
    fireEvent.change(b.card, { target: { value: '{"default":{"inputPerMillion":1,"outputPerMillion":2},"models":{}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(b.save).toHaveBeenCalledWith('{"default":{"inputPerMillion":1,"outputPerMillion":2},"models":{}}')
    expect(screen.getByText('Saved')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('shows the validation message when the card is rejected', () => {
    const b = mount(false)
    b.save.mockImplementationOnce(() => { throw new Error('rate card: not valid JSON') })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('rate card: not valid JSON')).toBeDefined()
  })

  it('stringifies a non-Error validation failure', () => {
    const b = mount(false)
    b.save.mockImplementationOnce(() => { throw 'rejected' as never })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('rejected')).toBeDefined()
  })

  it('resets the card to the seed text and clears an error', () => {
    const b = mount(true)
    b.save.mockImplementationOnce(() => { throw new Error('rate card: bad tier') })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('rate card: bad tier')).toBeDefined()
    fireEvent.click(b.resetButton)
    expect(b.reset).toHaveBeenCalledOnce()
    expect(b.card.value).toBe(SEED_TEXT)
    expect(screen.queryByText('rate card: bad tier')).toBeNull()
  })
})
