import { Type, type Static } from '@sinclair/typebox'

import { NullableNumber, NullableString } from './nullable.js'

// Both kinds are HTTP. A webhook posts to the operator's own endpoint; email is
// sent by the controller through a provider API, because PrickleScope supports
// no SMTP relay (D-022, D-023).
export const ContactPointKindSchema = Type.Union([Type.Literal('webhook'), Type.Literal('email')])
export type ContactPointKind = Static<typeof ContactPointKindSchema>

export const EmailProviderSchema = Type.Union([
  Type.Literal('graph'),
  Type.Literal('gmail'),
  Type.Literal('sendgrid'),
  Type.Literal('mailgun'),
  Type.Literal('postmark'),
  Type.Literal('nylas'),
])
export type EmailProvider = Static<typeof EmailProviderSchema>

/**
 * Non-secret provider settings. Credentials are write-only and never returned.
 *
 * `additionalProperties: false` is load-bearing rather than tidiness. The email
 * adapter lets a caller override each provider's base URL so its tests can assert
 * the request it builds; the enclosing request schema closes itself, but a nested
 * object does not inherit that, so an unknown key survived validation and was
 * stored verbatim. An operator could then post `apiBaseUrl` and have the
 * controller send the provider's API key to a host of their choosing. The service
 * also copies only the keys named here, so neither guard is the only one.
 */
export const EmailProviderConfigSchema = Type.Object(
  {
    from: Type.Optional(Type.String({ maxLength: 320 })),
    tenantId: Type.Optional(Type.String({ maxLength: 128 })),
    domain: Type.Optional(Type.String({ maxLength: 253 })),
    region: Type.Optional(Type.Union([Type.Literal('us'), Type.Literal('eu')])),
    grantId: Type.Optional(Type.String({ maxLength: 128 })),
  },
  { additionalProperties: false },
)
export type EmailProviderConfigInput = Static<typeof EmailProviderConfigSchema>

/** The keys the controller will persist as provider settings, and no others. */
export const EMAIL_PROVIDER_CONFIG_KEYS = [
  'from',
  'tenantId',
  'domain',
  'region',
  'grantId',
] as const satisfies readonly (keyof EmailProviderConfigInput)[]

export const EmailCredentialsSchema = Type.Object(
  {
    apiKey: Type.Optional(Type.String({ maxLength: 2048 })),
    clientId: Type.Optional(Type.String({ maxLength: 512 })),
    clientSecret: Type.Optional(Type.String({ maxLength: 2048 })),
    refreshToken: Type.Optional(Type.String({ maxLength: 4096 })),
  },
  { additionalProperties: false },
)
export type EmailCredentialsInput = Static<typeof EmailCredentialsSchema>

export interface EmailFieldSpec {
  name: keyof EmailProviderConfigInput | keyof EmailCredentialsInput
  label: string
  hint?: string
  secret?: boolean
}

/**
 * What each provider needs, in the operator's language. The form renders exactly
 * this and the sender reads the same list, so adding a provider does not mean
 * editing a form. Everything else — OAuth exchanges, MIME assembly, encoding —
 * stays inside the adapter and is never shown.
 */
export const EMAIL_PROVIDER_FIELDS: Record<
  EmailProvider,
  { label: string; help: string; fields: EmailFieldSpec[] }
