import { Type, type Static } from '@sinclair/typebox'

import { JobSchema } from './jobs.js'

/**
 * Whether each reconciled engine still matches the desired state the controller
 * holds. Every target answers by comparing what it *would* write against what it
 * last wrote — a content hash or a stored revision — never by guessing from
 * timestamps, so "up to date" means the artifact is identical.
 */
export const SyncTargetKeySchema = Type.Union([
  Type.Literal('collectors'),
  Type.Literal('grafana'),
  Type.Literal('alerts'),
  Type.Literal('storage'),
])
export type SyncTargetKey = Static<typeof SyncTargetKeySchema>

export const SyncTargetSchema = Type.Object({
  key: SyncTargetKeySchema,
  label: Type.String(),
  /** True when applying would change the engine. */
  pending: Type.Boolean(),
  /** One line an operator can act on, in their words. */
  detail: Type.String(),
  lastAppliedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  /** Set when the target cannot be applied at all, with the reason. */
  blocked: Type.Union([Type.String(), Type.Null()]),
})
export type SyncTarget = Static<typeof SyncTargetSchema>

export const SyncStatusSchema = Type.Object({
  pendingCount: Type.Integer(),
  targets: Type.Array(SyncTargetSchema),
})
export type SyncStatus = Static<typeof SyncStatusSchema>

export const SyncApplyResultSchema = Type.Object({
  jobs: Type.Array(JobSchema),
})
export type SyncApplyResult = Static<typeof SyncApplyResultSchema>
