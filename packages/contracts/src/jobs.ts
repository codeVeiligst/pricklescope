import { Type, type Static } from '@sinclair/typebox'

export const JobStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
])
export type JobStatus = Static<typeof JobStatusSchema>

export const JobSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  type: Type.String(),
  status: JobStatusSchema,
  progress: Type.Integer({ minimum: 0, maximum: 100 }),
  result: Type.Union([Type.Unknown(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  requestedBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  startedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  finishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})
export type Job = Static<typeof JobSchema>

export const JobListSchema = Type.Object({ jobs: Type.Array(JobSchema) })
export type JobList = Static<typeof JobListSchema>
