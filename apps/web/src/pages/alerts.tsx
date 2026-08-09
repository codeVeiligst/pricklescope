import {
  ALERT_METRICS,
  type AlertMetric,
  type AlertPreview,
  type AlertRule,
  type Job,
  type UpsertAlertRuleRequest,
} from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'

// One catalogue, shared with the SQL builder, so a measurement cannot be named
// one thing here and another in the rule Grafana evaluates.
const METRICS = Object.entries(ALERT_METRICS).map(([value, metric]) => ({
  value: value as AlertMetric,
  label: metric.label,
}))

const PER_INTERFACE = new Set(
  Object.entries(ALERT_METRICS)
    .filter(([, metric]) => metric.supportsInterface)
    .map(([value]) => value),
)

function stateTone(state: string) {
  if (state === 'firing' || state === 'alerting') return 'negative' as const
  if (state === 'pending') return 'warning' as const
  if (state === 'normal' || state === 'inactive') return 'positive' as const
  return 'neutral' as const
}

function ruleFromForm(values: FormData): UpsertAlertRuleRequest {
  const recovery = formString(values, 'recoveryThreshold').trim()
  const ifIndex = formString(values, 'ifIndex').trim()
  const contactPointId = formString(values, 'contactPointId')
  return {
    name: formString(values, 'name'),
    sourceId: formString(values, 'sourceId') || null,
    ifIndex: ifIndex || null,
    metric: formString(values, 'metric') as UpsertAlertRuleRequest['metric'],
    reducer: formString(values, 'reducer') as UpsertAlertRuleRequest['reducer'],
    comparison: formString(values, 'comparison') as UpsertAlertRuleRequest['comparison'],
    threshold: Number(formString(values, 'threshold')),
    recoveryThreshold: recovery === '' ? null : Number(recovery),
    evaluationIntervalSeconds: Number(formString(values, 'evaluationIntervalSeconds')),
    pendingSeconds: Number(formString(values, 'pendingSeconds')),
    lookbackSeconds: Number(formString(values, 'lookbackSeconds')),
    noDataState: formString(values, 'noDataState') as UpsertAlertRuleRequest['noDataState'],
    execErrorState: formString(
      values,
      'execErrorState',
    ) as UpsertAlertRuleRequest['execErrorState'],
    severity: formString(values, 'severity') as UpsertAlertRuleRequest['severity'],
    contactPointId: contactPointId || null,
  }
}

