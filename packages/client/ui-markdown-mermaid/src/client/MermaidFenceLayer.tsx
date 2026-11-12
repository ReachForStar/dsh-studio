/**
 * Chat's `mermaid` Markdown fence layer: the drawn diagram replaces the inner
 * code block once the fence settles, and the inner block stands in while it
 * streams and whenever drawing fails.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  HocShare, PropsLocale, PropsRuntime, SlotMap,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { MermaidRender } from './mermaid.ts'
import css from './MermaidFenceLayer.module.css'

/** Business face this plugin injects into its fence layer. */
export interface MermaidFenceInjected {
  /** Draws one fence body; the plugin owns the single Mermaid library load. */
  readonly renderDiagram: MermaidRender
  /** Mints the element id one drawing needs, unique for the plugin instance. */
  readonly nextDiagramId: () => string
}

/** Props of the fence layer: the fence, the inner code block, copy, and the injected renderer. */
export type MermaidFenceLayerProps =
  PropsRuntime<'conversation.chat.markdown.fence'>
  & HocShare<SlotMap['conversation.chat.markdown.fence']>
  & PropsLocale<'mermaid'>
  & MermaidFenceInjected

/**
 * Replace a settled `mermaid` fence with its drawing; a streaming fence keeps
 * the inner code block so a half-written diagram never draws as an error.
 * @param props - the fence, the owner's code block, copy, and the injected renderer.
 * @returns the drawing, its status, or the owner's code block.
 */
export function MermaidFenceLayer({
  code, streaming, children, renderDiagram, nextDiagramId, t,
}: MermaidFenceLayerProps): ReactNode {
  if (streaming) return children
  return (
    <MermaidDiagram
      code={code}
      renderDiagram={renderDiagram}
      nextDiagramId={nextDiagramId}
      fallback={children}
      labels={{ loading: t('loading'), failed: t('failed') }}
    />
  )
}

/** One fence body's drawing state, tagged with the body it describes. */
type DiagramState =
  | { readonly body: string; readonly status: 'drawing' }
  | { readonly body: string; readonly status: 'drawn'; readonly svg: string }
  | { readonly body: string; readonly status: 'failed' }

/** Copy of one drawing: its status line and the note under a failed drawing. */
export interface MermaidDiagramLabels {
  readonly loading: string
  readonly failed: string
}

/** Props of one drawing; `fallback` is the owner's code block. */
export interface MermaidDiagramProps {
  readonly code: string
  readonly renderDiagram: MermaidRender
  readonly nextDiagramId: () => string
  readonly fallback: ReactNode
  readonly labels: MermaidDiagramLabels
}

/**
 * Draw one fence body off the render path and show the result in place of the
 * code block; a failure keeps the code block and says why.
 * @param props - the fence body, the renderer, the code block, and copy.
 * @returns the drawn diagram, a drawing status, or the code block.
 */
export function MermaidDiagram({
  code, renderDiagram, nextDiagramId, fallback, labels,
}: MermaidDiagramProps): ReactNode {
  const [state, setState] = useState<DiagramState>({ body: code, status: 'drawing' })
  // React's sanctioned derived-state reset: a result of another body is not
  // this body's drawing, so a code change starts over at the status line.
  if (state.body !== code) setState({ body: code, status: 'drawing' })
  useEffect(() => {
    let current = true
    void renderDiagram(nextDiagramId(), code).then(
      (svg) => { if (current) setState({ body: code, status: 'drawn', svg }) },
      () => { if (current) setState({ body: code, status: 'failed' }) },
    )
    // An unload, or the body change that supersedes this drawing, abandons it.
    return () => { current = false }
  }, [code, renderDiagram, nextDiagramId])
  if (state.status === 'drawn') {
    return (
      <div className={css.diagram} data-mermaid-diagram="" dangerouslySetInnerHTML={{ __html: state.svg }} />
    )
  }
  if (state.status === 'failed') {
    return (
      <div className={css.failure}>
        {fallback}
        <p className={css.note} role="alert">{labels.failed}</p>
      </div>
    )
  }
  return <div className={css.status} role="status">{labels.loading}</div>
}
