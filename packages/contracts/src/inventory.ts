import { Type, type Static } from '@sinclair/typebox'

const IdentifierSchema = Type.String({ format: 'uuid' })
const TimestampSchema = Type.String({ format: 'date-time' })
const NullableStringSchema = Type.Union([Type.String(), Type.Null()])

export const SiteSchema = Type.Object({
  id: IdentifierSchema,
  parentId: Type.Union([IdentifierSchema, Type.Null()]),
  name: Type.String(),
  description: NullableStringSchema,
  path: Type.Array(Type.Object({ id: IdentifierSchema, name: Type.String() })),
  depth: Type.Integer({ minimum: 0 }),
  childCount: Type.Integer({ minimum: 0 }),
  sourceCount: Type.Integer({ minimum: 0 }),
  totalSourceCount: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Site = Static<typeof SiteSchema>
export const SiteListSchema = Type.Object({ sites: Type.Array(SiteSchema) })

export const CreateSiteRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    parentId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
  },
  { additionalProperties: false },
)
export type CreateSiteRequest = Static<typeof CreateSiteRequestSchema>

export const UpdateSiteRequestSchema = Type.Partial(CreateSiteRequestSchema, {
  additionalProperties: false,
})
export type UpdateSiteRequest = Static<typeof UpdateSiteRequestSchema>

export const SnmpVersionSchema = Type.Union([Type.Literal('2c'), Type.Literal('3')])
export type SnmpVersion = Static<typeof SnmpVersionSchema>

export const SnmpSecurityLevelSchema = Type.Union([
  Type.Literal('noAuthNoPriv'),
  Type.Literal('authNoPriv'),
  Type.Literal('authPriv'),
])
export type SnmpSecurityLevel = Static<typeof SnmpSecurityLevelSchema>

export const SnmpAuthProtocolSchema = Type.Union([
  Type.Literal('sha'),
  Type.Literal('sha224'),
  Type.Literal('sha256'),
  Type.Literal('sha384'),
  Type.Literal('sha512'),
])
export type SnmpAuthProtocol = Static<typeof SnmpAuthProtocolSchema>

export const SnmpPrivacyProtocolSchema = Type.Union([
  Type.Literal('aes'),
  Type.Literal('aes256b'),
  Type.Literal('aes256r'),
])
export type SnmpPrivacyProtocol = Static<typeof SnmpPrivacyProtocolSchema>

