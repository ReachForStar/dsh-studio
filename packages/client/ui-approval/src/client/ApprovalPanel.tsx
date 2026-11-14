/** Composer adapter for one pending tool-approval waterfall. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalComposerProps } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Render the shared card using the tool approval's one-shot decision policy,
 * plus a correction field for a request tied to a tool call.
 * @param props Selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const reason = approval.displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason)
  const card = props.renderFactorySlot('conversation.approval.card', {
    requestKey: approval.key,
    title: reason ?? props.t('escalation', { toolName: approval.toolName }),
    ...(approval.callId === undefined ? {} : { callId: approval.callId }),
    canAnswer: () => approval.answerable,
    onAllow: () => approval.answer('allowed-once'),
    onReject: () => approval.answer('rejected'),
    ...approval.action === undefined ? {} : { onAlways: () => props.alwaysAllow(approval) },
    ...approval.fullAccess && approval.requestId !== undefined
      ? { onFullAccess: () => props.grantFullAccess(approval) }
      : {},
  })
  if (approval.callId === undefined) return card
  return (
    <>
      {card}
      <CorrectionBox approval={approval} props={props} />
    </>
  )
}

/** Correction field: reject with replacement arguments the model should retry with. */
function CorrectionBox({ approval, props }: {
  readonly approval: ApprovalComposerProps['matched']
  readonly props: ApprovalComposerProps
}) {
  const [text, setText] = useState('')
  const submit = (): void => {
    if (text.trim().length === 0) return
    void props.rejectWithCorrection(approval, text)
  }
  return (
    <div className={css.correction}>
      <input
        className={css.correctionInput}
        value={text}
        placeholder={props.t('correctionPlaceholder')}
        aria-label={props.t('correctionPlaceholder')}
        disabled={!approval.answerable}
        onChange={(event) => { setText(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          submit()
        }}
      />
      <Button variant="outline" disabled={!approval.answerable || text.trim().length === 0} onClick={submit}>
        {props.t('rejectWithCorrection')}
      </Button>
    </div>
  )
}
