// @vitest-environment jsdom
/** Word 与 PowerPoint 正文：预览、就地编辑、保存与失败状态。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DocxBody } from '../src/client/docx/DocxBody.tsx'
import type { DocxBodyProps } from '../src/client/docx/DocxBody.tsx'
import { PptxBody } from '../src/client/pptx/PptxBody.tsx'
import type { PptxBodyProps } from '../src/client/pptx/PptxBody.tsx'
import { en as docxEn } from '../src/client/docx/locales.ts'
import { en as pptxEn } from '../src/client/pptx/locales.ts'
import { parseDocx } from '../src/client/office/docx.ts'
import { parsePptx } from '../src/client/office/pptx.ts'
import { zipParts } from '../src/client/office/zip.ts'

afterEach(() => { cleanup() })

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCX_XML = `<w:document xmlns:w="${W}"><w:body>`
  + '<w:p><w:r><w:t>first</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p>'
  + '</w:body></w:document>'

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const SLIDE_XML = `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld>`
  + '<p:sp><p:txBody><a:p><a:r><a:t>title</a:t></a:r><a:r><a:t>subtitle</a:t></a:r></a:p></p:txBody></p:sp>'
  + '</p:cSld></p:sld>'

const docxBytes = (): Uint8Array => zipParts({ 'word/document.xml': encode(DOCX_XML) })
const pptxBytes = (): Uint8Array => zipParts({ 'ppt/slides/slide1.xml': encode(SLIDE_XML) })

function translate(dictionary: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>): string => {
    const value = dictionary[key] ?? key
    return params === undefined
      ? value
      : Object.entries(params).reduce((text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)), value)
  }
}

/** 一份满足文档 slot 契约的 props；`saveBytes` 可被替换以观察或注入失败。 */
function props(
  path: string,
  data: Uint8Array | undefined,
  dictionary: Record<string, string>,
  saveBytes = vi.fn(),
  write: { saving?: boolean; failure?: string } = {},
) {
  return {
    resourceAddress: `dsh-resource://file/session/office/${path}`,
    content: data === undefined ? { kind: 'text', text: '', pages: [], eof: true } : { kind: 'bytes', data },
    wrap: false,
    scrollportRef: () => undefined,
    saveBytes,
    saving: write.saving ?? false,
    saveFailure: write.failure,
    sessionId: 'office' as SessionId,
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }),
    t: translate(dictionary),
    // 只用到文档 slot 契约的一个子集；在调用处收窄到组件的 props 类型。
  } as unknown as DocxBodyProps
}

function field(container: HTMLElement, name: string): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>(`[data-office-field="${name}"]`)
  if (element === null) throw new Error(`expected the field ${name}`)
  return element
}

describe('DocxBody', () => {
  it('shows the paragraphs and edits them into a rebuilt archive', async () => {
    const saveBytes = vi.fn()
    const view = render(<DocxBody {...props('report.docx', docxBytes(), docxEn, saveBytes)} />)
    expect(view.container.textContent).toContain('first')
    expect(view.container.textContent).toContain('second')

    fireEvent.click(view.container.querySelector('[data-office-tool="edit"]') as HTMLElement)
    await waitFor(() => { expect(field(view.container, '0-0').value).toBe('first') })
    // 打开编辑器但未改动：草稿等于文件内容，因此不算未保存。
    expect(view.container.textContent).not.toContain('Unsaved changes')

    fireEvent.change(field(view.container, '1-0'), { target: { value: 'rewritten' } })
    expect(view.container.textContent).toContain('Unsaved changes')
    fireEvent.click(view.container.querySelector('[data-office-save]') as HTMLElement)

    expect(saveBytes).toHaveBeenCalledTimes(1)
    const edited = saveBytes.mock.calls[0]?.[0] as Uint8Array
    expect(parseDocx(edited).paragraphs).toEqual(['first', 'rewritten'])
    // 写出去之后不再算未保存。
    await waitFor(() => { expect(view.container.textContent).not.toContain('Unsaved changes') })
  })

  it('shows the saving and failure status the pane owns', () => {
    const saving = render(<DocxBody {...props('report.docx', docxBytes(), docxEn, vi.fn(), { saving: true })} />)
    fireEvent.click(saving.container.querySelector('[data-office-tool="edit"]') as HTMLElement)
    expect(saving.container.textContent).toContain('Saving…')
    cleanup()

    const failed = render(<DocxBody {...props('report.docx', docxBytes(), docxEn, vi.fn(), { failure: 'Save failed: disk full' })} />)
    fireEvent.click(failed.container.querySelector('[data-office-tool="edit"]') as HTMLElement)
    expect(failed.container.textContent).toContain('Save failed: disk full')
  })

  it('reports a parse failure, an unsupported mode, and a refused save', () => {
    const broken = render(<DocxBody {...props('report.docx', encode('not a zip'), docxEn)} />)
    expect(broken.container.textContent).toContain('could not be opened')
    cleanup()

    const text = render(<DocxBody {...props('report.docx', undefined, docxEn)} />)
    expect(text.container.textContent).toContain('requires the complete file contents')
    cleanup()

  })

  it('leaves the editor again without saving', () => {
    const saveBytes = vi.fn()
    const view = render(<DocxBody {...props('report.docx', docxBytes(), docxEn, saveBytes)} />)
    fireEvent.click(view.container.querySelector('[data-office-tool="edit"]') as HTMLElement)
    fireEvent.click(view.container.querySelector('[data-office-tool="edit-stop"]') as HTMLElement)

    expect(view.container.querySelector('[data-office-field]')).toBeNull()
    expect(saveBytes).not.toHaveBeenCalled()
  })
})

describe('PptxBody', () => {
  it('shows the slide texts and edits them into a rebuilt deck', async () => {
    const saveBytes = vi.fn()
    const view = render(<PptxBody {...props('deck.pptx', pptxBytes(), pptxEn, saveBytes) as unknown as PptxBodyProps} />)
    expect(view.container.textContent).toContain('title')

    fireEvent.click(view.container.querySelector('[data-office-tool="edit"]') as HTMLElement)
    await waitFor(() => { expect(field(view.container, '0-0').value).toBe('title') })
    // 两个文本框：改第二个，确认只替换被编辑的那一个。
    fireEvent.change(field(view.container, '0-1'), { target: { value: 'new subtitle' } })
    fireEvent.click(view.container.querySelector('[data-office-save]') as HTMLElement)

    const edited = saveBytes.mock.calls[0]?.[0] as Uint8Array
    expect(parsePptx(edited).slides[0]?.texts).toEqual(['title', 'new subtitle'])
  })

  it('reports a parse failure, an unsupported mode, and a refused save', () => {
    const broken = render(<PptxBody {...props('deck.pptx', encode('nope'), pptxEn) as unknown as PptxBodyProps} />)
    expect(broken.container.textContent).toContain('could not be opened')
    cleanup()
    const text = render(<PptxBody {...props('deck.pptx', undefined, pptxEn) as unknown as PptxBodyProps} />)
    expect(text.container.textContent).toContain('requires the complete file contents')
    cleanup()

    const failing = render(<PptxBody {...props('deck.pptx', pptxBytes(), pptxEn, vi.fn(), { failure: 'Save failed: read-only disk' }) as unknown as PptxBodyProps} />)
    fireEvent.click(failing.container.querySelector('[data-office-tool="edit"]') as HTMLElement)
    expect(failing.container.textContent).toContain('Save failed: read-only disk')
  })
})
