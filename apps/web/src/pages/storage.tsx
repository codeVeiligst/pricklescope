import type { StoragePolicy, StorageTable } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Boxes,
  CheckCircle2,
  Database,
  Gauge,
  History,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { FormError } from '../components/modal.js'
import { useDocumentTitle } from '../hooks.js'
import { jobIsActive } from '../labels.js'

function tierLabel(table: StorageTable): string {
  if (table.tier === 'raw') return 'Raw'
  if (table.tier === '5m') return '5 minutes'
  return '1 hour'
}

function retention(table: StorageTable): string {
  return table.ttlValue === null ? '—' : `${table.ttlValue} ${table.ttlUnit?.toLowerCase()}`
}

export function StoragePage() {
  useDocumentTitle('Storage')
  const { session, csrfToken } = useAuth()
  const administrator = session?.user.role === 'administrator'
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const [draft, setDraft] = useState<StoragePolicy | null>(null)
  const overview = useQuery({
    queryKey: ['storage'],
    queryFn: api.storage,
    refetchInterval: 15_000,
  })
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (state) => (jobIsActive(state.state.data?.status) ? 600 : false),
  })
  const save = useMutation({
    mutationFn: (policy: StoragePolicy & { confirmShortening?: boolean }) =>
      api.updateStoragePolicy(policy, csrfToken!),
    onSuccess: (queued) => setJobId(queued.id),
  })
  const reconcile = useMutation({
    mutationFn: () => api.reconcileStorage(csrfToken!),
    onSuccess: (queued) => setJobId(queued.id),
  })

  useEffect(() => {
    if (!job.data || jobIsActive(job.data.status)) return
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['storage'] }),
      queryClient.invalidateQueries({ queryKey: ['jobs'] }),
    ])
  }, [job.data, queryClient])

  const current = overview.data?.policy
  const policyDraft = draft ?? current ?? null
  const shortened = Boolean(
    policyDraft &&
    current &&
    (policyDraft.rawRetentionDays < current.rawRetentionDays ||
      policyDraft.fiveMinuteRetentionDays < current.fiveMinuteRetentionDays ||
      policyDraft.hourlyRetentionDays < current.hourlyRetentionDays),
  )
  const busy = save.isPending || reconcile.isPending || jobIsActive(job.data?.status)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!policyDraft) return
    const values = new FormData(event.currentTarget)
    save.mutate({
      ...policyDraft,
      ...(shortened ? { confirmShortening: values.get('confirmShortening') === 'on' } : {}),
    })
  }

  function update(key: keyof StoragePolicy, value: string) {
    setDraft((existing) => ({
      ...(existing ??
        current ?? {
          rawRetentionDays: 30,
          fiveMinuteRetentionDays: 365,
          hourlyRetentionDays: 1825,
        }),
      [key]: Number(value),
    }))
  }

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Storage</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Storage tools">
        <div>
          <Database size={18} />
          <span>
            QuestDB is <strong>{overview.data?.connection ?? 'checking'}</strong> · policy revision{' '}
            <strong>{overview.data?.revision ?? '—'}</strong>
          </span>
        </div>
        {administrator ? (
          <Button
            variant="secondary"
            icon={<RefreshCw size={17} className={busy ? 'spin' : ''} />}
            disabled={busy || overview.data?.connection === 'disabled'}
            onClick={() => reconcile.mutate()}
          >
            {busy ? 'Applying…' : 'Reconcile schema'}
          </Button>
        ) : null}
      </section>

      <FormError error={overview.error ?? save.error ?? reconcile.error ?? job.error} />
      {job.data?.status === 'failed' ? (
        <div className="inline-error">Storage reconciliation failed. {job.data.error}</div>
      ) : null}

      <section className="storage-summary" aria-label="Storage decision">
        <article className="panel storage-engine-card">
          <div className="storage-engine-card__mark">
            <Database size={25} />
          </div>
          <div>
            <span className="eyebrow">Metrics engine</span>
            <strong>QuestDB</strong>
            <small>{overview.data?.connectionMessage ?? 'Checking PGWire connection…'}</small>
          </div>
          <StatusPill tone={overview.data?.connection === 'up' ? 'positive' : 'negative'}>
            {overview.data?.connection ?? 'checking'}
          </StatusPill>
        </article>
        <article className="panel storage-decision-card">
          <CheckCircle2 size={20} />
          <div>
            <span>Architecture decision</span>
            <strong>Accepted</strong>
            <small>{overview.data?.decisionSummary}</small>
          </div>
        </article>
      </section>

      <section className="storage-workspace">
        <article className="panel storage-policy-panel">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">GUI-managed lifecycle</span>
              <h2>Retention policy</h2>
            </div>
            <StatusPill
              tone={
                overview.data?.policyStatus === 'active'
                  ? 'positive'
                  : overview.data?.policyStatus === 'failed'
                    ? 'negative'
                    : 'neutral'
              }
            >
              {overview.data?.policyStatus ?? 'loading'}
            </StatusPill>
          </div>
          {policyDraft ? (
            <form className="storage-policy-form" onSubmit={submit}>
              <label>
                <TimerReset size={18} />
                <span>
                  <strong>Raw detail</strong>
                  <small>Polling resolution</small>
                </span>
                <input
                  aria-label="Raw retention in days"
                  type="number"
                  min={1}
                  max={365}
                  disabled={!administrator || busy}
                  value={policyDraft.rawRetentionDays}
                  onChange={(event) => update('rawRetentionDays', event.target.value)}
                />
                <em>days</em>
              </label>
              <label>
                <Gauge size={18} />
                <span>
                  <strong>Normal history</strong>
                  <small>5-minute rollups</small>
                </span>
                <input
                  aria-label="Five-minute retention in days"
                  type="number"
                  min={30}
                  max={3650}
                  disabled={!administrator || busy}
                  value={policyDraft.fiveMinuteRetentionDays}
                  onChange={(event) => update('fiveMinuteRetentionDays', event.target.value)}
                />
                <em>days</em>
              </label>
              <label>
                <History size={18} />
                <span>
                  <strong>Long-term history</strong>
                  <small>Hourly rollups</small>
                </span>
                <input
                  aria-label="Hourly retention in days"
                  type="number"
                  min={365}
                  max={36500}
                  disabled={!administrator || busy}
                  value={policyDraft.hourlyRetentionDays}
                  onChange={(event) => update('hourlyRetentionDays', event.target.value)}
                />
                <em>days</em>
              </label>
              {shortened ? (
                <label className="storage-retention-warning">
                  <input name="confirmShortening" type="checkbox" required />
                  <TriangleAlert size={17} />
                  <span>
                    <strong>Confirm shorter retention</strong>
                    <small>Expired partitions become eligible for deletion after apply.</small>
                  </span>
                </label>
              ) : null}
              {administrator ? (
                <div className="storage-policy-actions">
                  <span>
                    Last applied{' '}
                    {overview.data?.appliedAt
                      ? new Date(overview.data.appliedAt).toLocaleString()
                      : 'never'}
                  </span>
                  <Button type="submit" disabled={busy}>
                    Save and apply
                  </Button>
                </div>
              ) : null}
            </form>
          ) : null}
        </article>

        <article className="panel storage-capability-panel">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Spike evidence</span>
              <h2>Safety properties</h2>
            </div>
            <ShieldCheck size={19} className="muted-icon" />
          </div>
          <div className="storage-capability-list">
            {overview.data?.capabilities.map((capability) => (
              <div key={capability.key}>
                <CheckCircle2 size={17} />
                <span>
                  <strong>{capability.label}</strong>
                  <small>{capability.evidence}</small>
                </span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="panel storage-schema-panel" aria-labelledby="storage-schema-title">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Controller-owned schema</span>
            <h2 id="storage-schema-title">Metric families and rollups</h2>
          </div>
          <Boxes size={19} className="muted-icon" />
        </div>
        {overview.data?.tables.length ? (
          <div className="storage-table-list">
            <div className="storage-table-list__head">
              <span>Table</span>
              <span>Resolution</span>
              <span>Retention</span>
              <span>Rows</span>
              <span>Status</span>
            </div>
            {overview.data.tables.map((table) => (
              <div className="storage-table-row" key={table.name}>
                <code>{table.name}</code>
                <span>{tierLabel(table)}</span>
                <span>{retention(table)}</span>
                <span>{table.rowCount?.toLocaleString() ?? '—'}</span>
                <StatusPill tone={table.exists ? 'positive' : 'neutral'}>
                  {table.exists ? (table.materializedView ? 'rollup' : 'ready') : 'pending'}
                </StatusPill>
              </div>
            ))}
          </div>
        ) : (
          <div className="quiet-state">
            <Boxes size={23} />
            <strong>No managed tables reported</strong>
            <span>Connect QuestDB, then reconcile the schema.</span>
          </div>
        )}
      </section>
    </div>
  )
}
