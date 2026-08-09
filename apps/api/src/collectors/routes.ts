import {
  ApiErrorSchema,
  CollectorRevisionListSchema,
  JobSchema,
  TelegrafCollectorStatusSchema,
} from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import type { JobStore } from '../jobs/store.js'
import type { TelegrafReconciliationService } from './service.js'

const RevisionParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })

export function registerCollectorRoutes(
  app: FastifyInstance,
  dependencies: {
    service: TelegrafReconciliationService
    jobs: JobStore
    guards: AuthGuards
  },
): void {
  const { service, jobs, guards } = dependencies
  const read = [guards.authenticate, guards.authorize('viewer')]
  const operate = [guards.authenticate, guards.authorize('operator'), guards.csrf]

  app.get(
    '/api/v1/collectors/telegraf',
    {
      preHandler: read,
      schema: {
        response: { 200: TelegrafCollectorStatusSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    () => service.status(),
  )

  app.get(
    '/api/v1/collectors/telegraf/revisions',
    {
      preHandler: read,
      schema: {
        response: { 200: CollectorRevisionListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async () => ({ revisions: await service.listRevisions() }),
  )

  app.post(
    '/api/v1/collectors/telegraf/reconcile',
    {
      preHandler: operate,
      schema: {
        response: { 202: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const job = await jobs.enqueue({
        type: 'collector.telegraf.reconcile',
        payload: { actorUserId: request.auth!.user.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 30_000,
      })
      return reply.code(202).send(job)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/v1/collectors/telegraf/revisions/:id/rollback',
    {
      preHandler: operate,
      schema: {
        params: RevisionParamsSchema,
        response: { 202: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const job = await jobs.enqueue({
        type: 'collector.telegraf.rollback',
        payload: { actorUserId: request.auth!.user.id, revisionId: request.params.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 30_000,
      })
      return reply.code(202).send(job)
    },
  )
}
