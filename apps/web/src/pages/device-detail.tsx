import {
  GRAFANA_DASHBOARDS,
  type InventoryDiff,
  type InventorySnapshot,
  type Job,
} from '@pricklescope/contracts'
import { Button, RowChart, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  BarChart3,
  Check,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Radar,
  Trash2,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { GraphPanel } from '../components/graph-panel.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { grafanaUrl } from '../grafana.js'
import { useDocumentTheme, useDocumentTitle } from '../hooks.js'
import { statusTone } from '../labels.js'

function changeCount(diff: InventoryDiff): number {
  return (
    diff.systemChanges.length +
    diff.addedInterfaces.length +
    diff.removedInterfaces.length +
    diff.changedInterfaces.length
  )
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

function DiffPreview({ snapshot }: { snapshot: InventorySnapshot }) {
  const count = changeCount(snapshot.diff)
  return (
    <div className="diff-preview">
      <div className="diff-summary">
        <span>
          <strong>{snapshot.diff.addedInterfaces.length}</strong> added
        </span>
        <span>
          <strong>{snapshot.diff.changedInterfaces.length}</strong> changed
        </span>
        <span>
          <strong>{snapshot.diff.removedInterfaces.length}</strong> removed
        </span>
      </div>
      {snapshot.diff.systemChanges.map((change) => (
        <div className="diff-line" key={`system-${change.field}`}>
          <strong>System · {change.field}</strong>
          <span>
            {displayValue(change.before)} → {displayValue(change.after)}
          </span>
        </div>
      ))}
      {snapshot.diff.addedInterfaces.map((item) => (
        <div className="diff-line diff-line--added" key={`added-${item.index}`}>
          <strong>Interface {item.index} added</strong>
          <span>{item.name ?? item.description ?? 'Unnamed'}</span>
        </div>
      ))}
      {snapshot.diff.changedInterfaces.map((item) => (
        <div className="diff-line" key={`changed-${item.index}`}>
          <strong>{item.name ?? `Interface ${item.index}`}</strong>
          <span>{item.changes.map((change) => change.field).join(', ')} changed</span>
        </div>
      ))}
      {snapshot.diff.removedInterfaces.map((item) => (
        <div className="diff-line diff-line--removed" key={`removed-${item.index}`}>
          <strong>Interface {item.index} removed</strong>
          <span>{item.name ?? item.description ?? 'Unnamed'}</span>
        </div>
      ))}
      {!count ? (
        <div className="quiet-inline">
          <Check size={16} /> No changes from applied inventory
        </div>
      ) : null}
    </div>
  )
}

export function DeviceDetailPage() {
  const { confirm, confirmDialog } = useConfirm()
  const { id = '' } = useParams()
  const theme = useDocumentTheme()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { session, csrfToken } = useAuth()
  const canOperate = session?.user.role !== 'viewer'
  const [editing, setEditing] = useState(false)
  const source = useQuery({
    queryKey: ['source', id],
    queryFn: () => api.source(id),
    enabled: Boolean(id),
  })
  const snapshots = useQuery({
    queryKey: ['inventory', id],
    queryFn: () => api.inventorySnapshots(id),
    enabled: Boolean(id),
  })
  const graphs = useQuery({
    queryKey: ['graphs', 'source', id],
    queryFn: () => api.sourceGraphs(id),
    enabled: Boolean(id),
    refetchInterval: 60_000,
  })
  // Still needed for the Open in Grafana links, which stay available.
  const grafana = useQuery({ queryKey: ['grafana'], queryFn: api.grafana })
  const interfaceGraph = useQuery({
    queryKey: ['graphs', 'interfaces', id],
    queryFn: () => api.interfaceGraphs(id),
    enabled: Boolean(id),
    refetchInterval: 60_000,
  })
  const sites = useQuery({
    queryKey: ['sites'],
    queryFn: api.sites,
    enabled: canOperate && editing,
  })
  const credentials = useQuery({
    queryKey: ['snmp-credentials'],
    queryFn: api.snmpCredentials,
    enabled: canOperate && editing,
  })
  const profiles = useQuery({
    queryKey: ['polling-profiles'],
    queryFn: api.pollingProfiles,
    enabled: canOperate && editing,
  })
  const [activeJob, setActiveJob] = useState<Job | null>(null)
  const job = useQuery({
    queryKey: ['job', activeJob?.id],
    queryFn: () => api.job(activeJob!.id),
    enabled: Boolean(activeJob?.id),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'queued' || status === 'running' ? 300 : false
    },
  })
  const test = useMutation({
    mutationFn: () => api.testSource(id, csrfToken!),
    onSuccess: setActiveJob,
  })
  const discover = useMutation({
    mutationFn: () => api.inventorySource(id, csrfToken!),
    onSuccess: setActiveJob,
  })
  const apply = useMutation({
    mutationFn: (snapshotId: string) => api.applyInventorySnapshot(snapshotId, csrfToken!),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['source', id] }),
        queryClient.invalidateQueries({ queryKey: ['sources'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory', id] }),
      ])
    },
  })
  const update = useMutation({
    mutationFn: (request: Parameters<typeof api.updateSource>[1]) =>
      api.updateSource(id, request, csrfToken!),
    onSuccess: async () => {
      setEditing(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['source', id] }),
        queryClient.invalidateQueries({ queryKey: ['sources'] }),
      ])
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteSource(id, csrfToken!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sources'] })
      void navigate('/devices')
    },
  })
  const jobStatus = job.data?.status ?? activeJob?.status
  const jobBusy = jobStatus === 'queued' || jobStatus === 'running'

  useEffect(() => {
    if (jobStatus !== 'succeeded' && jobStatus !== 'failed' && jobStatus !== 'cancelled') return
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['source', id] }),
      queryClient.invalidateQueries({ queryKey: ['sources'] }),
      queryClient.invalidateQueries({ queryKey: ['inventory', id] }),
    ])
  }, [id, jobStatus, queryClient])

  useDocumentTitle(source.data?.name ?? 'Device')
  if (source.isLoading)
    return (
      <div className="detail-loading">
        <LoaderCircle className="spin" />
      </div>
    )
  if (source.error || !source.data)
    return <FormError error={source.error ?? new Error('Device not found')} />
  const device = source.data
  const pending = snapshots.data?.snapshots.find(
    (snapshot) => snapshot.id === device.pendingSnapshotId,
  )
  const applied = snapshots.data?.snapshots.find((snapshot) => snapshot.appliedAt)
  // Keyed by if_index, so each row picks out its own inbound/outbound pair.
  const interfaceSeries = (ifIndex: string) =>
    interfaceGraph.data?.interfaces.find((entry) => entry.ifIndex === ifIndex)

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    update.mutate({
      name: formString(values, 'name'),
      target: formString(values, 'target'),
      port: Number(values.get('port')),
      transport: formString(values, 'transport') as 'udp4' | 'udp6',
      siteId: formString(values, 'siteId') || null,
      credentialId: formString(values, 'credentialId'),
      profileId: formString(values, 'profileId'),
      collectorSelection: formString(values, 'collectorSelection') as 'auto' | 'telegraf',
      tags: formString(values, 'tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
  }

  return (
    <div className="page-stack">
      <div className="object-toolbar">
        <div>
          <Link className="back-link" to="/devices">
            <ArrowLeft size={15} /> Devices
          </Link>
          <div className="object-title">
            <span className="device-avatar device-avatar--large">
              <Network size={21} />
            </span>
            <div>
              <h1>{device.systemName ?? device.name}</h1>
              <p>
                {device.target}:{device.port} · {device.site?.name ?? 'Unassigned'}
              </p>
            </div>
          </div>
        </div>
        <div className="object-actions">
          <StatusPill tone={statusTone(device.status)}>
            {device.status.replace('_', ' ')}
          </StatusPill>
          {grafana.data?.status === 'active' ? (
            <a
              className="button button--secondary button--medium"
              href={grafanaUrl(GRAFANA_DASHBOARDS.source.uid, { source_id: device.id })}
              target="_blank"
              rel="noreferrer"
            >
              <span className="button__icon">
                <BarChart3 size={16} />
              </span>
              Graphs
            </a>
          ) : null}
          {canOperate ? (
            <>
              <Button
                variant="secondary"
                icon={<Pencil size={16} />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <Button
                variant="secondary"
                icon={jobBusy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
                disabled={jobBusy || test.isPending}
                onClick={() => test.mutate()}
              >
                Test
              </Button>
              <Button
                icon={jobBusy ? <LoaderCircle className="spin" size={16} /> : <Radar size={16} />}
                disabled={jobBusy || discover.isPending}
                onClick={() => discover.mutate()}
              >
                Discover
              </Button>
              <button
                className="icon-button danger-icon"
                onClick={() => {
                  confirm({
                    title: `Remove ${device.name}?`,
                    body: 'The device, its checks, and its discovery snapshots are deleted. Metrics already in QuestDB are kept.',
                    confirmLabel: 'Remove device',
                    destructive: true,
                    onConfirm: () => remove.mutate(),
                  })
                }}
                aria-label="Remove device"
              >
                <Trash2 size={16} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <FormError
        error={test.error ?? discover.error ?? apply.error ?? update.error ?? remove.error}
      />
      {activeJob ? (
        <section className={`job-banner job-banner--${jobStatus}`} aria-live="polite">
          <div>
            {jobBusy ? (
              <LoaderCircle className="spin" size={17} />
            ) : jobStatus === 'succeeded' ? (
              <Check size={17} />
            ) : (
              <Radar size={17} />
            )}
            <span>
              <strong>
                {activeJob.type === 'snmp.inventory' ? 'Inventory discovery' : 'Connection test'}
              </strong>
              <small>
                {job.data?.error ?? (jobBusy ? `${job.data?.progress ?? 0}% complete` : jobStatus)}
              </small>
            </span>
          </div>
          {jobBusy ? (
            <span className="job-progress">
              <i style={{ width: `${job.data?.progress ?? 0}%` }} />
            </span>
          ) : null}
        </section>
      ) : null}

      <section className="detail-grid">
        <article className="panel detail-card">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Identity</span>
              <h2>What the device reported</h2>
            </div>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Name</dt>
              <dd>{device.systemName ?? 'Not discovered'}</dd>
            </div>
            <div>
              <dt>Description</dt>
              <dd>{device.systemDescription ?? 'Not discovered'}</dd>
            </div>
            <div>
              <dt>Object ID</dt>
              <dd>{device.sysObjectId ?? 'Not discovered'}</dd>
            </div>
            <div>
              <dt>SNMP</dt>
              <dd>
                v{device.credential.version} · {device.credential.name}
              </dd>
            </div>
          </dl>
        </article>
        <article className="panel detail-card">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Polling</span>
              <h2>How it is collected</h2>
            </div>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Collector</dt>
              <dd>
                {device.collector === 'telegraf' ? 'Telegraf' : 'Grafana Alloy'}{' '}
                {device.collectorSelection === 'auto' ? '· Auto' : ''}
              </dd>
            </div>
            <div>
              <dt>Profile</dt>
              <dd>{device.profile.name}</dd>
            </div>
            <div>
              <dt>Interval</dt>
              <dd>{device.profile.intervalSeconds} seconds</dd>
            </div>
            <div>
              <dt>Last test</dt>
              <dd>{device.lastTestAt ? new Date(device.lastTestAt).toLocaleString() : 'Never'}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="graph-grid" aria-label="Source graphs">
        <GraphPanel
          title="Availability"
          graph={graphs.data?.availability}
          dashboardUid={GRAFANA_DASHBOARDS.source.uid}
          panelId={1}
          variables={{ source_id: device.id }}
          fill
        />
        <GraphPanel
          title="Latency"
          graph={graphs.data?.latency}
          dashboardUid={GRAFANA_DASHBOARDS.source.uid}
          panelId={2}
          variables={{ source_id: device.id }}
        />
      </section>
      <section className="graph-grid graph-grid--wide" aria-label="Interface traffic">
        <GraphPanel
          title="Interface traffic"
          graph={graphs.data?.traffic}
          dashboardUid={GRAFANA_DASHBOARDS.source.uid}
          panelId={3}
          variables={{ source_id: device.id }}
          height={280}
        />
      </section>

      {pending ? (
        <section className="panel snapshot-review">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Review required</span>
              <h2>Discovery from {new Date(pending.observedAt).toLocaleString()}</h2>
            </div>
            <div className="snapshot-actions">
              {pending.partial ? (
                <StatusPill tone="warning">Partial</StatusPill>
              ) : (
                <StatusPill tone="positive">Complete</StatusPill>
              )}
              {canOperate ? (
                <Button
                  size="small"
                  icon={<Check size={15} />}
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(pending.id)}
                >
                  Apply inventory
                </Button>
              ) : null}
            </div>
          </div>
          {pending.errors.length ? (
            <div className="snapshot-errors">{pending.errors.join(' · ')}</div>
          ) : null}
          <DiffPreview snapshot={pending} />
          <div className="interface-table">
            <div className="interface-table__head">
              <span>Interface</span>
              <span>Alias</span>
              <span>Speed</span>
              <span>State</span>
            </div>
            {pending.interfaces.map((item) => (
              <div className="interface-row" key={item.index}>
                <span>
                  <strong>{item.name ?? item.description ?? `Interface ${item.index}`}</strong>
                  <small>
                    Index {item.index} · {item.macAddress ?? 'No MAC'}
                  </small>
                </span>
                <span>{item.alias ?? '—'}</span>
                <span>{item.speedBps ? `${item.speedBps / 1_000_000} Mbps` : '—'}</span>
                <span>
                  <StatusPill tone={item.operStatus === 1 ? 'positive' : 'neutral'}>
                    {item.operStatus === 1 ? 'up' : item.operStatus === 2 ? 'down' : 'unknown'}
                  </StatusPill>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : applied ? (
        <section className="panel applied-inventory applied-inventory--expanded">
          <div className="applied-inventory__summary">
            <div>
              <Check size={18} />
              <span>
                <strong>{applied.interfaces.length} interfaces in applied inventory</strong>
                <small>Last applied {new Date(applied.appliedAt!).toLocaleString()}</small>
              </span>
            </div>
            <span>No pending changes</span>
          </div>
          <div className="interface-table">
            <div className="interface-table__head interface-table__head--graphs">
              <span>Interface</span>
              <span>Alias</span>
              <span>Speed</span>
              <span>State</span>
              <span />
            </div>
            {applied.interfaces.map((item) => (
              <div className="interface-entry" key={item.index}>
                <div className="interface-row interface-row--graphs">
                  <span>
                    <strong>{item.name ?? item.description ?? `Interface ${item.index}`}</strong>
                    <small>Index {item.index}</small>
                  </span>
                  <span>{item.alias ?? '—'}</span>
                  <span>{item.speedBps ? `${item.speedBps / 1_000_000} Mbps` : '—'}</span>
                  <span>
                    <StatusPill tone={item.operStatus === 1 ? 'positive' : 'neutral'}>
                      {item.operStatus === 1 ? 'up' : item.operStatus === 2 ? 'down' : 'unknown'}
                    </StatusPill>
                  </span>
                  <span>
                    {grafana.data?.status === 'active' ? (
                      <a
                        className="icon-button"
                        href={grafanaUrl(GRAFANA_DASHBOARDS.interface.uid, {
                          source_id: device.id,
                          if_index: String(item.index),
                        })}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Graph ${item.name ?? `interface ${item.index}`}`}
                      >
                        <BarChart3 size={15} />
                      </a>
                    ) : null}
                  </span>
                </div>
                <RowChart
                  timestamps={interfaceGraph.data?.timestamps ?? []}
                  inbound={interfaceSeries(String(item.index))?.inbound ?? []}
                  outbound={interfaceSeries(String(item.index))?.outbound ?? []}
                  unit={interfaceGraph.data?.unit ?? 'bps'}
                  theme={theme}
                  label={`Traffic for ${item.name ?? `interface ${item.index}`} over 6 hours`}
                />
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel resource-empty">
          <Radar size={25} />
          <strong>No inventory snapshot yet</strong>
          <span>Run discovery to preview system identity and IF-MIB interfaces.</span>
        </section>
      )}
      <Modal
        title="Edit device"
        description="Changing the address resets its reachability status."
        open={editing}
        onClose={() => setEditing(false)}
      >
        <form className="resource-form" onSubmit={submitEdit}>
          <div className="form-grid">
            <label className="field field--wide">
              <span>Name</span>
              <input name="name" required defaultValue={device.name} />
            </label>
            <label className="field">
              <span>Hostname or IP</span>
              <input name="target" required defaultValue={device.target} />
            </label>
            <label className="field">
              <span>Port</span>
              <input
                name="port"
                type="number"
                min={1}
                max={65535}
                required
                defaultValue={device.port}
              />
            </label>
            <label className="field">
              <span>Transport</span>
              <select name="transport" defaultValue={device.transport}>
                <option value="udp4">UDP / IPv4</option>
                <option value="udp6">UDP / IPv6</option>
              </select>
            </label>
            <label className="field">
              <span>Site</span>
              <select name="siteId" defaultValue={device.site?.id ?? ''}>
                <option value="">Unassigned</option>
                {sites.data?.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.path.map((part) => part.name).join(' / ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>SNMP credential</span>
              <select name="credentialId" defaultValue={device.credential.id}>
                {credentials.data?.credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name} · v{credential.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Polling profile</span>
              <select name="profileId" defaultValue={device.profile.id}>
                {profiles.data?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Collector</span>
              <select
                name="collectorSelection"
                defaultValue={
                  device.collectorSelection === 'alloy' ? 'auto' : device.collectorSelection
                }
              >
                <option value="auto">Auto · recommended</option>
                <option value="telegraf">Telegraf</option>
              </select>
            </label>
            <label className="field field--wide">
              <span>Tags</span>
              <input name="tags" defaultValue={device.tags.join(', ')} />
            </label>
          </div>
          <FormError error={update.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  )
}