export function AlertsPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('Alerts')
  const { session, csrfToken } = useAuth()
  const canOperate = session?.user.role !== 'viewer'
  const queryClient = useQueryClient()
  const [ruleDialog, setRuleDialog] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [preview, setPreview] = useState<AlertPreview | null>(null)
  const [job, setJob] = useState<Job | null>(null)

  const overview = useQuery({ queryKey: ['alerts'], queryFn: api.alerts, refetchInterval: 15_000 })
  const rules = useQuery({ queryKey: ['alert-rules'], queryFn: api.alertRules })
  const contacts = useQuery({ queryKey: ['contact-points'], queryFn: api.contactPoints })
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() })

  const jobQuery = useQuery({
    queryKey: ['job', job?.id],
    queryFn: () => api.job(job!.id),
    enabled: Boolean(job),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && ['succeeded', 'failed', 'cancelled'].includes(status) ? false : 700
    },
  })
  const terminal = Boolean(
    jobQuery.data?.status && ['succeeded', 'failed', 'cancelled'].includes(jobQuery.data.status),
  )
  useEffect(() => {
    if (!terminal) return
    void queryClient.invalidateQueries({ queryKey: ['alerts'] })
  }, [queryClient, terminal])

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['alert-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['alerts'] }),
      queryClient.invalidateQueries({ queryKey: ['contact-points'] }),
    ])
  }

  const saveRule = useMutation({
    mutationFn: (request: UpsertAlertRuleRequest) =>
      editing
        ? api.updateAlertRule(editing.id, request, csrfToken!)
        : api.createAlertRule(request, csrfToken!),
    onSuccess: async () => {
      setRuleDialog(false)
      setEditing(null)
      setPreview(null)
      await invalidate()
    },
  })
  const previewRule = useMutation({
    mutationFn: (request: UpsertAlertRuleRequest) => api.previewAlertRule(request, csrfToken!),
    onSuccess: setPreview,
  })
  const removeRule = useMutation({
    mutationFn: (id: string) => api.deleteAlertRule(id, csrfToken!),
    onSuccess: invalidate,
  })
  const reconcile = useMutation({
    mutationFn: () => api.reconcileAlerts(csrfToken!),
    onSuccess: setJob,
  })

  const busy = reconcile.isPending || (Boolean(job) && !terminal)
  const stateFor = (rule: AlertRule) =>
    overview.data?.states.find((entry) => entry.ruleId === rule.id)?.state ?? 'unknown'

  function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    saveRule.mutate(ruleFromForm(new FormData(event.currentTarget)))
  }

  function openRule(rule: AlertRule | null) {
    setEditing(rule)
    setPreview(null)
    saveRule.reset()
    previewRule.reset()
    setRuleDialog(true)
  }

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Alerts</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Alerting status">
        <div>
          <BellRing size={18} />
          <span>
            <strong>{overview.data?.ruleCount ?? 0}</strong> rules ·{' '}
            <strong>{overview.data?.contactPointCount ?? 0}</strong>{' '}
            <Link to="/contacts">contacts</Link> · evaluated by Grafana
          </span>
        </div>
        <div className="toolbar-actions">
          {canOperate ? (
            <Button icon={<Plus size={17} />} onClick={() => openRule(null)}>
              Add rule
            </Button>
          ) : null}
          {session?.user.role === 'administrator' ? (
            <Button
              variant="secondary"
              icon={busy ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              disabled={busy}
              onClick={() => reconcile.mutate()}
            >
              {busy ? 'Applying…' : 'Apply to Grafana'}
            </Button>
          ) : null}
        </div>
      </section>

      <FormError
        error={
          overview.error ??
          rules.error ??
          removeRule.error ??
          reconcile.error ??
          (jobQuery.data?.error ? new Error(jobQuery.data.error) : null)
        }
      />

      {rules.data?.rules.length ? (
        <section className="resource-list" aria-label="Alert rules">
          {rules.data.rules.map((rule) => (
            <article className="resource-list-row" key={rule.id}>
              <span className="resource-list-row__icon">
                <BellRing size={19} />
              </span>
              <div>
                <strong>{rule.name}</strong>
                <small>
                  {rule.sourceName ?? 'All sources'} · {rule.severity} · every{' '}
                  {rule.evaluationIntervalSeconds}s for {rule.pendingSeconds}s
                </small>
              </div>
              <StatusPill tone={stateTone(stateFor(rule))}>{stateFor(rule)}</StatusPill>
              <span className="resource-count">
                {METRICS.find((metric) => metric.value === rule.metric)?.label ?? rule.metric}{' '}
                {rule.comparison === 'gt' ? '>' : '<'} {rule.threshold}
                {rule.recoveryThreshold === null ? '' : ` (clears at ${rule.recoveryThreshold})`}
              </span>
              <div className="row-actions">
                {canOperate ? (
                  <>
                    <Button
                      variant="secondary"
                      size="small"
                      icon={<Pencil size={14} />}
                      onClick={() => openRule(rule)}
                    >
                      Edit
                    </Button>
                    <button
                      className="icon-button danger-icon"
                      aria-label={`Delete ${rule.name}`}
                      onClick={() =>
                        confirm({
                          title: `Delete ${rule.name}?`,
                          body: 'The rule stops evaluating and is removed from Grafana.',
                          confirmLabel: 'Delete rule',
                          destructive: true,
                          onConfirm: () => removeRule.mutate(rule.id),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      ) : !rules.isLoading ? (
        <div className="panel resource-empty">
          <BellRing size={25} />
          <strong>No alert rules yet</strong>
          <span>A rule watches one measurement and tells Grafana when to notify.</span>
        </div>
      ) : null}

      <Modal
        title={editing ? 'Edit alert rule' : 'Add an alert rule'}
        description="PrickleScope owns the rule; Grafana evaluates it and sends the notification."
        open={ruleDialog}
        onClose={() => setRuleDialog(false)}
      >
        <form className="resource-form" onSubmit={submitRule}>
          <label className="field">
            <span>Name</span>
            <input name="name" required maxLength={128} defaultValue={editing?.name} />
          </label>
          <label className="field">
            <span>Source</span>
            <select name="sourceId" defaultValue={editing?.sourceId ?? ''}>
              <option value="">All sources</option>
              {(sources.data?.sources ?? []).map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Measurement</span>
            <select name="metric" defaultValue={editing?.metric ?? 'availability'}>
              {METRICS.map((metric) => (
                <option key={metric.value} value={metric.value}>
                  {metric.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Interface index</span>
            <input
              name="ifIndex"
              maxLength={64}
              defaultValue={editing?.ifIndex ?? ''}
              placeholder={`Only for ${[...PER_INTERFACE].length} interface measurements`}
            />
          </label>
          <label className="field">
            <span>Reducer</span>
            <select name="reducer" defaultValue={editing?.reducer ?? 'last'}>
              <option value="last">Last</option>
              <option value="avg">Average</option>
              <option value="min">Minimum</option>
              <option value="max">Maximum</option>
            </select>
          </label>
          <label className="field">
            <span>Fires when</span>
            <select name="comparison" defaultValue={editing?.comparison ?? 'lt'}>
              <option value="gt">Greater than</option>
              <option value="lt">Less than</option>
            </select>
          </label>
          <label className="field">
            <span>Threshold</span>
            <input
              name="threshold"
              type="number"
              step="any"
              required
              defaultValue={editing?.threshold ?? 99}
            />
          </label>
          <label className="field">
            <span>Clears at (optional)</span>
            <input
              name="recoveryThreshold"
              type="number"
              step="any"
              defaultValue={editing?.recoveryThreshold ?? ''}
              placeholder="Hysteresis stops flapping"
            />
          </label>
          <label className="field">
            <span>Evaluate every (seconds)</span>
            <input
              name="evaluationIntervalSeconds"
              type="number"
              min={10}
              max={3600}
              required
              defaultValue={editing?.evaluationIntervalSeconds ?? 60}
            />
          </label>
          <label className="field">
            <span>Pending for (seconds)</span>
            <input
              name="pendingSeconds"
              type="number"
              min={0}
              max={86400}
              required
              defaultValue={editing?.pendingSeconds ?? 300}
            />
          </label>
          <label className="field">
            <span>Look back (seconds)</span>
            <input
              name="lookbackSeconds"
              type="number"
              min={60}
              max={86400}
              required
              defaultValue={editing?.lookbackSeconds ?? 600}
            />
          </label>
          <label className="field">
            <span>When there is no data</span>
            <select name="noDataState" defaultValue={editing?.noDataState ?? 'NoData'}>
              <option value="NoData">No Data</option>
              <option value="Alerting">Alerting</option>
              <option value="OK">OK</option>
              <option value="KeepLast">Keep last state</option>
            </select>
          </label>
          <label className="field">
            <span>When the query errors</span>
            <select name="execErrorState" defaultValue={editing?.execErrorState ?? 'Error'}>
              <option value="Error">Error</option>
              <option value="Alerting">Alerting</option>
              <option value="OK">OK</option>
              <option value="KeepLast">Keep last state</option>
            </select>
          </label>
          <label className="field">
            <span>Severity</span>
            <select name="severity" defaultValue={editing?.severity ?? 'warning'}>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="field">
            <span>Notify</span>
            <select name="contactPointId" defaultValue={editing?.contactPointId ?? ''}>
              <option value="">No notification</option>
              {(contacts.data?.contactPoints ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </label>

          {preview ? (
            <div className="alert-preview" role="status">
              <strong>
                {preview.wouldFire ? 'Would fire now' : 'Would stay quiet now'} ·{' '}
                {preview.sampleCount} samples
              </strong>
              {preview.series.map((entry) => (
                <span key={entry.name}>
                  {entry.name}: {entry.value ?? 'no data'}
                  {entry.wouldFire ? ' — firing' : ''}
                </span>
              ))}
            </div>
          ) : null}

          <FormError error={saveRule.error ?? previewRule.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setRuleDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              disabled={previewRule.isPending}
              onClick={(event) => {
                const form = (event.currentTarget as HTMLElement).closest('form')
                if (form) previewRule.mutate(ruleFromForm(new FormData(form)))
              }}
            >
              {previewRule.isPending ? 'Checking…' : 'Preview'}
            </Button>
            <Button type="submit" disabled={saveRule.isPending}>
              {saveRule.isPending ? 'Saving…' : 'Save rule'}
            </Button>
          </div>
        </form>
      </Modal>

      {confirmDialog}
    </div>
  )
}
