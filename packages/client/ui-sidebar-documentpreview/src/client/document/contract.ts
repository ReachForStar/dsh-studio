/** Document renderer slot: the owner supplies shared file state, renderers own their presentation. */
import type { PropsRuntime, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RefCallback } from 'react'

/** One loaded text window, retaining source line positions. */
export interface DocumentTextPage {
  readonly offset: number
  readonly text: string
  readonly lines: number
}

/**
 * Contents prepared by the preview owner using ordinary file reads.
 * Byte arrays are transient UI input, never persisted layout or Session data.
 */
export type DocumentContent =
  | { readonly kind: 'text'; readonly text: string; readonly pages: readonly DocumentTextPage[]; readonly eof: boolean }
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Document body selected by a registered implementation id. */
    'sidebar.right.tab.document': {
      kind: 'keyed'
      scope: 'session'
      owner: {
        /** Original file address, also readable through the standard useResource hook. */
        readonly resourceAddress: string
        /** Loaded content; text is an accumulated prefix until eof. */
        readonly content: DocumentContent
        /** The document toolbar's current wrapping preference. */
        readonly wrap: boolean
        /** Report a renderer-owned scrollport; passing `null` restores the shared body as the owner. */
        readonly scrollportRef: RefCallback<HTMLElement>
        /**
         * Store one complete byte array as this file's content, guarded by the
         * version the tab holds. Renderers whose format is not text (an office
         * document is a zip) use this instead of the text editor in the pane;
         * a renderer that only reads simply ignores it.
         */
        readonly saveBytes: (data: Uint8Array) => void
        /** A write for this tab is in flight; the pane owns the lifecycle. */
        readonly saving: boolean
        /** Why the last write was refused, already localized for display. */
        readonly saveFailure: string | undefined
      }
      hookContext: UseSidebarRightTabInfo
      inject: {
        hooks: {
          tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo>
        }
      }
    }
  }
}

/** Standard input for every document body; entry-local stores and locale props can be intersected with it. */
export type DocumentPreviewProps = PropsRuntime<'sidebar.right.tab.document'>

/**
 * Forward the framework's tab reader to the selected document body.
 * @param _standard - framework standard props.
 * @param useTabInfo - enclosing tab's bound reader.
 * @returns the same reader, without another subscription adapter.
 */
export const documentTabInfoFactory: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> =
  (_standard, useTabInfo) => useTabInfo
