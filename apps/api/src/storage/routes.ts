import {
  ApiErrorSchema,
  JobSchema,
  StorageOverviewSchema,
  UpdateStoragePolicyRequestSchema,
  type UpdateStoragePolicyRequest,
} from '@pricklescope/contracts'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import type { JobStore } from '../jobs/store.js'
import type { StorageService } from './service.js'

export function registerStorageRoutes(
  app: FastifyInstance,
  dependencies: { service: StorageService; jobs: JobStore; guards: AuthGuards },
): void {
  const { service, jobs, guards } = dependencies
  const read = [guards.authenticate, guards.authorize('viewer')]
  const administer = [guards.authenticate, guards.authorize('administrator'), guards.csrf]

  app.get(
    '/api/v1/storage',
    {
      preHandler: read,
      schema: {
        response: { 200: StorageOverviewSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    () => service.overview(),
  )

  app.put<{ Body: UpdateStoragePolicyRequest }>(
    '/api/v1/storage/policy',
    {
      preHandler: administer,
      schema: {
        body: UpdateStoragePolicyRequestSchema,
        response: {
          202: JobSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      await service.updatePolicy(request.body, request.auth!.user.id)
      const job = await jobs.enqueue({
        type: 'storage.questdb.reconcile',
        payload: { actorUserId: request.auth!.user.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 60_000,
      })
      return reply.code(202).send(job)
    },
  )

  app.post(
    '/api/v1/storage/reconcile',
    {
      preHandler: administer,
      schema: { response: { 202: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema } },
    },
    async (request, reply) => {
      const job = await jobs.enqueue({
        type: 'storage.questdb.reconcile',
        payload: { actorUserId: request.auth!.user.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 60_000,
      })
      return reply.code(202).send(job)
    },
  )
}
