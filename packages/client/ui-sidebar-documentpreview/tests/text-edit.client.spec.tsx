// @vitest-environment jsdom
/** TextPreview — editing: the draft starts as the file's whole text, the save
 * carries the read version, and a refusal leaves the file alone. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TextPreview } from '../src/client/TextPreview.tsx'
import { PATH, SESSION, TAB_ID, failure, harness, page, settle } from './fixtures.client.ts'

afterEach(() => { cleanup() })

function editor(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>('[data-textpreview-editor]')
  if (element === null) throw new Error('expected the editor textarea')
  return element
}

function status(container: HTMLElement): string | null {
  return container.querySelector('[data-textpreview-edit-status]')?.getAttribute('data-textpreview-edit-status') ?? null
}

function open(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>('[data-textpreview-tool="edit"]')
  if (button === null) throw new Error('expected the edit control')
  fireEvent.click(button)
}

describe('TextPreview — editing', () => {
  it('opens the file as a draft, saves the change, and marks it clean', async () => {
    const h = harness({ 1: page(1, ['one', 'two'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()

    open(view.container)
    await waitFor(() => { expect(editor(view.container).value).toBe('one\ntwo') })
    expect(status(view.container)).toBe('clean')

    fireEvent.change(editor(view.container), { target: { value: 'one\ntwo\nthree' } })
    expect(status(view.container)).toBe('dirty')

    fireEvent.click(view.container.querySelector('[data-textpreview-save]')!)
    await settle()

    expect(h.write).toHaveBeenCalledWith(
      { sessionId: SESSION, path: PATH },
      'one\ntwo\nthree',
      'v1',
      expect.anything(),
    )
    await waitFor(() => { expect(status(view.container)).toBe('clean') })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v2')
  })

  it('saves on the platform shortcut', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    open(view.container)
    await waitFor(() => { expect(editor(view.container).value).toBe('one') })

    fireEvent.change(editor(view.container), { target: { value: 'changed' } })
    fireEvent.keyDown(editor(view.container), { key: 's', ctrlKey: true })
    await settle()

    expect(h.write).toHaveBeenCalledWith(expect.anything(), 'changed', 'v1', expect.anything())
  })

  it('reads the rest of the file before it can be edited', async () => {
    const h = harness({ 1: page(1, ['one'], false), 2: page(2, ['two'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(h.read).toHaveBeenCalledTimes(1)

    open(view.container)

    await waitFor(() => { expect(h.read).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(editor(view.container).value).toBe('one\ntwo') })
  })

  it('keeps the draft when the Host refuses the write', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    h.write.mockResolvedValue(failure('workspace-file/stale-version', { path: PATH }))
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    open(view.container)
    await waitFor(() => { expect(editor(view.container).value).toBe('one') })

    fireEvent.change(editor(view.container), { target: { value: 'mine' } })
    fireEvent.click(view.container.querySelector('[data-textpreview-save]')!)
    await settle()

    await waitFor(() => { expect(status(view.container)).toBe('failed') })
    expect(editor(view.container).value).toBe('mine')
    expect(view.container.querySelector('[data-textpreview-edit-status]')?.textContent)
      .toContain('error.staleVersion')
  })

  it('keeps a second save from starting while the first is in flight', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    let release: ((result: Awaited<ReturnType<typeof h.write>>) => void) | undefined
    h.write.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    open(view.container)
    await waitFor(() => { expect(editor(view.container).value).toBe('one') })

    fireEvent.change(editor(view.container), { target: { value: 'changed' } })
    fireEvent.click(view.container.querySelector('[data-textpreview-save]')!)
    await settle()
    expect(status(view.container)).toBe('saving')

    fireEvent.click(view.container.querySelector('[data-textpreview-save]')!)
    expect(h.write).toHaveBeenCalledTimes(1)

    release?.({ ok: true, value: { absolutePath: '/host/project/work/notes.md', version: 'v2', bytes: 3 } })
    await waitFor(() => { expect(status(view.container)).toBe('clean') })
  })

  it('saves nothing while the file is still arriving', async () => {
    const h = harness({ 1: page(1, ['one'], false) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    open(view.container)

    fireEvent.keyDown(editor(view.container), { key: 's', metaKey: true })
    await settle()

    expect(h.write).not.toHaveBeenCalled()
  })

  it('leaves the editor from its own control', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    open(view.container)
    await waitFor(() => { expect(editor(view.container).value).toBe('one') })

    fireEvent.click(view.container.querySelector('[data-textpreview-tool="edit-stop"]')!)

    await waitFor(() => { expect(view.container.querySelector('[data-textpreview-editor]')).toBeNull() })
    expect(view.container.querySelector('[data-textpreview-tool="edit"]')).not.toBeNull()
  })

  it('leaves the editor on Escape', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    open(view.container)
    await waitFor(() => { expect(editor(view.container).value).toBe('one') })

    fireEvent.keyDown(editor(view.container), { key: 'Escape' })

    await waitFor(() => { expect(view.container.querySelector('[data-textpreview-editor]')).toBeNull() })
  })
})