export const SnmpCredentialSchema = Type.Object({
  id: IdentifierSchema,
  name: Type.String(),
  version: SnmpVersionSchema,
  username: NullableStringSchema,
  securityLevel: Type.Union([SnmpSecurityLevelSchema, Type.Null()]),
  authProtocol: Type.Union([SnmpAuthProtocolSchema, Type.Null()]),
  privacyProtocol: Type.Union([SnmpPrivacyProtocolSchema, Type.Null()]),
  secretConfigured: Type.Boolean(),
  sourceCount: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type SnmpCredential = Static<typeof SnmpCredentialSchema>
export const SnmpCredentialListSchema = Type.Object({
  credentials: Type.Array(SnmpCredentialSchema),
})

/**
 * Free text a person types that later reaches a generated artifact.
 *
 * A source name is rendered into Telegraf's TOML, where a newline once ended the
 * comment it sat in and turned the rest of the name into a real input. The
 * adapter refuses control characters and checks its own output, but rejecting
 * them here is what turns that into a clear message on the form instead of a
 * job that fails later.
 */
const SafeText = (options: { minLength?: number; maxLength: number } = { maxLength: 128 }) =>
  Type.String({ ...options, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*$' })

export const CreateSnmpCredentialRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: SnmpVersionSchema,
    community: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    username: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    securityLevel: Type.Optional(SnmpSecurityLevelSchema),
    authProtocol: Type.Optional(SnmpAuthProtocolSchema),
    authPassword: Type.Optional(Type.String({ minLength: 8, maxLength: 512 })),
    privacyProtocol: Type.Optional(SnmpPrivacyProtocolSchema),
    privacyPassword: Type.Optional(Type.String({ minLength: 8, maxLength: 512 })),
  },
  { additionalProperties: false },
)
export type CreateSnmpCredentialRequest = Static<typeof CreateSnmpCredentialRequestSchema>

export const UpdateSnmpCredentialRequestSchema = Type.Partial(
  Type.Omit(CreateSnmpCredentialRequestSchema, ['version']),
  { additionalProperties: false },
)
export type UpdateSnmpCredentialRequest = Static<typeof UpdateSnmpCredentialRequestSchema>

export const PollingProfileSchema = Type.Object({
  id: IdentifierSchema,
  name: Type.String(),
  description: NullableStringSchema,
  intervalSeconds: Type.Integer({ minimum: 10 }),
  timeoutMs: Type.Integer({ minimum: 250 }),
  retries: Type.Integer({ minimum: 0 }),
  collectSystem: Type.Boolean(),
  collectInterfaces: Type.Boolean(),
  systemDefined: Type.Boolean(),
  sourceCount: Type.Integer({ minimum: 0 }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type PollingProfile = Static<typeof PollingProfileSchema>
export const PollingProfileListSchema = Type.Object({ profiles: Type.Array(PollingProfileSchema) })

export const CreatePollingProfileRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    intervalSeconds: Type.Integer({ minimum: 10, maximum: 86_400 }),
    timeoutMs: Type.Integer({ minimum: 250, maximum: 60_000 }),
    retries: Type.Integer({ minimum: 0, maximum: 10 }),
    collectSystem: Type.Boolean(),
    collectInterfaces: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type CreatePollingProfileRequest = Static<typeof CreatePollingProfileRequestSchema>

export const UpdatePollingProfileRequestSchema = Type.Partial(CreatePollingProfileRequestSchema, {
  additionalProperties: false,
})
export type UpdatePollingProfileRequest = Static<typeof UpdatePollingProfileRequestSchema>

export const CollectorSelectionSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('telegraf'),
  Type.Literal('alloy'),
])
export type CollectorSelection = Static<typeof CollectorSelectionSchema>
export const CollectorKindSchema = Type.Union([Type.Literal('telegraf'), Type.Literal('alloy')])
export type CollectorKind = Static<typeof CollectorKindSchema>

export const CollectorCapabilitySchema = Type.Object({
  kind: CollectorKindSchema,
  label: Type.String(),
  available: Type.Boolean(),
  supportedInputs: Type.Array(Type.String()),
  reason: Type.String(),
})
export type CollectorCapability = Static<typeof CollectorCapabilitySchema>
export const CollectorCapabilityListSchema = Type.Object({
  recommended: CollectorKindSchema,
  capabilities: Type.Array(CollectorCapabilitySchema),
})

export const SourceStatusSchema = Type.Union([
  Type.Literal('new'),
  Type.Literal('testing'),
  Type.Literal('reachable'),
  Type.Literal('unreachable'),
  Type.Literal('inventory_pending'),
  Type.Literal('ready'),
])
export type SourceStatus = Static<typeof SourceStatusSchema>

const SourceSiteSchema = Type.Union([
  Type.Object({ id: IdentifierSchema, name: Type.String() }),
  Type.Null(),
])
const SourceCredentialSchema = Type.Object({
  id: IdentifierSchema,
  name: Type.String(),
  version: SnmpVersionSchema,
})
const SourceProfileSchema = Type.Object({
  id: IdentifierSchema,
  name: Type.String(),
  intervalSeconds: Type.Integer(),
})

export const SourceSchema = Type.Object({
  id: IdentifierSchema,
  name: Type.String(),
  target: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  transport: Type.Union([Type.Literal('udp4'), Type.Literal('udp6')]),
  enabled: Type.Boolean(),
  status: SourceStatusSchema,
  tags: Type.Array(Type.String()),
  site: SourceSiteSchema,
  credential: SourceCredentialSchema,
  profile: SourceProfileSchema,
  collectorSelection: CollectorSelectionSchema,
  collector: CollectorKindSchema,
  systemName: NullableStringSchema,
  systemDescription: NullableStringSchema,
  sysObjectId: NullableStringSchema,
  lastTestAt: Type.Union([TimestampSchema, Type.Null()]),
  lastTestMessage: NullableStringSchema,
  lastInventoryAt: Type.Union([TimestampSchema, Type.Null()]),
  pendingSnapshotId: Type.Union([IdentifierSchema, Type.Null()]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Source = Static<typeof SourceSchema>
export const SourceListSchema = Type.Object({ sources: Type.Array(SourceSchema) })

export const CreateSourceRequestSchema = Type.Object(
  {
    name: SafeText({ minLength: 1, maxLength: 128 }),
    target: SafeText({ minLength: 1, maxLength: 253 }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    transport: Type.Optional(Type.Union([Type.Literal('udp4'), Type.Literal('udp6')])),
    enabled: Type.Optional(Type.Boolean()),
    tags: Type.Optional(
      Type.Array(SafeText({ minLength: 1, maxLength: 64 }), { maxItems: 20, uniqueItems: true }),
    ),
    siteId: Type.Optional(Type.Union([IdentifierSchema, Type.Null()])),
    credentialId: IdentifierSchema,
    profileId: IdentifierSchema,
    collectorSelection: Type.Optional(CollectorSelectionSchema),
  },
  { additionalProperties: false },
)
export type CreateSourceRequest = Static<typeof CreateSourceRequestSchema>

export const UpdateSourceRequestSchema = Type.Partial(CreateSourceRequestSchema, {
  additionalProperties: false,
})
export type UpdateSourceRequest = Static<typeof UpdateSourceRequestSchema>

export const InventorySystemSchema = Type.Object({
  name: NullableStringSchema,
  description: NullableStringSchema,
  objectId: NullableStringSchema,
  location: NullableStringSchema,
  contact: NullableStringSchema,
  uptimeTicks: Type.Union([Type.Number(), Type.Null()]),
})
export type InventorySystem = Static<typeof InventorySystemSchema>

export const InventoryInterfaceSchema = Type.Object({
  index: Type.Integer(),
  name: NullableStringSchema,
  description: NullableStringSchema,
  alias: NullableStringSchema,
  type: Type.Union([Type.Integer(), Type.Null()]),
  mtu: Type.Union([Type.Integer(), Type.Null()]),
  speedBps: Type.Union([Type.Number(), Type.Null()]),
  macAddress: NullableStringSchema,
  adminStatus: Type.Union([Type.Integer(), Type.Null()]),
  operStatus: Type.Union([Type.Integer(), Type.Null()]),
})
export type InventoryInterface = Static<typeof InventoryInterfaceSchema>

export const InventoryFieldChangeSchema = Type.Object({
  field: Type.String(),
  before: Type.Unknown(),
  after: Type.Unknown(),
})
export const InventoryInterfaceChangeSchema = Type.Object({
  index: Type.Integer(),
  name: NullableStringSchema,
  changes: Type.Array(InventoryFieldChangeSchema),
})
export const InventoryDiffSchema = Type.Object({
  firstSnapshot: Type.Boolean(),
  systemChanges: Type.Array(InventoryFieldChangeSchema),
  addedInterfaces: Type.Array(InventoryInterfaceSchema),
  removedInterfaces: Type.Array(InventoryInterfaceSchema),
  changedInterfaces: Type.Array(InventoryInterfaceChangeSchema),
})
export type InventoryDiff = Static<typeof InventoryDiffSchema>

export const InventorySnapshotSchema = Type.Object({
  id: IdentifierSchema,
  sourceId: IdentifierSchema,
  jobId: Type.Union([IdentifierSchema, Type.Null()]),
  observedAt: TimestampSchema,
  appliedAt: Type.Union([TimestampSchema, Type.Null()]),
  partial: Type.Boolean(),
  errors: Type.Array(Type.String()),
  system: InventorySystemSchema,
  interfaces: Type.Array(InventoryInterfaceSchema),
  diff: InventoryDiffSchema,
})
export type InventorySnapshot = Static<typeof InventorySnapshotSchema>
export const InventorySnapshotListSchema = Type.Object({
  snapshots: Type.Array(InventorySnapshotSchema),
})