> = {
  graph: {
    label: 'Microsoft 365 (Graph)',
    help: 'Uses an Entra app registration with the Mail.Send application permission.',
    fields: [
      { name: 'tenantId', label: 'Directory (tenant) ID' },
      { name: 'clientId', label: 'Application (client) ID' },
      { name: 'clientSecret', label: 'Client secret', secret: true },
      { name: 'from', label: 'Send from mailbox', hint: 'alerts@example.com' },
    ],
  },
  gmail: {
    label: 'Gmail / Google Workspace',
    help: 'Uses an OAuth client and a refresh token for the sending account.',
    fields: [
      { name: 'clientId', label: 'OAuth client ID' },
      { name: 'clientSecret', label: 'OAuth client secret', secret: true },
      { name: 'refreshToken', label: 'Refresh token', secret: true },
      { name: 'from', label: 'Send from address' },
    ],
  },
  sendgrid: {
    label: 'SendGrid',
    help: 'Uses a SendGrid API key with Mail Send permission.',
    fields: [
      { name: 'apiKey', label: 'API key', secret: true },
      { name: 'from', label: 'Send from address', hint: 'Must be a verified sender' },
    ],
  },
  mailgun: {
    label: 'Mailgun',
    help: 'Uses a Mailgun sending API key and your sending domain.',
    fields: [
      { name: 'apiKey', label: 'API key', secret: true },
      { name: 'domain', label: 'Sending domain', hint: 'mg.example.com' },
      { name: 'region', label: 'Region' },
      { name: 'from', label: 'Send from address' },
    ],
  },
  postmark: {
    label: 'Postmark',
    help: 'Uses a Postmark server token.',
    fields: [
      { name: 'apiKey', label: 'Server token', secret: true },
      { name: 'from', label: 'Send from address', hint: 'Must be a confirmed sender signature' },
    ],
  },
  nylas: {
    label: 'Nylas',
    help: 'Uses a Nylas API key and the grant for the sending account.',
    fields: [
      { name: 'apiKey', label: 'API key', secret: true },
      { name: 'grantId', label: 'Grant ID' },
      { name: 'from', label: 'Send from address' },
    ],
  },
}

/**
 * Which field names belong to the encrypted credential bundle rather than the
 * plain provider settings. `clientId` is not itself a secret; it travels with the
 * secret it identifies so the pair is stored and rotated together.
 */
export const EMAIL_CREDENTIAL_FIELDS = new Set<string>([
  'apiKey',
  'clientId',
  'clientSecret',
  'refreshToken',
])

export const ContactPointSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  kind: ContactPointKindSchema,
  url: Type.Union([Type.String(), Type.Null()]),
  addresses: Type.Union([Type.String(), Type.Null()]),
  secretConfigured: Type.Boolean(),
  provider: Type.Union([EmailProviderSchema, Type.Null()]),
  providerConfig: EmailProviderConfigSchema,
  // Plain delivery status, so an operator can see whether mail is getting out.
  lastDeliveryAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  lastDeliveryOk: Type.Union([Type.Boolean(), Type.Null()]),
  lastDeliveryError: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})
export type ContactPoint = Static<typeof ContactPointSchema>

export const ContactPointListSchema = Type.Object({
  contactPoints: Type.Array(ContactPointSchema),
})

export const UpsertContactPointRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    kind: ContactPointKindSchema,
    url: Type.Optional(NullableString({ maxLength: 2048 })),
    addresses: Type.Optional(NullableString({ maxLength: 1024 })),
    // Write-only, like every other secret the controller holds.
    secret: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    clearSecret: Type.Optional(Type.Boolean()),
    provider: Type.Optional(Type.Union([EmailProviderSchema, Type.Null()])),
    providerConfig: Type.Optional(EmailProviderConfigSchema),
    credentials: Type.Optional(EmailCredentialsSchema),
  },
  { additionalProperties: false },
)
export type UpsertContactPointRequest = Static<typeof UpsertContactPointRequestSchema>

export const AlertMetricSchema = Type.Union([
  Type.Literal('availability'),
  Type.Literal('latency'),
  Type.Literal('inbound_bps'),
  Type.Literal('outbound_bps'),
  Type.Literal('interface_errors'),
])
export type AlertMetric = Static<typeof AlertMetricSchema>

/**
 * How each measurement is named and scoped, shared by the rule form and the SQL
 * builder. Kept here because both surfaces need it and they had drifted: the same
 * measurement was labelled two different ways. The table and expression stay
 * server-side in the adapter — only the browser-safe facts live here.
 */
export const ALERT_METRICS: Record<AlertMetric, { label: string; supportsInterface: boolean }> = {
  availability: { label: 'Availability %', supportsInterface: false },
  latency: { label: 'Latency ms', supportsInterface: false },
  inbound_bps: { label: 'Inbound bit/s', supportsInterface: true },
  outbound_bps: { label: 'Outbound bit/s', supportsInterface: true },
  interface_errors: { label: 'Errors per second', supportsInterface: true },
}

export const AlertReducerSchema = Type.Union([
  Type.Literal('last'),
  Type.Literal('avg'),
  Type.Literal('min'),
  Type.Literal('max'),
])
export type AlertReducer = Static<typeof AlertReducerSchema>

