// @vitest-environment jsdom
/**
 * One Mermaid drawing: the settled fence body is drawn off the render path,
 * an invalid body keeps the owner's code block with a failure note, and a
 * result that arrives after its body changed or after unload never paints.
 * The renderer is injected, so no diagram engine runs here.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MermaidDiagram } from '../src/client/MermaidFenceLayer.tsx'

afterEach(cleanup)

/** Copy of one drawing; the text names the state it belongs to. */
const labels = { loading: 'copy:loading', failed: 'copy:failed' }

/** The owner's code block, as the fence slot passes it to the layer. */
function codeBlock(code: string) {
  return <pre data-testid="code-block">{code}</pre>
}

describe('MermaidDiagram', () => {
  it('draws a settled fence body in place of the code block', async () => {
    const renderDiagram = vi.fn(async (id: string, code: string) => `<svg data-id="${id}" data-body="${code}"></svg>`)
    let diagrams = 0
    const view = render(
      <MermaidDiagram
        code="graph TD;A-->B"
        renderDiagram={renderDiagram}
        nextDiagramId={() => `mermaid-diagram-${++diagrams}`}
        fallback={codeBlock('graph TD;A-->B')}
        labels={labels}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('copy:loading')
    await waitFor(() => { expect(view.container.querySelector('[data-mermaid-diagram] svg')).not.toBeNull() })
    expect(renderDiagram).toHaveBeenCalledWith('mermaid-diagram-1', 'graph TD;A-->B')
    expect(view.container.querySelector('[data-id="mermaid-diagram-1"]')).not.toBeNull()
    expect(view.queryByTestId('code-block')).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('keeps the code block and reports a drawing that failed', async () => {
    const view = render(
      <MermaidDiagram
        code="graph TD;A--"
        renderDiagram={() => Promise.reject(new Error('parse error'))}
        nextDiagramId={() => 'mermaid-diagram-1'}
        fallback={codeBlock('graph TD;A--')}
        labels={labels}
      />,
    )
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('copy:failed') })
    expect(view.getByTestId('code-block').textContent).toBe('graph TD;A--')
    expect(view.container.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('drops a drawing whose fence body already changed', async () => {
    const drawings: ((svg: string) => void)[] = []
    const renderDiagram = vi.fn(() => new Promise<string>((resolve) => { drawings.push(resolve) }))
    const nextDiagramId = (): string => 'mermaid-diagram-1'
    const view = render(
      <MermaidDiagram code="graph TD;A-->B" renderDiagram={renderDiagram} nextDiagramId={nextDiagramId}
        fallback={codeBlock('graph TD;A-->B')} labels={labels} />,
    )
    view.rerender(
      <MermaidDiagram code="graph TD;C-->D" renderDiagram={renderDiagram} nextDiagramId={nextDiagramId}
        fallback={codeBlock('graph TD;C-->D')} labels={labels} />,
    )
    await act(async () => { drawings[1]?.('<svg data-body="C-->D"></svg>') })
    await waitFor(() => { expect(view.container.querySelector('svg')).not.toBeNull() })
    // The abandoned body settles last; a painted result would replace the live drawing.
    await act(async () => { drawings[0]?.('<svg data-body="A-->B"></svg>') })
    const drawn = view.container.querySelector('[data-mermaid-diagram] svg')
    expect(drawn?.getAttribute('data-body')).toBe('C-->D')
    expect(view.queryByRole('status')).toBeNull()
  })

  it('keeps the live drawing when an abandoned body fails late', async () => {
    const drawings: { resolve: (svg: string) => void; reject: (error: Error) => void }[] = []
    const renderDiagram = vi.fn(() => new Promise<string>((resolve, reject) => { drawings.push({ resolve, reject }) }))
    const nextDiagramId = (): string => 'mermaid-diagram-1'
    const view = render(
      <MermaidDiagram code="graph TD;A-->B" renderDiagram={renderDiagram} nextDiagramId={nextDiagramId}
        fallback={codeBlock('graph TD;A-->B')} labels={labels} />,
    )
    view.rerender(
      <MermaidDiagram code="graph TD;C-->D" renderDiagram={renderDiagram} nextDiagramId={nextDiagramId}
        fallback={codeBlock('graph TD;C-->D')} labels={labels} />,
    )
    await act(async () => { drawings[1]?.resolve('<svg data-body="C-->D"></svg>') })
    await waitFor(() => { expect(view.container.querySelector('svg')).not.toBeNull() })
    // A late rejection would otherwise replace the drawing with the source block and a failure note.
    await act(async () => { drawings[0]?.reject(new Error('parse error')) })
    expect(view.container.querySelector('svg')?.getAttribute('data-body')).toBe('C-->D')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('writes nothing when a drawing settles after unload', async () => {
    let settle: ((svg: string) => void) | undefined
    const view = render(
      <MermaidDiagram
        code="graph TD;A-->B"
        renderDiagram={() => new Promise<string>((resolve) => { settle = resolve })}
        nextDiagramId={() => 'mermaid-diagram-1'}
        fallback={codeBlock('graph TD;A-->B')}
        labels={labels}
      />,
    )
    view.unmount()
    await act(async () => { settle?.('<svg data-body="late"></svg>') })
    expect(view.container.innerHTML).toBe('')
    expect(document.querySelector('[data-body="late"]')).toBeNull()
  })
})
