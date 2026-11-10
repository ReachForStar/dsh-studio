/**
 * Permanent-deletion confirmation for one Session. The first click arms the
 * action and the second removes the log, so a stray click cannot destroy a
 * conversation; cancelling writes nothing.
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionDeleteConfirmProps, SessionDeleteConfirmRequest } from '../contract/slots.ts'
import css from './DeleteSession.module.css'

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session).
 * @param props - the request hook, its settlement, the delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteConfirmDialog({
  useDeleteRequest, settleSessionDelete, deleteSession, t,
}: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      deleteSession={deleteSession}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

/** One request's dialog: armed and in-flight state die with it. */
function DeleteConfirmForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteConfirmRequest
  deleteSession: SessionDeleteConfirmProps['deleteSession']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const [armed, setArmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = (): void => {
    if (deleting) return
    onSettle()
  }
  const confirm = (): void => {
    if (!armed) {
      setArmed(true)
      return
    }
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setArmed(false)
      setError(deleteFailure(reason, t))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.confirm.title')}
      description={t('delete.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            disabled={deleting}
            onClick={confirm}
          >
            {t(armed ? 'delete.confirm.confirm' : 'delete.confirm.action')}
          </Button>
        </>
      )}
    >
      <p className={css.deleteWarning}>{t('delete.confirm.warning')}</p>
      {deleting && <div className={css.deleteStatus} role="status">{t('delete.confirm.pending')}</div>}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * Localized refusal for a Host delete failure; unknown failures keep the
 * Host's own message.
 * @param reason - the rejected value from the delete hop.
 * @param t - the workspace dictionary.
 * @returns the line the dialog shows.
 */
function deleteFailure(reason: unknown, t: SessionDeleteConfirmProps['t']): string {
  // The class identity check goes by name: client plugin bundles do not share
  // error-class identity with the package that throws.
  if (reason instanceof Error && reason.name === 'WorkspaceDeleteSessionError') {
    const code = (reason as { rpcError?: { code?: string } }).rpcError?.code
    if (code === 'workspace/session-open') return t('delete.openRefusal')
    if (code === 'workspace/session-active') return t('delete.activeRefusal')
  }
  return reason instanceof Error ? reason.message : String(reason)
}
