/** Modal for one side question about the selected Session. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BTW_ASK_ROUTE } from '../routes.ts'
import type { BtwState } from './controller.ts'
import { NS } from './locales.ts'
import css from './BtwDialog.module.css'

/** Dialog state and dismissal bound into the root overlay entry. */
export interface BtwDialogInjected {
  hooks: { btw: ObservableSnapshot<BtwState> }
  dismiss: () => void
}

/** Root runtime, localized copy, and injected dialog state. */
export type BtwDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<BtwDialogInjected>

type Status = 'idle' | 'asking' | 'answered' | 'failed'

/**
 * Ask one question about the open Session and show the answer in place.
 * @param props - root runtime, bound controller state, and localized copy.
 * @returns the side-question modal, or null while closed.
 */
export function BtwDialog({ useBtw, dismiss, t }: BtwDialogProps) {
  const sessionId = useBtw(state => state.sessionId)
  return sessionId === null
    ? null
    : <OpenDialog sessionId={sessionId} dismiss={dismiss} t={t} />
}

function OpenDialog({ sessionId, dismiss, t }: {
  readonly sessionId: SessionId
  readonly dismiss: () => void
  readonly t: BtwDialogProps['t']
}) {
  const [question, setQuestion] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [answer, setAnswer] = useState('')
  const ask = (): void => {
    const text = question.trim()
    if (text.length === 0 || status === 'asking') return
    setStatus('asking')
    setAnswer('')
    void (async () => {
      try {
        const response = await fetch(BTW_ASK_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, question: text }),
        })
        if (!response.ok) throw new Error(`side question failed: ${response.status}`)
        const body = await response.json() as { answer?: unknown }
        setAnswer(typeof body.answer === 'string' ? body.answer : '')
        setStatus('answered')
      } catch {
        setStatus('failed')
      }
    })()
  }
  return (
    <Modal
      open
      onClose={dismiss}
      title={t('title')}
      description={t('description')}
      closeLabel={t('close')}
      footer={<>
        <Button variant="outline" onClick={dismiss}>{t('close')}</Button>
        <Button variant="primary" disabled={status === 'asking' || question.trim().length === 0} onClick={ask}>
          {t('submit')}
        </Button>
      </>}
    >
      <div className={css.body}>
        <input
          className={css.input}
          value={question}
          autoFocus
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          onChange={(event) => { setQuestion(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            ask()
          }}
        />
        {status === 'asking' && <p className={css.status} aria-live="polite">{t('thinking')}</p>}
        {status === 'failed' && <p className={css.error} role="alert">{t('failed')}</p>}
        {status === 'answered' && <section className={css.answer} aria-label={t('answer')}>
          <h3 className={css.answerTitle}>{t('answer')}</h3>
          <p className={css.answerText}>{answer.length === 0 ? t('failed') : answer}</p>
        </section>}
      </div>
    </Modal>
  )
}
