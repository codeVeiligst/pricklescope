import { StorageOverviewSchema, SyncStatusSchema } from '@pricklescope/contracts'
import { FormatRegistry, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import type {
  ApiError,
  AuthProviders,
  AuthSession,
  CollectorCapability,
  CollectorRevision,
  CreateLocalUserRequest,
  CreatePollingProfileRequest,
  CreateSiteRequest,
  CreateSnmpCredentialRequest,
  CreateSourceRequest,
  AlertOverview,
  UpdateHealthAlertsRequest,
  UpsertAlertRuleRequest,
  UpsertContactPointRequest,
  AlertPreview,
  AlertRule,
  ContactPoint,
  FleetGraphs,
  InterfaceGraphs,
  InventorySnapshot,
  GrafanaOverview,
  HealthAlertSettings,
  Job,
  SyncApplyResult,
  SyncStatus,
  JobList,
  LoginRequest,
  ManagedUser,
  OidcDiscoveryResult,
  OidcProviderSettings,
  PollingProfile,
  Site,
  SnmpCredential,
  Source,
  SourceGraphs,
  StorageOverview,
  SystemHealth,
  TelegrafCollectorStatus,
  UpdatePollingProfileRequest,
  UpdateManagedUserRequest,
  UpdateOidcProviderSettingsRequest,
  UpdateSiteRequest,
  UpdateSnmpCredentialRequest,
  UpdateSourceRequest,
  UpdateStoragePolicyRequest,
} from '@pricklescope/contracts'

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

/**
 * TypeBox validates a `format` only against formats registered with it, and an
 * unregistered one fails rather than being ignored. The server validates these
 * through Ajv, which knows them already, so the first version of this check
 * rejected perfectly good responses — the Storage and sync screens went blank
 * behind an error about a shape the server had produced correctly.
 *
 * Registered here, once, covering every format the contracts use. A validator
 * stricter than the thing it is checking is not a safety net; it is a new bug
 * with a reassuring name.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

FormatRegistry.Set('date-time', (value) => ISO_DATE_TIME.test(value))
FormatRegistry.Set('uuid', (value) => UUID.test(value))
FormatRegistry.Set('email', (value) => value.includes('@'))
FormatRegistry.Set('uri', (value) => URL.canParse(value))

/**
 * Checks a response against the schema the server serialises it with, for the
 * few answers a person acts on irreversibly (audit F15).
 *
 * Not every response. The server serialises against these same schemas, so
 * validating everything would mostly re-prove what the API already guarantees
 * while adding weight to a bundle that is already large. The failure worth
 * catching is version skew — a cached bundle against a newer API — and it only
 * matters where a wrong number changes what someone destroys: retention, which
 * drops data when shortened, and the sync status, which says what "apply" is
 * about to rewrite.
 *
 * The schema comes from `@pricklescope/contracts`, so there is one definition
 * rather than a hand-written guard that has to be kept in step with it.
 */
async function checked<T>(schema: TSchema, response: Promise<unknown>): Promise<T> {
  const body = await response
  if (!Value.Check(schema, body)) {
    const [first] = [...Value.Errors(schema, body)]
    throw new ApiClientError(
      500,
      'response_unexpected',
      `The server answered in a shape this version does not understand${
        first ? ` (${first.path || '/'}: ${first.message})` : ''
      }. Reload to pick up a newer application.`,
    )
  }
  return body as T
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('accept', 'application/json')
  if (options.body) headers.set('content-type', 'application/json')
  if (csrfToken) headers.set('x-csrf-token', csrfToken)

  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers,
  })
  if (!response.ok) {
    let body: ApiError | null = null
    try {
      body = (await response.json()) as ApiError
    } catch {
      // The fallback below intentionally hides proxy and infrastructure details.
    }
    throw new ApiClientError(
      response.status,
      body?.error ?? 'request_failed',
      body?.message ?? 'PrickleScope could not complete the request',
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  providers: () => apiRequest<AuthProviders>('/api/v1/auth/providers'),
  session: () => apiRequest<AuthSession>('/api/v1/auth/session'),
  login: (request: LoginRequest) =>
    apiRequest<AuthSession>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  logout: (csrfToken: string) =>
    apiRequest<void>('/api/v1/auth/logout', { method: 'POST' }, csrfToken),
  health: () => apiRequest<SystemHealth>('/api/v1/system/health'),
  jobs: () => apiRequest<JobList>('/api/v1/jobs'),
  job: (id: string) => apiRequest<Job>(`/api/v1/jobs/${id}`),
  checkDependencies: (csrfToken: string) =>
    apiRequest<Job>('/api/v1/jobs/dependency-check', { method: 'POST' }, csrfToken),
  sites: () => apiRequest<{ sites: Site[] }>('/api/v1/sites'),
  createSite: (request: CreateSiteRequest, csrfToken: string) =>
    apiRequest<Site>('/api/v1/sites', { method: 'POST', body: JSON.stringify(request) }, csrfToken),
  updateSite: (id: string, request: UpdateSiteRequest, csrfToken: string) =>
    apiRequest<Site>(
      `/api/v1/sites/${id}`,
      { method: 'PATCH', body: JSON.stringify(request) },
      csrfToken,
    ),
  deleteSite: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/sites/${id}`, { method: 'DELETE' }, csrfToken),
  snmpCredentials: () => apiRequest<{ credentials: SnmpCredential[] }>('/api/v1/credentials/snmp'),
  createSnmpCredential: (request: CreateSnmpCredentialRequest, csrfToken: string) =>
    apiRequest<SnmpCredential>(
      '/api/v1/credentials/snmp',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  updateSnmpCredential: (id: string, request: UpdateSnmpCredentialRequest, csrfToken: string) =>
    apiRequest<SnmpCredential>(
      `/api/v1/credentials/snmp/${id}`,
      { method: 'PATCH', body: JSON.stringify(request) },
      csrfToken,
    ),
  deleteSnmpCredential: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/credentials/snmp/${id}`, { method: 'DELETE' }, csrfToken),
  pollingProfiles: () => apiRequest<{ profiles: PollingProfile[] }>('/api/v1/polling-profiles'),
  createPollingProfile: (request: CreatePollingProfileRequest, csrfToken: string) =>
    apiRequest<PollingProfile>(
      '/api/v1/polling-profiles',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  updatePollingProfile: (id: string, request: UpdatePollingProfileRequest, csrfToken: string) =>
    apiRequest<PollingProfile>(
      `/api/v1/polling-profiles/${id}`,
      { method: 'PATCH', body: JSON.stringify(request) },
      csrfToken,
    ),
  deletePollingProfile: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/polling-profiles/${id}`, { method: 'DELETE' }, csrfToken),
  collectorCapabilities: () =>
    apiRequest<{ recommended: 'telegraf' | 'alloy'; capabilities: CollectorCapability[] }>(
      '/api/v1/collectors/capabilities',
    ),
  telegrafCollector: () => apiRequest<TelegrafCollectorStatus>('/api/v1/collectors/telegraf'),
  telegrafRevisions: () =>
    apiRequest<{ revisions: CollectorRevision[] }>('/api/v1/collectors/telegraf/revisions'),
  reconcileTelegraf: (csrfToken: string) =>
    apiRequest<Job>('/api/v1/collectors/telegraf/reconcile', { method: 'POST' }, csrfToken),
  rollbackTelegraf: (id: string, csrfToken: string) =>
    apiRequest<Job>(
      `/api/v1/collectors/telegraf/revisions/${id}/rollback`,
      { method: 'POST' },
      csrfToken,
    ),
  storage: () => checked<StorageOverview>(StorageOverviewSchema, apiRequest('/api/v1/storage')),
  updateStoragePolicy: (request: UpdateStoragePolicyRequest, csrfToken: string) =>
    apiRequest<Job>(
      '/api/v1/storage/policy',
      { method: 'PUT', body: JSON.stringify(request) },
      csrfToken,
    ),
  reconcileStorage: (csrfToken: string) =>
    apiRequest<Job>('/api/v1/storage/reconcile', { method: 'POST' }, csrfToken),
  grafana: () => apiRequest<GrafanaOverview>('/api/v1/grafana'),
  alerts: () => apiRequest<AlertOverview>('/api/v1/alerts'),
  alertRules: () => apiRequest<{ rules: AlertRule[] }>('/api/v1/alerts/rules'),
  createAlertRule: (request: UpsertAlertRuleRequest, csrfToken: string) =>
    apiRequest<AlertRule>(
      '/api/v1/alerts/rules',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  updateAlertRule: (id: string, request: UpsertAlertRuleRequest, csrfToken: string) =>
    apiRequest<AlertRule>(
      `/api/v1/alerts/rules/${id}`,
      { method: 'PUT', body: JSON.stringify(request) },
      csrfToken,
    ),
  deleteAlertRule: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/alerts/rules/${id}`, { method: 'DELETE' }, csrfToken),
  previewAlertRule: (request: UpsertAlertRuleRequest, csrfToken: string) =>
    apiRequest<AlertPreview>(
      '/api/v1/alerts/preview',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  contactPoints: () =>
    apiRequest<{ contactPoints: ContactPoint[] }>('/api/v1/alerts/contact-points'),
  createContactPoint: (request: UpsertContactPointRequest, csrfToken: string) =>
    apiRequest<ContactPoint>(
      '/api/v1/alerts/contact-points',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  updateContactPoint: (id: string, request: UpsertContactPointRequest, csrfToken: string) =>
    apiRequest<ContactPoint>(
      `/api/v1/alerts/contact-points/${id}`,
      { method: 'PUT', body: JSON.stringify(request) },
      csrfToken,
    ),
  deleteContactPoint: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/alerts/contact-points/${id}`, { method: 'DELETE' }, csrfToken),
  testContactPoint: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/alerts/contact-points/${id}/test`, { method: 'POST' }, csrfToken),
  healthAlerts: () => apiRequest<HealthAlertSettings>('/api/v1/alerts/health'),
  updateHealthAlerts: (request: UpdateHealthAlertsRequest, csrfToken: string) =>
    apiRequest<HealthAlertSettings>(
      '/api/v1/alerts/health',
      { method: 'PUT', body: JSON.stringify(request) },
      csrfToken,
    ),
  reconcileAlerts: (csrfToken: string) =>
    apiRequest<Job>('/api/v1/alerts/reconcile', { method: 'POST' }, csrfToken),
  syncStatus: () => checked<SyncStatus>(SyncStatusSchema, apiRequest('/api/v1/sync')),
  applySync: (csrfToken: string) =>
    apiRequest<SyncApplyResult>('/api/v1/sync/apply', { method: 'POST' }, csrfToken),
  fleetGraphs: () => apiRequest<FleetGraphs>('/api/v1/graphs/fleet'),
  sourceGraphs: (id: string) => apiRequest<SourceGraphs>(`/api/v1/graphs/sources/${id}`),
  interfaceGraphs: (id: string) =>
    apiRequest<InterfaceGraphs>(`/api/v1/graphs/sources/${id}/interfaces`),
  reconcileGrafana: (csrfToken: string) =>
    apiRequest<Job>('/api/v1/grafana/reconcile', { method: 'POST' }, csrfToken),
  sources: (options: { siteId?: string; includeDescendants?: boolean } = {}) => {
    const parameters = new URLSearchParams()
    if (options.siteId) parameters.set('siteId', options.siteId)
    if (options.includeDescendants !== undefined)
      parameters.set('includeDescendants', String(options.includeDescendants))
    const query = parameters.size ? `?${parameters.toString()}` : ''
    return apiRequest<{ sources: Source[] }>(`/api/v1/sources${query}`)
  },
  source: (id: string) => apiRequest<Source>(`/api/v1/sources/${id}`),
  createSource: (request: CreateSourceRequest, csrfToken: string) =>
    apiRequest<Source>(
      '/api/v1/sources',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  updateSource: (id: string, request: UpdateSourceRequest, csrfToken: string) =>
    apiRequest<Source>(
      `/api/v1/sources/${id}`,
      { method: 'PATCH', body: JSON.stringify(request) },
      csrfToken,
    ),
  deleteSource: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/sources/${id}`, { method: 'DELETE' }, csrfToken),
  testSource: (id: string, csrfToken: string) =>
    apiRequest<Job>(`/api/v1/sources/${id}/test`, { method: 'POST' }, csrfToken),
  inventorySource: (id: string, csrfToken: string) =>
    apiRequest<Job>(`/api/v1/sources/${id}/inventory`, { method: 'POST' }, csrfToken),
  inventorySnapshots: (sourceId: string) =>
    apiRequest<{ snapshots: InventorySnapshot[] }>(`/api/v1/sources/${sourceId}/inventory`),
  applyInventorySnapshot: (id: string, csrfToken: string) =>
    apiRequest<Source>(`/api/v1/inventory/${id}/apply`, { method: 'POST' }, csrfToken),
  users: () => apiRequest<{ users: ManagedUser[] }>('/api/v1/users'),
  createUser: (request: CreateLocalUserRequest, csrfToken: string) =>
    apiRequest<ManagedUser>(
      '/api/v1/users',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  updateUser: (id: string, request: UpdateManagedUserRequest, csrfToken: string) =>
    apiRequest<ManagedUser>(
      `/api/v1/users/${id}`,
      { method: 'PATCH', body: JSON.stringify(request) },
      csrfToken,
    ),
  resetUserPassword: (id: string, password: string, csrfToken: string) =>
    apiRequest<ManagedUser>(
      `/api/v1/users/${id}/password`,
      { method: 'POST', body: JSON.stringify({ password }) },
      csrfToken,
    ),
  revokeUserSessions: (id: string, csrfToken: string) =>
    apiRequest<{ revokedSessions: number }>(
      `/api/v1/users/${id}/revoke-sessions`,
      { method: 'POST' },
      csrfToken,
    ),
  deleteUser: (id: string, csrfToken: string) =>
    apiRequest<void>(`/api/v1/users/${id}`, { method: 'DELETE' }, csrfToken),
  oidcSettings: () => apiRequest<OidcProviderSettings>('/api/v1/settings/oidc'),
  updateOidcSettings: (request: UpdateOidcProviderSettingsRequest, csrfToken: string) =>
    apiRequest<OidcProviderSettings>(
      '/api/v1/settings/oidc',
      { method: 'PUT', body: JSON.stringify(request) },
      csrfToken,
    ),
  testOidcSettings: (request: UpdateOidcProviderSettingsRequest, csrfToken: string) =>
    apiRequest<OidcDiscoveryResult>(
      '/api/v1/settings/oidc/test',
      { method: 'POST', body: JSON.stringify(request) },
      csrfToken,
    ),
  resetOidcSettings: (csrfToken: string) =>
    apiRequest<OidcProviderSettings>('/api/v1/settings/oidc', { method: 'DELETE' }, csrfToken),
}
