import type { DependencyHealth, JobStatus } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowUpRight, CheckCircle2, Clock3, RefreshCw, ServerCog } from 'lucide-react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useDocumentTitle } from '../hooks.js'

function dependencyTone(state: DependencyHealth['state']) {
  return state === 'up' ? 'positive' : state === 'down' ? 'negative' : 'neutral'
}

/** Job types are internal identifiers; the activity feed shows what they do. */
const JOB_LABELS: Record<string, string> = {
  'system.dependencies.check': 'Dependency health check',
  'snmp.connection-test': 'SNMP connectivity test',
  'snmp.inventory': 'Device inventory',
  'collector.telegraf.reconcile': 'Apply collector configuration',
  'collector.telegraf.rollback': 'Roll back collector configuration',
  'storage.questdb.reconcile': 'Apply QuestDB retention',
  'grafana.reconcile': 'Apply Grafana dashboards',
  'alerts.reconcile': 'Apply alert rules',
}

function jobTone(status: JobStatus) {
  if (status === 'succeeded') return 'positive'
  if (status === 'failed') return 'negative'
  if (status === 'running') return 'warning'
  return 'neutral'
}

export function OverviewPage() {
  useDocumentTitle('Overview')
  const { session, csrfToken } = useAuth()
  const queryClient = useQueryClient()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 3_000 })
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() })
  const dependencyCheck = useMutation({
    mutationFn: async () => {
      if (!csrfToken) throw new Error('Missing CSRF token')
      return api.checkDependencies(csrfToken)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['health'] }), 1_000)
    },
  })

  const up = health.data?.dependencies.filter((dependency) => dependency.state === 'up').length ?? 0
  const total =
    health.data?.dependencies.filter((dependency) => dependency.state !== 'disabled').length ?? 0
  const deviceCount = sources.data?.sources.length ?? 0
  const siteCount = new Set(
    (sources.data?.sources ?? []).map((source) => source.site?.id).filter(Boolean),
  ).size
  const activeJobs =
    jobs.data?.jobs.filter((job) => job.status === 'running' || job.status === 'queued').length ?? 0

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Overview</ScreenReaderHeading>
      <section className="welcome-strip">
        <div>
          <span className="eyebrow">Live workspace</span>
          <p>Good to see you, {session?.user.displayName.split(' ')[0]}.</p>
          <small>PrickleScope is watching the control-plane dependencies.</small>
        </div>
        {session?.user.role !== 'viewer' ? (
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} className={dependencyCheck.isPending ? 'spin' : ''} />}
            onClick={() => dependencyCheck.mutate()}
            disabled={dependencyCheck.isPending}
          >
            Refresh health
          </Button>
        ) : null}
      </section>

      <section className="summary-grid" aria-label="Workspace summary">
        <article className="summary-card summary-card--accent">
          <div className="summary-card__icon">
            <CheckCircle2 size={19} />
          </div>
          <span>Dependencies online</span>
          <strong>{health.isLoading ? '—' : `${up}/${total}`}</strong>
          <small>
            {health.data?.status === 'healthy'
              ? 'All expected services responding'
              : 'Review service health below'}
          </small>
        </article>
        <article className="summary-card">
          <div className="summary-card__icon">
            <ServerCog size={19} />
          </div>
          <span>Managed devices</span>
          <strong>{sources.isLoading ? '—' : deviceCount}</strong>
          <small>
            {deviceCount === 0
              ? 'Add a device to begin collecting'
              : `Across ${siteCount} ${siteCount === 1 ? 'location' : 'locations'}`}
          </small>
        </article>
        <article className="summary-card">
          <div className="summary-card__icon">
            <Activity size={19} />
          </div>
          <span>Active work</span>
          <strong>{activeJobs}</strong>
          <small>Persisted background jobs</small>
        </article>
        <article className="summary-card">
          <div className="summary-card__icon">
            <Clock3 size={19} />
          </div>
          <span>API uptime</span>
          <strong>{health.data ? `${Math.floor(health.data.uptimeSeconds / 60)}m` : '—'}</strong>
          <small>Version {health.data?.version ?? '0.1.0'}</small>
        </article>
      </section>

      <div className="content-grid">
        <section className="panel" aria-labelledby="dependency-title">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Control plane</span>
              <h2 id="dependency-title">Service health</h2>
            </div>
            <StatusPill tone={health.data?.status === 'healthy' ? 'positive' : 'warning'}>
              {health.data?.status ?? 'Checking'}
            </StatusPill>
          </div>
          <div className="dependency-list">
            {health.isError ? (
              <div className="inline-error">Health data is temporarily unavailable.</div>
            ) : null}
            {health.data?.dependencies.map((dependency) => (
              <div className="dependency-row" key={dependency.name}>
                <span className={`service-dot service-dot--${dependency.state}`} />
                <div>
                  <strong>{dependency.name}</strong>
                  <small>
                    {dependency.message ??
                      (dependency.state === 'disabled'
                        ? 'Optional integration'
                        : 'Responding normally')}
                  </small>
                </div>
                <span>{dependency.latencyMs === null ? '—' : `${dependency.latencyMs} ms`}</span>
                <StatusPill tone={dependencyTone(dependency.state)}>{dependency.state}</StatusPill>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="activity-title">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Reconciler</span>
              <h2 id="activity-title">Recent activity</h2>
            </div>
            <ArrowUpRight size={18} className="muted-icon" />
          </div>
          <div className="activity-list">
            {jobs.data?.jobs.length ? (
              jobs.data.jobs.slice(0, 6).map((job) => (
                <div className="activity-row" key={job.id}>
                  <span className="activity-row__track">
                    <span style={{ width: `${job.progress}%` }} />
                  </span>
                  <div>
                    <strong>{JOB_LABELS[job.type] ?? job.type}</strong>
                    <small>{new Date(job.createdAt).toLocaleString()}</small>
                  </div>
                  <StatusPill tone={jobTone(job.status)}>{job.status}</StatusPill>
                </div>
              ))
            ) : (
              <div className="quiet-state">
                <Activity size={23} />
                <strong>No background activity yet</strong>
                <span>A manual health refresh will create the first persisted job.</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