export const AlertComparisonSchema = Type.Union([Type.Literal('gt'), Type.Literal('lt')])
export type AlertComparison = Static<typeof AlertComparisonSchema>

export const NoDataStateSchema = Type.Union([
  Type.Literal('NoData'),
  Type.Literal('Alerting'),
  Type.Literal('OK'),
  Type.Literal('KeepLast'),
])
export type NoDataState = Static<typeof NoDataStateSchema>

export const ExecErrorStateSchema = Type.Union([
  Type.Literal('Error'),
  Type.Literal('Alerting'),
  Type.Literal('OK'),
  Type.Literal('KeepLast'),
])
export type ExecErrorState = Static<typeof ExecErrorStateSchema>

export const AlertSeveritySchema = Type.Union([
  Type.Literal('info'),
  Type.Literal('warning'),
  Type.Literal('critical'),
])
export type AlertSeverity = Static<typeof AlertSeveritySchema>

export const AlertRuleSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
  sourceId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  sourceName: Type.Union([Type.String(), Type.Null()]),
  ifIndex: Type.Union([Type.String(), Type.Null()]),
  metric: AlertMetricSchema,
  reducer: AlertReducerSchema,
  comparison: AlertComparisonSchema,
  threshold: Type.Number(),
  recoveryThreshold: Type.Union([Type.Number(), Type.Null()]),
  evaluationIntervalSeconds: Type.Integer(),
  pendingSeconds: Type.Integer(),
  lookbackSeconds: Type.Integer(),
  noDataState: NoDataStateSchema,
  execErrorState: ExecErrorStateSchema,
  severity: AlertSeveritySchema,
  contactPointId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  contactPointName: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})
export type AlertRule = Static<typeof AlertRuleSchema>

export const AlertRuleListSchema = Type.Object({ rules: Type.Array(AlertRuleSchema) })

export const UpsertAlertRuleRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(NullableString({ maxLength: 1000 })),
    enabled: Type.Optional(Type.Boolean()),
    sourceId: NullableString({ format: 'uuid' }),
    ifIndex: Type.Optional(NullableString({ maxLength: 64 })),
    metric: AlertMetricSchema,
    reducer: AlertReducerSchema,
    comparison: AlertComparisonSchema,
    threshold: Type.Number(),
    recoveryThreshold: Type.Optional(NullableNumber()),
    evaluationIntervalSeconds: Type.Integer({ minimum: 10, maximum: 3600 }),
    pendingSeconds: Type.Integer({ minimum: 0, maximum: 86_400 }),
    lookbackSeconds: Type.Integer({ minimum: 60, maximum: 86_400 }),
    noDataState: NoDataStateSchema,
    execErrorState: ExecErrorStateSchema,
    severity: AlertSeveritySchema,
    contactPointId: NullableString({ format: 'uuid' }),
  },
  { additionalProperties: false },
)
export type UpsertAlertRuleRequest = Static<typeof UpsertAlertRuleRequestSchema>

// A preview runs the rule's own query over recent data so an operator can see
// what the condition would have done before saving it.
export const AlertPreviewSchema = Type.Object({
  sql: Type.String(),
  reducedValue: Type.Union([Type.Number(), Type.Null()]),
  wouldFire: Type.Boolean(),
  sampleCount: Type.Integer(),
  series: Type.Array(
    Type.Object({
      name: Type.String(),
      value: Type.Union([Type.Number(), Type.Null()]),
      wouldFire: Type.Boolean(),
    }),
  ),
})
export type AlertPreview = Static<typeof AlertPreviewSchema>

export const AlertStateSchema = Type.Object({
  ruleId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  ruleUid: Type.String(),
  name: Type.String(),
  state: Type.String(),
  since: Type.Union([Type.String(), Type.Null()]),
})
export type AlertState = Static<typeof AlertStateSchema>

export const AlertOverviewSchema = Type.Object({
  status: Type.Union([
    Type.Literal('unconfigured'),
    Type.Literal('pending'),
    Type.Literal('active'),
    Type.Literal('failed'),
  ]),
  error: Type.Union([Type.String(), Type.Null()]),
  ruleCount: Type.Integer(),
  contactPointCount: Type.Integer(),
  appliedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  states: Type.Array(AlertStateSchema),
})
export type AlertOverview = Static<typeof AlertOverviewSchema>
