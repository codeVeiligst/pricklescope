import { Type, type Static } from '@sinclair/typebox'

export const CollectorRevisionStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('superseded'),
  Type.Literal('failed'),
])
export type CollectorRevisionStatus = Static<typeof CollectorRevisionStatusSchema>

export const CollectorRevisionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  revisionNumber: Type.Integer({ minimum: 1 }),
  collector: Type.Literal('telegraf'),
  status: CollectorRevisionStatusSchema,
  reason: Type.Union([Type.Literal('reconcile'), Type.Literal('rollback')]),
  sourceRevisionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  contentHash: Type.String({ minLength: 64, maxLength: 64 }),
  effectiveConfig: Type.String(),
  sourceCount: Type.Integer({ minimum: 0 }),
  checkCount: Type.Integer({ minimum: 0 }),
  error: Type.Union([Type.String(), Type.Null()]),
  createdBy: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  activatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})
export type CollectorRevision = Static<typeof CollectorRevisionSchema>

export const CollectorRevisionListSchema = Type.Object({
  revisions: Type.Array(CollectorRevisionSchema),
})

export const TelegrafCollectorStatusSchema = Type.Object({
  collector: Type.Literal('telegraf'),
  state: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('disabled')]),
  message: Type.Union([Type.String(), Type.Null()]),
  checkedAt: Type.String({ format: 'date-time' }),
  activeRevision: Type.Union([CollectorRevisionSchema, Type.Null()]),
})
export type TelegrafCollectorStatus = Static<typeof TelegrafCollectorStatusSchema>
