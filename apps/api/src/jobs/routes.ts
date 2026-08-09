import { ApiErrorSchema, JobListSchema, JobSchema } from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import { HttpError } from '../errors.js'
import type { HealthService } from '../health/service.js'
import type { AuthGuards } from '../auth/guards.js'
import type { AuthStore } from '../auth/store.js'
import type { JobRunner } from './runner.js'
import type { JobStore } from './store.js'

export function registerJobRoutes(
  app: FastifyInstance,
  dependencies: {
    store: JobStore
    runner: JobRunner
    health: HealthService
    guards: AuthGuards
    audit: AuthStore
  },
): void {
  const { store, runner, guards, audit } = dependencies

  app.get(
    '/api/v1/jobs',
    {
      preHandler: [guards.authenticate, guards.authorize('viewer')],
      schema: { response: { 200: JobListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema } },
    },
    async () => ({ jobs: await store.list() }),
  )

  app.get<{ Params: { id: string } }>(
    '/api/v1/jobs/:id',
    {
      preHandler: [guards.authenticate, guards.authorize('viewer')],
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const job = await store.get(request.params.id)
      if (!job) throw new HttpError(404, 'job_not_found', 'The job does not exist')
      return job
    },
  )

  app.post(
    '/api/v1/jobs/dependency-check',
    {
      preHandler: [guards.authenticate, guards.authorize('operator'), guards.csrf],
      schema: { response: { 202: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema } },
    },
    async (request, reply) => {
      const job = await store.enqueue({
        type: 'system.dependencies.check',
        requestedBy: request.auth!.user.id,
        timeoutMs: 15_000,
      })
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'job.created',
        resourceType: 'job',
        resourceId: job.id,
        outcome: 'success',
        metadata: { type: job.type },
      })
      return reply.code(202).send(job)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/cancel',
    {
      preHandler: [guards.authenticate, guards.authorize('operator'), guards.csrf],
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          204: Type.Null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await runner.cancel(request.params.id))) {
        throw new HttpError(404, 'job_not_cancellable', 'The job is not queued or running')
      }
      return reply.code(204).send()
    },
  )
}
