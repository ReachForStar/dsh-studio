// @vitest-environment jsdom
/** CompactionRow behavior: seeded selection, persist on change, and the saved flash. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CompactionRow } from '../src/client/CompactionRow.tsx'
import type { CompactionRowProps } from '../src/client/CompactionRow.tsx'
import { createCompactionRowStore } from '../src/client/settings-store.ts'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const COPY: Record<string, string> = {
  'compaction.title': 'Auto-compaction threshold',
  'compaction.defaultOption': 'Harness default (80%)',
  'compaction.saved': 'Saved',
  'compaction.hint': 'Compacts once context pressure passes this ratio.',
}

function mount(ratio: number | null = null) {
  const store = createCompactionRowStore().create()
  store.actions.sync(ratio, 0)
  const setRatio = vi.fn()
  const props = {
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setRatio,
  } as unknown as CompactionRowProps
  render(<CompactionRow {...props} />)
  return {
    store,
    setRatio,
    select: screen.getByLabelText<HTMLSelectElement>('Auto-compaction threshold'),
  }
}

describe('CompactionRow', () => {
  it('seeds the selection from the store, with the harness default when unset', () => {
    const b = mount(null)
    expect(b.select.value).toBe('')
    expect(screen.getByRole('option', { name: 'Harness default (80%)' }).textContent).toBe('Harness default (80%)')
  })

  it('shows a configured ratio as its percentage', () => {
    const b = mount(0.7)
    expect(b.select.value).toBe('70')
  })

  it('persists a chosen ratio and flashes the saved notice', () => {
    vi.useFakeTimers()
    const b = mount(null)
    fireEvent.change(b.select, { target: { value: '60' } })
    expect(b.setRatio).toHaveBeenCalledWith(0.6)
    expect(screen.getByText('Saved')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('clears the ratio back to the harness default', () => {
    const b = mount(0.6)
    fireEvent.change(b.select, { target: { value: '' } })
    expect(b.setRatio).toHaveBeenCalledWith(null)
  })
})
