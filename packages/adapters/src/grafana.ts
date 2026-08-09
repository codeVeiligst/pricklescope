import { createHash } from 'node:crypto'

import {
  GRAFANA_DASHBOARDS,
  GRAFANA_SERIES_COLORS,
  TRAFFIC_FILL_OPACITY,
  GRAFANA_DATASOURCE_UID,
  GRAFANA_FOLDER_UID,
  type GrafanaDashboardKey,
} from '@pricklescope/contracts'

const datasource = { type: 'questdb-questdb-datasource', uid: GRAFANA_DATASOURCE_UID }

export interface GrafanaDataSourceInput {
  server: string
  port: number
  username: string
  password: string
}

export interface GrafanaServiceAccount {
  id: number
  name: string
  login: string
  role: string
  tokens?: number
}

export interface GrafanaServiceAccountToken {
  id: number
  name: string
  key: string
}

export interface GrafanaDataSourceHealth {
  status: string
  message?: string
}

export interface GrafanaResourceDefinition {
  uid: string
  type: 'datasource' | 'folder' | 'dashboard' | 'alert_rule' | 'contact_point'
  title: string
  folderUid: string | null
  contentHash: string
  body: Record<string, unknown>
}

type GrafanaAuthentication =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'none' }

export class GrafanaApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'GrafanaApiError'
  }
}

