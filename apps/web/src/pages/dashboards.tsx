import { GRAFANA_DASHBOARDS, type Job } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatTile, StatusPill } from '@pricklescope/ui'
import { ExternalLink, LayoutDashboard, LoaderCircle, RefreshCw } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { GraphPanel } from '../components/graph-panel.js'
import { FormError } from '../components/modal.js'
import { grafanaUrl } from '../grafana.js'
import { useDocumentTitle } from '../hooks.js'

function statusTone(status: string) {
  if (status === 'active') return 'positive' as const
  if (status === 'pending') return 'warning' as const
  if (status === 'failed') return 'negative' as const
  return 'neutral' as const
}

export function DashboardsPage() {
  useDocumentTitle('Dashboards')
  const { session, csrfToken } = useAuth()
  const queryClient = useQueryClient()
  const [job, setJob] = useState<Job | null>(null)
  const fleet = useQuery({
    queryKey: ['graphs', 'fleet'],
    queryFn: api.fleetGraphs,
    refetchInterval: 60_000,
  })
  const overview = useQuery({
    queryKey: ['grafana'],
    queryFn: api.grafana,
    refetchInterval: 30_000,
  })
  const jobQuery = useQuery({
    queryKey: ['job', job?.id],
    queryFn: () => api.job(job!.id),
    enabled: Boolean(job),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && ['succeeded', 'failed', 'cancelled'].includes(status) ? false : 700
    },
  })
  const reconcile = useMutation({
    mutationFn: () => api.reconcileGrafana(csrfToken!),
    onSuccess: (created) => setJob(created),
  })
  const terminal = Boolean(
    jobQuery.data?.status && ['succeeded', 'failed', 'cancelled'].includes(jobQuery.data.status),
  )
  useEffect(() => {
    if (!terminal || !job) return
    void queryClient.invalidateQueries({ queryKey: ['grafana'] })
  }, [job, queryClient, terminal])
  const data = overview.data
  const busy = reconcile.isPending || (Boolean(job) && !terminal)

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Dashboards</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Grafana workspace status">
        <div>
          <LayoutDashboard size={18} />
          <span>
            <strong>
              {data?.resources.filter((item) => item.status === 'active').length ?? 0}
            </strong>{' '}
            managed resources · {data?.connectionMessage ?? 'Checking Grafana'}
          </span>
        </div>
        <div className="toolbar-actions">
          {data ? <StatusPill tone={statusTone(data.status)}>{data.status}</StatusPill> : null}
          {session?.user.role === 'administrator' ? (
            <Button
              size="small"
              variant="secondary"
              icon={busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              disabled={busy}
              onClick={() => reconcile.mutate()}
            >
              {busy ? 'Applying…' : data?.status === 'active' ? 'Reconcile' : 'Set up Grafana'}
            </Button>
          ) : null}
        </div>
      </section>
      <FormError
        error={
          overview.error ??
          reconcile.error ??
          (jobQuery.data?.error ? new Error(jobQuery.data.error) : null)
        }
      />

      <section className="dashboard-link-grid" aria-label="Managed dashboards">
        {(data?.dashboards ?? []).map((dashboard) => (
          <a
            className="dashboard-link-card"
            href={grafanaUrl(dashboard.uid)}
            target="_blank"
            rel="noreferrer"
            key={dashboard.uid}
          >
            <LayoutDashboard size={18} />
            <span>
              <strong>{dashboard.title}</strong>
              <small>{dashboard.uid}</small>
            </span>
            <ExternalLink size={15} />
          </a>
        ))}
      </section>

      <section className="graph-grid" aria-label="Fleet overview graphs">
        <GraphPanel
          title="Availability"
          graph={fleet.data?.availability}
          dashboardUid={GRAFANA_DASHBOARDS.fleet.uid}
          panelId={1}
          height={252}
        />
        <section className="graph-panel">
          <div className="graph-panel__bar">
            <h3>Sources reporting</h3>
          </div>
          <StatTile value={fleet.data?.sourcesReporting ?? null} caption="in the last 6 hours" />
        </section>
      </section>

      <section className="graph-panel" aria-label="Latest sources">
        <div className="graph-panel__bar">
          <h3>Latest sources</h3>
          <a href={grafanaUrl(GRAFANA_DASHBOARDS.fleet.uid)} target="_blank" rel="noreferrer">
            Open in Grafana <ExternalLink size={14} />
          </a>
        </div>
        {fleet.data?.latestSources.length ? (
          <table className="graph-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Identifier</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {fleet.data.latestSources.map((row) => (
                <tr key={row.sourceId}>
                  <td>{row.sourceName}</td>
                  <td>{row.sourceId}</td>
                  <td>{new Date(row.lastSeen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="chart-empty" style={{ height: 120 }}>
            No sources have reported in this range
          </div>
        )}
      </section>

      {data?.status === 'active' ? null : (
        <section className="panel grafana-empty">
          <LayoutDashboard size={26} />
          <strong>Grafana workspace is not ready</strong>
          <span>
            An administrator can apply the stable datasource and four managed dashboards here.
          </span>
        </section>
      )}
    </div>
  )
}
