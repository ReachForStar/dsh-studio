import { memo } from 'react'
import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import { CommandStatusRow } from './CommandStatusRow.tsx'

/** Live preview length cap; longer peer text shows its tail, the newest part. */
const LIVE_PREVIEW_CHARS = 400

function livePreviewOf(text: string): string {
  return text.length > LIVE_PREVIEW_CHARS ? `…${text.slice(-LIVE_PREVIEW_CHARS)}` : text
}

/** Card props: the owner payload plus the render site's locale seat (plain prop). */
export interface GenericCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
  /** Command-specific running copy; absent uses the generic command label. */
  runningSummary?: string | undefined
}

/**
 * Render a command summary and its lazily mounted multiline output.
 * @param props - command, locale, and optional running label.
 * @returns the command disclosure.
 */
export const GenericCommandCard = memo(function GenericCommandCard({ node, t, runningSummary }: GenericCommandCardProps) {
  const text = node.outcome?.text
  const summary = node.outcome === null
    ? runningSummary ?? t('command.running')
    : text ?? (node.outcome.kind === 'error' ? t('command.failed') : t('command.done'))
  // The summary already carries the settlement text, so the title is the bare
  // command name.
  const title = node.name ?? t('command.title')
  const state = node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'ok'
  const body = text !== undefined && text.includes('\n') ? text : null
  const liveText = node.liveProgress?.text
  const live = state === 'running' && liveText !== undefined && liveText.trim() !== '' ? livePreviewOf(liveText) : null
  return <CommandStatusRow title={title} state={state} summary={summary} body={body} live={live} t={t} />
})