export class GrafanaApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authentication: GrafanaAuthentication,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  static basic(
    baseUrl: string,
    username: string,
    password: string,
    fetchImplementation?: typeof fetch,
  ): GrafanaApiClient {
    return new GrafanaApiClient(baseUrl, { kind: 'basic', username, password }, fetchImplementation)
  }

  static bearer(
    baseUrl: string,
    token: string,
    fetchImplementation?: typeof fetch,
  ): GrafanaApiClient {
    return new GrafanaApiClient(baseUrl, { kind: 'bearer', token }, fetchImplementation)
  }

  static anonymous(baseUrl: string, fetchImplementation?: typeof fetch): GrafanaApiClient {
    return new GrafanaApiClient(baseUrl, { kind: 'none' }, fetchImplementation)
  }

  async health(): Promise<{ version: string }> {
    return this.request('/api/health')
  }

  async verifyOrganizationAccess(): Promise<void> {
    await this.request('/api/org')
  }

  async findServiceAccount(name: string): Promise<GrafanaServiceAccount | null> {
    const result = await this.request<{ serviceAccounts: GrafanaServiceAccount[] }>(
      `/api/serviceaccounts/search?perpage=100&page=1&query=${encodeURIComponent(name)}`,
    )
    return result.serviceAccounts.find((account) => account.name === name) ?? null
  }

  createServiceAccount(name: string): Promise<GrafanaServiceAccount> {
    return this.request('/api/serviceaccounts', {
      method: 'POST',
      body: { name, role: 'Admin', isDisabled: false },
    })
  }

  updateServiceAccount(id: number, name: string): Promise<GrafanaServiceAccount> {
    return this.request(`/api/serviceaccounts/${id}`, {
      method: 'PATCH',
      body: { name, role: 'Admin', isDisabled: false },
    })
  }

  createServiceAccountToken(id: number, name: string): Promise<GrafanaServiceAccountToken> {
    return this.request(`/api/serviceaccounts/${id}/tokens`, {
      method: 'POST',
      body: { name, secondsToLive: 0 },
    })
  }

  async pluginVersion(pluginId: string): Promise<string> {
    const result = await this.request<{ info?: { version?: string } }>(
      `/api/plugins/${encodeURIComponent(pluginId)}/settings`,
    )
    return result.info?.version ?? 'unknown'
  }

  async dataSource(uid: string): Promise<Record<string, unknown> | null> {
    return this.requestOrNull(`/api/datasources/uid/${encodeURIComponent(uid)}`)
  }

  async upsertDataSource(input: GrafanaDataSourceInput): Promise<void> {
    const body = grafanaDataSource(input)
    const current = await this.dataSource(GRAFANA_DATASOURCE_UID)
    if (current?.readOnly === true) {
      throw new Error(
        'The stable QuestDB datasource is still owned by legacy file provisioning; remove that provisioning before reconciling',
      )
    }
    await this.request(
      current ? `/api/datasources/uid/${GRAFANA_DATASOURCE_UID}` : '/api/datasources',
      { method: current ? 'PUT' : 'POST', body },
    )
  }

  /**
   * The datasource's own verdict on whether it can reach QuestDB.
   *
   * Read tolerantly: Grafana answers 400 with a perfectly good body when the
   * datasource cannot connect, and that is the answer this endpoint exists to
   * give. Treating it as a transport failure turns "the password is wrong" into
   * "Grafana is unreachable", which points at the wrong thing entirely.
   */
  async dataSourceHealth(): Promise<GrafanaDataSourceHealth> {
    const body = await this.requestAnyStatus<GrafanaDataSourceHealth>(
      `/api/datasources/uid/${GRAFANA_DATASOURCE_UID}/health`,
    )
    return body ?? { status: 'ERROR', message: 'Grafana returned no health payload' }
  }

  async ensureFolder(): Promise<void> {
    const current = await this.requestOrNull(`/api/folders/${GRAFANA_FOLDER_UID}`)
    await this.request(current ? `/api/folders/${GRAFANA_FOLDER_UID}` : '/api/folders', {
      method: current ? 'PUT' : 'POST',
      // The controller owns this folder, so an update replaces whatever version
      // Grafana currently stores instead of failing the reconcile on a conflict.
      body: { uid: GRAFANA_FOLDER_UID, title: 'PrickleScope managed', overwrite: true },
    })
    await this.request(`/api/folders/${GRAFANA_FOLDER_UID}/permissions`, {
      method: 'POST',
      body: {
        items: [
          { role: 'Viewer', permission: 1 },
          { role: 'Editor', permission: 1 },
        ],
      },
    })
  }

  async saveDashboard(definition: GrafanaResourceDefinition): Promise<void> {
    await this.request('/api/dashboards/db', {
      method: 'POST',
      body: {
        dashboard: definition.body,
        folderUid: GRAFANA_FOLDER_UID,
        message: 'Reconciled by PrickleScope',
        overwrite: true,
      },
    })
  }

  // Alerting lives behind /api/v1/provisioning, a different surface from the
  // dashboard API. Rules are written with provenance so Grafana marks them
  // controller-owned and read-only in its own UI.
  async upsertAlertRule(uid: string, definition: Record<string, unknown>): Promise<void> {
    const existing = await this.requestOrNull(`/api/v1/provisioning/alert-rules/${uid}`)
    await this.request(
      existing ? `/api/v1/provisioning/alert-rules/${uid}` : '/api/v1/provisioning/alert-rules',
      { method: existing ? 'PUT' : 'POST', body: definition },
    )
  }

  async deleteAlertRule(uid: string): Promise<void> {
    await this.requestOrNull(`/api/v1/provisioning/alert-rules/${uid}`, { method: 'DELETE' })
  }

  async alertRules(): Promise<Array<Record<string, unknown>>> {
    return this.request('/api/v1/provisioning/alert-rules')
  }

  async setRuleGroupInterval(group: string, seconds: number): Promise<void> {
    await this.request(
      `/api/v1/provisioning/folder/${GRAFANA_FOLDER_UID}/rule-groups/${encodeURIComponent(group)}`,
      { method: 'PUT', body: { title: group, folderUid: GRAFANA_FOLDER_UID, interval: seconds } },
    )
  }

  async contactPoints(): Promise<Array<Record<string, unknown>>> {
    return this.request('/api/v1/provisioning/contact-points')
  }

  async upsertContactPoint(definition: Record<string, unknown>): Promise<void> {
    const existing = (await this.contactPoints()).find((item) => item.name === definition.name)
    const uid = typeof existing?.uid === 'string' ? existing.uid : null
    await this.request(
      uid ? `/api/v1/provisioning/contact-points/${uid}` : '/api/v1/provisioning/contact-points',
      { method: uid ? 'PUT' : 'POST', body: uid ? { ...definition, uid } : definition },
    )
  }

  /** Asks Grafana to deliver a test notification through this contact point. */
  async testContactPoint(definition: Record<string, unknown>): Promise<void> {
    await this.request('/api/alertmanager/grafana/config/api/v1/receivers/test', {
      method: 'POST',
      body: {
        receivers: [{ name: definition.name, grafana_managed_receiver_configs: [definition] }],
      },
    })
  }

  async deleteContactPoint(uid: string): Promise<void> {
    await this.requestOrNull(`/api/v1/provisioning/contact-points/${uid}`, { method: 'DELETE' })
  }

  /** Current firing/pending state, so the controller can show it on its own screens. */
  async alertState(): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{ data?: { groups?: Array<Record<string, unknown>> } }>(
      '/api/prometheus/grafana/api/v1/rules',
    )
    return result.data?.groups ?? []
  }

  async dashboard(uid: string): Promise<Record<string, unknown> | null> {
    return this.requestOrNull(`/api/dashboards/uid/${encodeURIComponent(uid)}`)
  }

  private async requestOrNull(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.request(path, options)
    } catch (error) {
      if (error instanceof GrafanaApiError && error.status === 404) return null
      throw error
    }
  }

  /** Parses the body regardless of status, for endpoints whose job is to report failure. */
  private async requestAnyStatus<T>(path: string): Promise<T | null> {
    const headers = new Headers({ accept: 'application/json' })
    if (this.authentication.kind === 'basic') {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${this.authentication.username}:${this.authentication.password}`).toString('base64')}`,
      )
    } else if (this.authentication.kind === 'bearer') {
      headers.set('authorization', `Bearer ${this.authentication.token}`)
    }
    const baseUrl = `${this.baseUrl.replace(/\/+$/, '')}/`
    const response = await this.fetchImplementation(new URL(path.replace(/^\/+/, ''), baseUrl), {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: 'application/json' })
    if (options.body) headers.set('content-type', 'application/json')
    if (this.authentication.kind === 'basic') {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${this.authentication.username}:${this.authentication.password}`).toString('base64')}`,
      )
    } else if (this.authentication.kind === 'bearer') {
      headers.set('authorization', `Bearer ${this.authentication.token}`)
    }
    const baseUrl = `${this.baseUrl.replace(/\/+$/, '')}/`
    const response = await this.fetchImplementation(new URL(path.replace(/^\/+/, ''), baseUrl), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      let message = `Grafana returned HTTP ${response.status}`
      try {
        const body = (await response.json()) as { message?: unknown }
        if (typeof body.message === 'string') message = body.message.slice(0, 500)
      } catch {
        // Never include an arbitrary upstream body in the error or application logs.
      }
      throw new GrafanaApiError(response.status, path, message)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

export function grafanaDataSource(input: GrafanaDataSourceInput): Record<string, unknown> {
  return {
    uid: GRAFANA_DATASOURCE_UID,
    name: 'PrickleScope QuestDB',
    type: 'questdb-questdb-datasource',
    access: 'proxy',
    isDefault: true,
    editable: false,
    jsonData: {
      server: input.server,
      port: input.port,
      username: input.username,
      tlsMode: 'disable',
      maxOpenConnections: 20,
      maxIdleConnections: 10,
      maxConnectionLifetime: 14_400,
      timeInterval: '10s',
    },
    secureJsonData: { password: input.password },
  }
}

function variable(
  name: string,
  label: string,
  query: string,
  options: { multi?: boolean; all?: boolean } = {},
): Record<string, unknown> {
  return {
    name,
    label,
    type: 'query',
    datasource,
    definition: query,
    query,
    refresh: 1,
    sort: 1,
    hide: 0,
    multi: options.multi ?? false,
    includeAll: options.all ?? false,
    // No allValue: Grafana inserts one verbatim, so `:sqlstring` would not quote it
    // and the generated IN list would not parse. Letting All expand to the real
    // option values keeps every scoped predicate a plain quoted IN list.
    // Without an explicit selection a fresh load or a server-side render resolves
    // the variable to nothing, so every scoped panel filters its rows away.
    current: options.all ? { selected: true, text: 'All', value: '$__all' } : {},
    options: [],
  }
}

const siteVariable = variable(
  'site_id',
  'Site',
  'select distinct site_id from network_system where site_id is not null order by site_id',
  { multi: true, all: true },
)
const sourceVariable = variable(
  'source_id',
  'Source',
  'select distinct source_id as __value, source_name as __text from network_system where site_id in (${site_id:sqlstring}) order by __text',
  { multi: true, all: true },
)
const interfaceVariable = variable(
  'if_index',
  'Interface',
  'select distinct if_index as __value, if_description as __text from network_interface where source_id in (${source_id:sqlstring}) order by __value',
  { multi: true, all: true },
)

// The QuestDB plugin takes the format as the numeric sqlutil enum, not a name.
const QUERY_FORMAT = { timeSeries: 0, table: 1 } as const

function target(rawSql: string, refId = 'A', format: number = QUERY_FORMAT.timeSeries) {
  return {
    datasource,
    refId,
    rawSql,
    rawQuery: true,
    editorMode: 'code',
    format,
  }
}

// Pin the controller's own series colours onto the managed dashboards, matched by
// name so a grouped query ("Inbound eth0") still lands on the right colour. Slot
// order matches the in-product charts: first series green, second blue, as Cacti
// has drawn inbound and outbound for two decades.
function colorOverrides(seriesPatterns: string[]): Record<string, unknown>[] {
  return seriesPatterns.map((pattern, index) => ({
    matcher: { id: 'byRegexp', options: `.*${pattern}.*` },
    properties: [
      {
        id: 'color',
        value: {
          mode: 'fixed',
          fixedColor: GRAFANA_SERIES_COLORS[index % GRAFANA_SERIES_COLORS.length]!,
        },
      },
      // Only the first series of a directional pair is filled, so inbound reads
      // as an area under an outbound line rather than two overlapping washes.
      { id: 'custom.fillOpacity', value: index === 0 ? TRAFFIC_FILL_OPACITY : 0 },
    ],
  }))
}

function panel(
  id: number,
  title: string,
  type: 'timeseries' | 'stat' | 'table',
  rawSql: string,
  gridPos: { x: number; y: number; w: number; h: number },
  unit?: string,
  seriesPatterns: string[] = [],
): Record<string, unknown> {
  return {
    id,
    title,
    type,
    datasource,
    gridPos,
    targets: [target(rawSql, 'A', type === 'table' ? QUERY_FORMAT.table : QUERY_FORMAT.timeSeries)],
    fieldConfig: {
      defaults: {
        ...(unit ? { unit } : {}),
        color: { mode: 'palette-classic' },
        custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 12 },
      },
      overrides: colorOverrides(seriesPatterns),
    },
    options:
      type === 'stat'
        ? {
            colorMode: 'value',
            graphMode: 'area',
            justifyMode: 'auto',
            reduceOptions: { calcs: ['lastNotNull'] },
          }
        : type === 'table'
          ? { showHeader: true }
          : { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
  }
}

function dashboard(
  key: GrafanaDashboardKey,
  variables: Record<string, unknown>[],
  panels: Record<string, unknown>[],
): GrafanaResourceDefinition {
  const descriptor = GRAFANA_DASHBOARDS[key]
  const body = {
    uid: descriptor.uid,
    title: descriptor.title,
    description: 'Managed by PrickleScope. Create custom dashboards outside this folder.',
    tags: ['pricklescope', 'managed'],
    editable: false,
    timezone: 'browser',
    schemaVersion: 42,
    version: 0,
    refresh: '30s',
    time: { from: 'now-6h', to: 'now' },
    templating: { list: variables },
    annotations: { list: [] },
    panels,
  }
  return {
    uid: descriptor.uid,
    type: 'dashboard',
    title: descriptor.title,
    folderUid: GRAFANA_FOLDER_UID,
    body,
    contentHash: hash(body),
  }
}

export function grafanaResourceDefinitions(
  input: GrafanaDataSourceInput,
): GrafanaResourceDefinition[] {
  const datasourceBody = grafanaDataSource(input)
  const folderBody = { uid: GRAFANA_FOLDER_UID, title: 'PrickleScope managed' }
  const scopedSources = 'source_id in (${source_id:sqlstring})'
  const scopedSites = 'site_id in (${site_id:sqlstring})'
  const scopedInterfaces = 'if_index in (${if_index:sqlstring})'

  return [
    {
      uid: GRAFANA_DATASOURCE_UID,
      type: 'datasource',
      title: 'PrickleScope QuestDB',
      folderUid: null,
      body: datasourceBody,
      contentHash: hash({ ...datasourceBody, secureJsonData: { password: '[write-only]' } }),
    },
    {
      uid: GRAFANA_FOLDER_UID,
      type: 'folder',
      title: 'PrickleScope managed',
      folderUid: null,
      body: folderBody,
      contentHash: hash(folderBody),
    },
    dashboard(
      'fleet',
      [siteVariable, sourceVariable],
      [
        panel(
          1,
          'Availability',
          'timeseries',
          `select timestamp as time, 100.0 - percent_packet_loss as "Availability %", source_name from network_availability where $__timeFilter(timestamp) and ${scopedSites} and ${scopedSources}`,
          { x: 0, y: 0, w: 16, h: 9 },
          'percent',
          ['Availability %'],
        ),
        panel(
          2,
          'Sources reporting',
          'stat',
          `select count_distinct(source_id) as "Sources" from network_system where $__timeFilter(timestamp) and ${scopedSites} and ${scopedSources}`,
          { x: 16, y: 0, w: 8, h: 4 },
        ),
        panel(
          3,
          'Latest sources',
          'table',
          `select source_name, source_id, site_id, max(timestamp) as last_seen from network_system where $__timeFilter(timestamp) and ${scopedSites} and ${scopedSources} group by source_name, source_id, site_id order by last_seen desc`,
          { x: 16, y: 4, w: 8, h: 5 },
        ),
      ],
    ),
    dashboard(
      'source',
      [sourceVariable, interfaceVariable],
      [
        panel(
          1,
          'Availability',
          'timeseries',
          `select timestamp as time, 100.0 - percent_packet_loss as "Availability %" from network_availability where $__timeFilter(timestamp) and ${scopedSources}`,
          { x: 0, y: 0, w: 12, h: 8 },
          'percent',
          ['Availability %'],
        ),
        panel(
          2,
          'Latency',
          'timeseries',
          `select timestamp as time, average_response_ms as "Average", maximum_response_ms as "Maximum" from network_availability where $__timeFilter(timestamp) and ${scopedSources}`,
          { x: 12, y: 0, w: 12, h: 8 },
          'ms',
          ['Average', 'Maximum'],
        ),
        panel(
          3,
          'Interface traffic',
          'timeseries',
          `select timestamp as time, if_in_octets_per_second * 8 as "Inbound", if_out_octets_per_second * 8 as "Outbound", if_description from network_interface_rate where $__timeFilter(timestamp) and ${scopedSources} and ${scopedInterfaces}`,
          { x: 0, y: 8, w: 24, h: 9 },
          'bps',
          ['Inbound', 'Outbound'],
        ),
      ],
    ),
    dashboard(
      'interface',
      [sourceVariable, interfaceVariable],
      [
        panel(
          1,
          'Throughput',
          'timeseries',
          `select timestamp as time, if_in_octets_per_second * 8 as "Inbound", if_out_octets_per_second * 8 as "Outbound" from network_interface_rate where $__timeFilter(timestamp) and ${scopedSources} and ${scopedInterfaces}`,
          { x: 0, y: 0, w: 24, h: 9 },
          'bps',
          ['Inbound', 'Outbound'],
        ),
        panel(
          2,
          'Errors',
          'timeseries',
          `select timestamp as time, if_in_errors_per_second as "Inbound errors", if_out_errors_per_second as "Outbound errors" from network_interface_rate where $__timeFilter(timestamp) and ${scopedSources} and ${scopedInterfaces}`,
          { x: 0, y: 9, w: 14, h: 8 },
          'ops',
          ['Inbound errors', 'Outbound errors'],
        ),
        panel(
          3,
          'Current state',
          'table',
          `select if_index, if_description, if_admin_status, if_oper_status, if_speed, max(timestamp) as last_seen from network_interface where ${scopedSources} and ${scopedInterfaces} group by if_index, if_description, if_admin_status, if_oper_status, if_speed order by if_index`,
          { x: 14, y: 9, w: 10, h: 8 },
        ),
      ],
    ),
    dashboard(
      'health',
      [],
      [
        panel(
          1,
          'Buffered metrics',
          'timeseries',
          'select timestamp as time, buffered_metrics, component from collector_health where $__timeFilter(timestamp)',
          { x: 0, y: 0, w: 12, h: 8 },
          'short',
        ),
        panel(
          2,
          'Pipeline errors',
          'timeseries',
          'select timestamp as time, gather_errors as "Gather", write_errors as "Write", component from collector_health where $__timeFilter(timestamp)',
          { x: 12, y: 0, w: 12, h: 8 },
          'short',
          ['Gather', 'Write'],
        ),
      ],
    ),
  ]
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
