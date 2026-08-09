import { Type, type Static } from '@sinclair/typebox'

export const StoragePolicySchema = Type.Object({
  rawRetentionDays: Type.Integer({ minimum: 1, maximum: 365 }),
  fiveMinuteRetentionDays: Type.Integer({ minimum: 30, maximum: 3650 }),
  hourlyRetentionDays: Type.Integer({ minimum: 365, maximum: 36500 }),
})
export type StoragePolicy = Static<typeof StoragePolicySchema>

/**
 * `Composite`, not `Intersect`. An intersection is two schemas side by side, and
 * neither branch can close itself to unknown properties without rejecting the
 * other's — so the request accepted any field a caller cared to add. Compositing
 * merges them into one object that can be closed, which is the same guarantee
 * every other request schema gives.
 */
export const UpdateStoragePolicyRequestSchema = Type.Composite(
  [StoragePolicySchema, Type.Object({ confirmShortening: Type.Optional(Type.Boolean()) })],
  { additionalProperties: false },
)
export type UpdateStoragePolicyRequest = Static<typeof UpdateStoragePolicyRequestSchema>

export const StorageTableSchema = Type.Object({
  name: Type.String(),
  tier: Type.Union([Type.Literal('raw'), Type.Literal('5m'), Type.Literal('1h')]),
  exists: Type.Boolean(),
  materializedView: Type.Boolean(),
  walEnabled: Type.Boolean(),
  partitionBy: Type.Union([Type.String(), Type.Null()]),
  ttlValue: Type.Union([Type.Integer(), Type.Null()]),
  ttlUnit: Type.Union([Type.String(), Type.Null()]),
  rowCount: Type.Union([Type.Integer(), Type.Null()]),
})
export type StorageTable = Static<typeof StorageTableSchema>

export const StorageCapabilitySchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  status: Type.Union([Type.Literal('passed'), Type.Literal('operational')]),
  evidence: Type.String(),
})
export type StorageCapability = Static<typeof StorageCapabilitySchema>

export const StorageOverviewSchema = Type.Object({
  engine: Type.Literal('questdb'),
  decision: Type.Literal('accepted'),
  decisionSummary: Type.String(),
  connection: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('disabled')]),
  connectionMessage: Type.Union([Type.String(), Type.Null()]),
  policy: StoragePolicySchema,
  policyStatus: Type.Union([
    Type.Literal('unconfigured'),
    Type.Literal('pending'),
    Type.Literal('active'),
    Type.Literal('failed'),
  ]),
  policyError: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String({ format: 'date-time' }),
  appliedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  tables: Type.Array(StorageTableSchema),
  capabilities: Type.Array(StorageCapabilitySchema),
})
export type StorageOverview = Static<typeof StorageOverviewSchema>
