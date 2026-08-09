import { Button } from '@pricklescope/ui'
import { useCallback, useState, type ReactNode } from 'react'

import { Modal } from './modal.js'

export interface ConfirmRequest {
  title: string
  /** What will happen, in the operator's words. */
  body: ReactNode
  /** Label for the confirming button — name the action, never "OK". */
  confirmLabel: string
  /** Destructive actions get the danger treatment. */
  destructive?: boolean
  onConfirm: () => void
}

/**
 * Replaces `window.confirm` for destructive actions.
 *
 * The browser dialog cannot be styled, cannot carry more than one line, and
 * renders outside the application's theme. This keeps the same one-line call
 * shape at the call site while the dialog matches every other surface.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const confirm = useCallback((next: ConfirmRequest) => setRequest(next), [])
  const close = useCallback(() => setRequest(null), [])

  const dialog = request ? (
    <Modal title={request.title} open onClose={close}>
      <div className="confirm-dialog">
        <p>{request.body}</p>
        <div className="form-actions">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={request.destructive ? 'danger' : 'primary'}
            onClick={() => {
              request.onConfirm()
              close()
            }}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  ) : null

  return { confirm, confirmDialog: dialog }
}
