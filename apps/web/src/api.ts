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
  UpsertAlertRuleRequest,
  UpsertContactPointRequest,
  AlertPreview,
  AlertRule,
  ContactPoint,
  FleetGraphs,
  InterfaceGraphs,
  InventorySnapshot,
  GrafanaOverview,
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
  storage: () => apiRequest<StorageOverview>('/api/v1/storage'),
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
  reconcileAlerts: (csrfToken: string) =>
    apiRequest<Job>('/api/v1/alerts/reconcile', { method: 'POST' }, csrfToken),
  syncStatus: () => apiRequest<SyncStatus>('/api/v1/sync'),
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
