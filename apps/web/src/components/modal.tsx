import { Button } from '@pricklescope/ui'
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

export function Modal({
  title,
  description,
  open,
  onClose,
  children,
}: {
  title: string
  description?: string
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-card__head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <Button variant="ghost" size="small" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </Button>
        </div>
        {children}
      </section>
    </div>
  )
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : 'The request could not be completed'
  return (
    <div className="form-error" role="alert">
      {message}
    </div>
  )
}
