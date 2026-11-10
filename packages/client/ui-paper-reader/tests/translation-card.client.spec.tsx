// @vitest-environment jsdom
/** The translation card: titles, progress, failure, copy feedback, and its two actions. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationCard, type TranslationView } from '../src/client/TranslationCard.tsx'

const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`

const VIEW: TranslationView = {
  kind: 'selection', target: 'en', text: 'translated', status: 'ready', done: 0, total: 1,
}

/** Render one card with recording actions. */
function renderCard(view: Partial<TranslationView>) {
  const onTarget = vi.fn()
  const onClose = vi.fn()
  const rendered = render(
    <TranslationCard view={{ ...VIEW, ...view }} t={t} onTarget={onTarget} onClose={onClose} />,
  )
  return { ...rendered, onTarget, onClose }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('translation card', () => {
  it('shows the selection title and the finished text', () => {
    renderCard({})
    expect(screen.getByRole('heading', { name: 'translateSelectionTitle' })).toBeDefined()
    expect(screen.getByText('translated')).toBeDefined()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the document title and page progress while streaming', () => {
    renderCard({ kind: 'document', status: 'streaming', done: 1, total: 3, text: 'first page' })
    expect(screen.getByRole('heading', { name: 'translateDocumentTitle' })).toBeDefined()
    expect(screen.getByRole('status').textContent).toBe('translateProgress:{"done":1,"total":3}')
  })

  it('shows a pending notice before the first delta arrives', () => {
    renderCard({ status: 'streaming', text: '' })
    expect(screen.getByRole('status').textContent).toBe('translatePending')
    expect(screen.queryByText('translated')).toBeNull()
  })

  it('reports a failed translation and keeps any partial text', () => {
    renderCard({ status: 'failed', text: 'partial' })
    expect(screen.getByRole('alert').textContent).toBe('translateFailed')
    expect(screen.getByText('partial')).toBeDefined()
  })

  it('says so when there is no text to translate', () => {
    renderCard({ status: 'empty', text: '', kind: 'document', done: 2, total: 2 })
    expect(screen.getByText('translateEmpty')).toBeDefined()
  })

  it('switches the target language through both toggles', () => {
    const h = renderCard({})
    expect(screen.getByRole('button', { name: 'translateTargetEn' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'translateTargetZh' }))
    fireEvent.click(screen.getByRole('button', { name: 'translateTargetEn' }))
    expect(h.onTarget.mock.calls).toEqual([['zh'], ['en']])
  })

  it('copies the text and reports success', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderCard({})
    fireEvent.click(screen.getByRole('button', { name: 'translateCopy' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'translateCopied' })).toBeDefined() })
    expect(writeText).toHaveBeenCalledWith('translated')
  })

  it('keeps copy unavailable until there is text', () => {
    renderCard({ status: 'streaming', text: '' })
    expect(screen.getByRole('button', { name: 'translateCopy' })).toHaveProperty('disabled', true)
  })

  it('closes the card from its close action', () => {
    const h = renderCard({})
    fireEvent.click(screen.getByRole('button', { name: 'translateClose' }))
    expect(h.onClose).toHaveBeenCalledOnce()
  })
})
