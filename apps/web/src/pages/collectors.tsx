import type { CollectorRevision } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  CheckCircle2,
  Clock3,
  Code2,
  History,
  RefreshCw,
  RotateCcw,
  ServerCog,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { FormError } from '../components/modal.js'
import { useDocumentTitle } from '../hooks.js'
import { jobIsActive } from '../labels.js'

function revisionTone(status: CollectorRevision['status']) {
  if (status === 'active') return 'positive'
  if (status === 'failed') return 'negative'
  return 'neutral'
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

export function CollectorsPage() {
  useDocumentTitle('Collectors')
  const { session, csrfToken } = useAuth()
  const canOperate = session?.user.role !== 'viewer'
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const status = useQuery({
    queryKey: ['telegraf-collector'],
    queryFn: api.telegrafCollector,
    refetchInterval: 15_000,
  })
  const revisions = useQuery({
    queryKey: ['telegraf-revisions'],
    queryFn: api.telegrafRevisions,
  })
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (jobIsActive(query.state.data?.status) ? 600 : false),
  })
  const reconcile = useMutation({
    mutationFn: () => api.reconcileTelegraf(csrfToken!),
    onSuccess: (queued) => setJobId(queued.id),
  })
  const rollback = useMutation({
    mutationFn: (id: string) => api.rollbackTelegraf(id, csrfToken!),
    onSuccess: (queued) => setJobId(queued.id),
  })

  useEffect(() => {
    if (!job.data || jobIsActive(job.data.status)) return
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['telegraf-collector'] }),
      queryClient.invalidateQueries({ queryKey: ['telegraf-revisions'] }),
      queryClient.invalidateQueries({ queryKey: ['jobs'] }),
    ])
  }, [job.data, queryClient])

  const active = status.data?.activeRevision
  const busy = reconcile.isPending || rollback.isPending || jobIsActive(job.data?.status)
  const operationError = reconcile.error ?? rollback.error ?? job.error

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Collectors</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Collector tools">
        <div>
          <Activity size={18} />
          <span>
            Telegraf owns <strong>{active?.checkCount ?? 0}</strong> enabled checks across{' '}
            <strong>{active?.sourceCount ?? 0}</strong> sources
          </span>
        </div>
        {canOperate ? (
          <Button
            icon={<RefreshCw size={17} className={busy ? 'spin' : ''} />}
            onClick={() => reconcile.mutate()}
            disabled={busy}
          >
            {busy ? 'Applying…' : 'Apply desired state'}
          </Button>
        ) : null}
      </section>

      <FormError error={status.error ?? revisions.error ?? operationError} />
      {job.data?.status === 'failed' ? (
        <div className="inline-error">
          The collector change failed. The last known-good revision remains active. {job.data.error}
        </div>
      ) : null}

      <section className="collector-summary" aria-label="Telegraf status">
        <article className="collector-identity panel">
          <div className="collector-identity__mark">
            <ServerCog size={25} />
          </div>
          <div>
            <span className="eyebrow">Primary collector</span>
            <strong>Telegraf</strong>
            <small>SNMP inventory metrics and native reachability probes</small>
          </div>
          <StatusPill
            tone={
              status.data?.state === 'up'
                ? 'positive'
                : status.data?.state === 'down'
                  ? 'negative'
                  : 'neutral'
            }
          >
            {status.data?.state ?? 'checking'}
          </StatusPill>
        </article>
        <article className="collector-stat panel">
          <CheckCircle2 size={19} />
          <span>Active revision</span>
          <strong>{active ? `#${active.revisionNumber}` : 'None'}</strong>
          <small>{active ? shortHash(active.contentHash) : 'Apply desired state to begin'}</small>
        </article>
        <article className="collector-stat panel">
          <Clock3 size={19} />
          <span>Last activation</span>
          <strong>
            {active?.activatedAt ? new Date(active.activatedAt).toLocaleDateString() : '—'}
          </strong>
          <small>
            {active?.activatedAt
              ? new Date(active.activatedAt).toLocaleTimeString()
              : 'No revision yet'}
          </small>
        </article>
      </section>

      <section className="panel revision-panel" aria-labelledby="revision-history-title">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Last known-good protection</span>
            <h2 id="revision-history-title">Revision history</h2>
          </div>
          <History size={18} className="muted-icon" />
        </div>
        {revisions.data?.revisions.length ? (
          <div className="revision-list">
            {revisions.data.revisions.map((revision) => (
              <article className="revision-row" key={revision.id}>
                <div className="revision-row__identity">
                  <strong>#{revision.revisionNumber}</strong>
                  <StatusPill tone={revisionTone(revision.status)}>{revision.status}</StatusPill>
                </div>
                <div className="revision-row__meta">
                  <span>{revision.reason === 'rollback' ? 'Rollback' : 'Desired state'}</span>
                  <small>
                    {revision.sourceCount} sources · {revision.checkCount} checks ·{' '}
                    {shortHash(revision.contentHash)}
                  </small>
                </div>
                <div className="revision-row__author">
                  <span>{revision.createdBy ?? 'System'}</span>
                  <small>{new Date(revision.createdAt).toLocaleString()}</small>
                </div>
                <div className="revision-row__actions">
                  <details className="config-preview">
                    <summary
                      aria-label={`View redacted configuration for revision ${revision.revisionNumber}`}
                    >
                      <Code2 size={16} /> Preview
                    </summary>
                    <div className="config-preview__popover">
                      <div>
                        <strong>Effective configuration</strong>
                        <span>Secrets are redacted</span>
                      </div>
                      <pre>{revision.effectiveConfig}</pre>
                    </div>
                  </details>
                  {canOperate && revision.status === 'superseded' ? (
                    <Button
                      variant="secondary"
                      size="small"
                      icon={<RotateCcw size={14} />}
                      disabled={busy}
                      onClick={() => rollback.mutate(revision.id)}
                    >
                      Roll back
                    </Button>
                  ) : null}
                </div>
                {revision.error ? <p className="revision-row__error">{revision.error}</p> : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="quiet-state">
            <History size={23} />
            <strong>No configuration revisions yet</strong>
            <span>Apply the desired state to generate the first managed revision.</span>
          </div>
        )}
      </section>
    </div>
  )
}
