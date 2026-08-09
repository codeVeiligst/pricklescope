import type { SyncTarget } from '@pricklescope/contracts'
import { Button, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'

function targetTone(target: SyncTarget) {
  if (target.blocked) return 'warning' as const
  return target.pending ? ('warning' as const) : ('positive' as const)
}

function targetState(target: SyncTarget) {
  if (target.blocked) return 'Unavailable'
  return target.pending ? 'Pending' : 'Up to date'
}

/**
 * Shows whether the engines PrickleScope reconciles still match the desired
 * state it holds, and applies the ones that do not.
 *
 * The panel lists every target before anything is written, because applying
 * republishes collector configuration and rewrites Grafana — worth seeing the
 * blast radius first.
 */
export function SyncButton() {
  const { session, csrfToken } = useAuth()
  // Applying enacts storage retention, rewrites the managed dashboards, and
  // pushes alert rules — each of which needs an administrator on its own screen.
  // The control matches that rather than offering an operator a shortcut past it.
  const canApply = session?.user.role === 'administrator'
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  const status = useQuery({
    queryKey: ['sync'],
    queryFn: api.syncStatus,
    refetchInterval: 20_000,
  })

  const apply = useMutation({
    mutationFn: () => api.applySync(csrfToken!),
    onSuccess: async () => {
      // The jobs run in the background; poll until the targets report clean.
      await queryClient.invalidateQueries({ queryKey: ['sync'] })
    },
  })

  // While jobs are running the status is briefly stale, so poll faster until it
  // settles rather than leaving a badge that lies for twenty seconds.
  const busy = apply.isPending
  useEffect(() => {
    if (!apply.isSuccess) return
    const timers = [1000, 3000, 6000, 12000].map((delay) =>
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['sync'] }), delay),
    )
    return () => timers.forEach(clearTimeout)
  }, [apply.isSuccess, apply.submittedAt, queryClient])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const targets = status.data?.targets ?? []
  const pendingCount = status.data?.pendingCount ?? 0
  const applicable = targets.some((target) => target.pending && !target.blocked)

  return (
    <div className="sync-menu" ref={container}>
      <button
        className={`icon-button sync-button${pendingCount ? ' sync-button--pending' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={
          pendingCount
            ? `Pending changes: ${pendingCount} of ${targets.length} targets need applying`
            : 'Everything is applied'
        }
      >
        <RefreshCw size={19} className={busy ? 'spin' : undefined} />
        {pendingCount ? <span className="sync-badge">{pendingCount}</span> : null}
      </button>

      {open ? (
        <div className="sync-popover" role="dialog" aria-label="Pending changes">
          <div className="sync-popover__head">
            <strong>{pendingCount ? 'Changes to apply' : 'Everything is applied'}</strong>
            <span>
              {pendingCount
                ? 'The controller holds newer settings than these engines.'
                : 'Every engine matches the settings held here.'}
            </span>
          </div>
          <ul className="sync-list">
            {targets.map((target) => (
              <li key={target.key}>
                <span className="sync-list__name">{target.label}</span>
                <StatusPill tone={targetTone(target)}>{targetState(target)}</StatusPill>
                <small>{target.blocked ?? target.detail}</small>
              </li>
            ))}
          </ul>
          {apply.error ? (
            <p className="sync-popover__error" role="alert">
              {apply.error instanceof Error ? apply.error.message : 'Applying failed'}
            </p>
          ) : null}
          {canApply ? (
            <div className="sync-popover__actions">
              <Button
                size="small"
                disabled={!applicable || busy}
                icon={busy ? <LoaderCircle size={15} className="spin" /> : undefined}
                onClick={() => apply.mutate()}
              >
                {busy ? 'Applying…' : 'Apply all changes'}
              </Button>
            </div>
          ) : applicable ? (
            <p className="sync-popover__note">An administrator applies these changes.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
