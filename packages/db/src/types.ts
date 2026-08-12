import type {
  CollectorKind,
  CollectorSelection,
  InventoryDiff,
  InventoryInterface,
  InventorySystem,
  Role,
  SnmpAuthProtocol,
  SnmpPrivacyProtocol,
  SnmpSecurityLevel,
  SnmpVersion,
  SourceStatus,
} from '@pricklescope/contracts'
import type { ColumnType, Generated, JSONColumnType } from 'kysely'

export type Timestamp = ColumnType<Date, Date | string, Date | string>
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>

export interface UserTable {
  id: string
  username: string
  username_normalized: string
  display_name: string
  email: string | null
  role: Role
  active: Generated<boolean>
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
  last_login_at: Timestamp | null
}

export interface LocalCredentialTable {
  user_id: string
  password_hash: string
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface OidcIdentityTable {
  id: string
  user_id: string
  issuer: string
  subject: string
  email: string | null
  claims: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface SessionTable {
  id: string
  user_id: string
  token_hash: string
  csrf_token: string
  expires_at: Timestamp
  created_at: GeneratedTimestamp
  last_seen_at: GeneratedTimestamp
}

export interface OidcLoginFlowTable {
  id: string
  flow_token_hash: string
  state: string
  code_verifier: string
  nonce: string
  return_to: string
  expires_at: Timestamp
  created_at: GeneratedTimestamp
}

export interface OidcProviderSettingsTable {
  provider_key: string
  enabled: Generated<boolean>
  name: string
  issuer_url: string | null
  client_id: string | null
  client_secret_key_version: number | null
  client_secret_nonce: Uint8Array | null
  client_secret_ciphertext: Uint8Array | null
  client_secret_auth_tag: Uint8Array | null
  redirect_uri: string
  scopes: string
  jit_provisioning: Generated<boolean>
  admin_group: string | null
  operator_group: string | null
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
  updated_by: string | null
}

export interface JobTable {
  id: string
  type: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  payload: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  result: JSONColumnType<object | null, object | null, object | null>
  error: string | null
  progress: Generated<number>
  requested_by: string | null
  attempts: Generated<number>
  timeout_ms: number
  created_at: GeneratedTimestamp
  started_at: Timestamp | null
  finished_at: Timestamp | null
  heartbeat_at: Timestamp | null
}

export interface DesiredStateTable {
  key: string
  value: JSONColumnType<object | null, object | null, object | null>
  revision: Generated<number>
  updated_by: string | null
  updated_at: GeneratedTimestamp
}

export interface AuditEventTable {
  id: Generated<string>
  actor_user_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  outcome: 'success' | 'failure'
  metadata: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >
  occurred_at: GeneratedTimestamp
}

export interface SiteTable {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface SnmpCredentialTable {
  id: string
  name: string
  version: SnmpVersion
  username: string | null
  security_level: SnmpSecurityLevel | null
  auth_protocol: SnmpAuthProtocol | null
  privacy_protocol: SnmpPrivacyProtocol | null
  secret_key_version: number
  secret_nonce: Uint8Array
  secret_ciphertext: Uint8Array
  secret_auth_tag: Uint8Array
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface PollingProfileTable {
  id: string
  name: string
  description: string | null
  interval_seconds: number
  timeout_ms: number
  retries: number
  collect_system: Generated<boolean>
  collect_interfaces: Generated<boolean>
  system_defined: Generated<boolean>
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface SourceTable {
  id: string
  site_id: string | null
  name: string
  target: string
  port: Generated<number>
  transport: Generated<'udp4' | 'udp6'>
  enabled: Generated<boolean>
  status: Generated<SourceStatus>
  tags: Generated<string[]>
  system_name: string | null
  system_description: string | null
  sys_object_id: string | null
  last_test_at: Timestamp | null
  last_test_message: string | null
  last_inventory_at: Timestamp | null
  pending_inventory_snapshot_id: string | null
  applied_inventory_snapshot_id: string | null
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface SourceCheckTable {
  id: string
  source_id: string
  credential_id: string
  profile_id: string
  collector_selection: Generated<CollectorSelection>
  collector_resolved: CollectorKind
  enabled: Generated<boolean>
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface InventorySnapshotTable {
  id: string
  source_id: string
  job_id: string | null
  system_data: JSONColumnType<InventorySystem, InventorySystem, InventorySystem>
  interfaces: JSONColumnType<InventoryInterface[], InventoryInterface[], InventoryInterface[]>
  diff: JSONColumnType<InventoryDiff, InventoryDiff, InventoryDiff>
  partial: Generated<boolean>
  errors: JSONColumnType<string[], string[], string[]>
  observed_at: GeneratedTimestamp
  applied_at: Timestamp | null
  applied_by: string | null
}

export interface CollectorRevisionTable {
  id: string
  revision_number: Generated<number>
  collector: 'telegraf'
  status: 'active' | 'superseded' | 'failed'
  reason: 'reconcile' | 'rollback'
  source_revision_id: string | null
  content_hash: string
  rendered_config: string
  config_key_version: number
  config_nonce: Uint8Array
  config_ciphertext: Uint8Array
  config_auth_tag: Uint8Array
  source_count: number
  check_count: number
  error: string | null
  created_by: string | null
  created_at: GeneratedTimestamp
  activated_at: Timestamp | null
}

export interface StorageSettingsTable {
  settings_key: string
  raw_retention_days: number
  five_minute_retention_days: number
  hourly_retention_days: number
  status: 'unconfigured' | 'pending' | 'active' | 'failed'
  error: string | null
  revision: Generated<number>
  updated_by: string | null
  updated_at: GeneratedTimestamp
  applied_at: Timestamp | null
}

export interface GrafanaSettingsTable {
  settings_key: string
  status: 'unconfigured' | 'pending' | 'active' | 'failed'
  error: string | null
  revision: Generated<number>
  service_account_id: number | null
  service_account_token_id: number | null
  token_key_version: number | null
  token_nonce: Uint8Array | null
  token_ciphertext: Uint8Array | null
  token_auth_tag: Uint8Array | null
  grafana_version: string | null
  plugin_version: string | null
  updated_by: string | null
  updated_at: GeneratedTimestamp
  applied_at: Timestamp | null
}

export interface ManagedGrafanaResourceTable {
  uid: string
  resource_type: 'datasource' | 'folder' | 'dashboard' | 'alert_rule' | 'contact_point'
  title: string
  folder_uid: string | null
  content_hash: string
  revision: Generated<number>
  status: 'active' | 'failed'
  error: string | null
  reconciled_at: GeneratedTimestamp
  /** The uid Grafana gave the resource, so ownership does not rest on its name. */
  remote_uid: string | null
}

export interface ContactPointTable {
  id: Generated<string>
  name: string
  kind: 'webhook' | 'email'
  url: string | null
  addresses: string | null
  secret_key_version: number | null
  secret_nonce: Buffer | null
  secret_ciphertext: Buffer | null
  secret_auth_tag: Buffer | null
  provider: 'graph' | 'gmail' | 'sendgrid' | 'mailgun' | 'postmark' | 'nylas' | null
  provider_config: Generated<Record<string, unknown>>
  delivery_ref: Generated<string>
  last_delivery_at: Date | null
  last_delivery_ok: boolean | null
  last_delivery_error: string | null
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface AlertRuleTable {
  id: Generated<string>
  name: string
  description: string | null
  enabled: Generated<boolean>
  source_id: string | null
  if_index: string | null
  metric: 'availability' | 'latency' | 'inbound_bps' | 'outbound_bps' | 'interface_errors'
  reducer: 'last' | 'avg' | 'min' | 'max'
  comparison: 'gt' | 'lt'
  threshold: number
  recovery_threshold: number | null
  evaluation_interval_seconds: Generated<number>
  pending_seconds: Generated<number>
  lookback_seconds: Generated<number>
  no_data_state: Generated<'NoData' | 'Alerting' | 'OK' | 'KeepLast'>
  exec_error_state: Generated<'Error' | 'Alerting' | 'OK' | 'KeepLast'>
  severity: Generated<'info' | 'warning' | 'critical'>
  contact_point_id: string | null
  created_at: GeneratedTimestamp
  updated_at: GeneratedTimestamp
}

export interface HealthAlertSettingsTable {
  settings_key: string
  contact_point_id: string | null
  updated_by: string | null
  updated_at: GeneratedTimestamp
}

export interface HealthAlertRuleTable {
  alert_key: string
  enabled: Generated<boolean>
  threshold: number
  for_seconds: number
  updated_at: GeneratedTimestamp
}

export interface Database {
  users: UserTable
  local_credentials: LocalCredentialTable
  oidc_identities: OidcIdentityTable
  sessions: SessionTable
  oidc_login_flows: OidcLoginFlowTable
  oidc_provider_settings: OidcProviderSettingsTable
  jobs: JobTable
  desired_state: DesiredStateTable
  audit_events: AuditEventTable
  sites: SiteTable
  snmp_credentials: SnmpCredentialTable
  polling_profiles: PollingProfileTable
  sources: SourceTable
  source_checks: SourceCheckTable
  inventory_snapshots: InventorySnapshotTable
  collector_revisions: CollectorRevisionTable
  storage_settings: StorageSettingsTable
  grafana_settings: GrafanaSettingsTable
  managed_grafana_resources: ManagedGrafanaResourceTable
  contact_points: ContactPointTable
  alert_rules: AlertRuleTable
  health_alert_settings: HealthAlertSettingsTable
  health_alert_rules: HealthAlertRuleTable
}
