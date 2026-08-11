import { Type, type Static } from '@sinclair/typebox'

export const GRAFANA_FOLDER_UID = 'pricklescope'
export const GRAFANA_DATASOURCE_UID = 'pricklescope-questdb'
// `panels` is the display catalogue the controller renders as individual images,
// so a page never embeds a whole dashboard with Grafana's own chrome around it.
// An adapter test asserts it still matches the panels the reconciler generates.
export const GRAFANA_DASHBOARDS = {
  fleet: {
    uid: 'pricklescope-fleet',
    title: 'Fleet overview',
    panels: [
      { id: 1, title: 'Availability' },
      { id: 2, title: 'Sources reporting' },
      { id: 3, title: 'Latest sources' },
    ],
  },
  source: {
    uid: 'pricklescope-source',
    title: 'Source detail',
    panels: [
      { id: 1, title: 'Availability' },
      { id: 2, title: 'Latency' },
      { id: 3, title: 'Interface traffic' },
    ],
  },
  interface: {
    uid: 'pricklescope-interface',
    title: 'Interface detail',
    panels: [
      { id: 1, title: 'Throughput' },
      { id: 2, title: 'Errors' },
      { id: 3, title: 'Current state' },
    ],
  },
  health: {
    uid: 'pricklescope-health',
    title: 'Pipeline health',
    panels: [
      { id: 1, title: 'Buffered metrics' },
      { id: 2, title: 'Pipeline errors' },
      { id: 3, title: 'Metrics written' },
      { id: 4, title: 'Metrics dropped' },
    ],
  },
} as const

export const GrafanaDashboardKeySchema = Type.Union([
  Type.Literal('fleet'),
  Type.Literal('source'),
  Type.Literal('interface'),
  Type.Literal('health'),
])
export type GrafanaDashboardKey = Static<typeof GrafanaDashboardKeySchema>

export const GrafanaManagedResourceSchema = Type.Object({
  uid: Type.String(),
  type: Type.Union([
    Type.Literal('datasource'),
    Type.Literal('folder'),
    Type.Literal('dashboard'),
    Type.Literal('alert_rule'),
    Type.Literal('contact_point'),
  ]),
  title: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('failed')]),
  revision: Type.Integer({ minimum: 1 }),
  reconciledAt: Type.String({ format: 'date-time' }),
})
export type GrafanaManagedResource = Static<typeof GrafanaManagedResourceSchema>

export const GrafanaDashboardSchema = Type.Object({
  key: GrafanaDashboardKeySchema,
  uid: Type.String(),
  title: Type.String(),
  path: Type.String(),
})
export type GrafanaDashboard = Static<typeof GrafanaDashboardSchema>

export const GrafanaOverviewSchema = Type.Object({
  connection: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('disabled')]),
  connectionMessage: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal('unconfigured'),
    Type.Literal('pending'),
    Type.Literal('active'),
    Type.Literal('failed'),
  ]),
  error: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 1 }),
  grafanaVersion: Type.Union([Type.String(), Type.Null()]),
  pluginVersion: Type.Union([Type.String(), Type.Null()]),
  dataSourceUid: Type.String(),
  publicPath: Type.String(),
  dashboards: Type.Array(GrafanaDashboardSchema),
  resources: Type.Array(GrafanaManagedResourceSchema),
  updatedAt: Type.String({ format: 'date-time' }),
  appliedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})
export type GrafanaOverview = Static<typeof GrafanaOverviewSchema>
