import type { Graph } from '@pricklescope/contracts'
import { TimeSeriesChart } from '@pricklescope/ui'
import { ExternalLink } from 'lucide-react'

import { grafanaUrl, type GrafanaVariables } from '../grafana.js'
import { useDocumentTheme } from '../hooks.js'

// PrickleScope draws the graph itself. Grafana holds the same dashboards for
// deeper exploration, which is what the corner link opens.
export function GraphPanel({
  title,
  graph,
  dashboardUid,
  panelId,
  variables,
  height,
  fill,
}: {
  title: string
  graph: Graph | undefined
  dashboardUid: string
  panelId?: number
  variables?: GrafanaVariables
  height?: number
  fill?: boolean
}) {
  const theme = useDocumentTheme()
  const open = grafanaUrl(dashboardUid, variables, panelId ? { panelId } : {})
  return (
    <section className="graph-panel">
      <div className="graph-panel__bar">
        <h3>{title}</h3>
        <a href={open} target="_blank" rel="noreferrer">
          Open in Grafana <ExternalLink size={14} />
        </a>
      </div>
      {graph ? (
        <TimeSeriesChart
          timestamps={graph.timestamps}
          series={graph.series}
          unit={graph.unit}
          theme={theme}
          {...(height === undefined ? {} : { height })}
          {...(fill === undefined ? {} : { fill })}
        />
      ) : (
        <div className="chart-empty" style={{ height: height ?? 232 }}>
          Loading…
        </div>
      )}
      {graph?.truncated ? (
        <p className="graph-panel__note">Showing the busiest series. Grafana holds the full set.</p>
      ) : null}
    </section>
  )
}
