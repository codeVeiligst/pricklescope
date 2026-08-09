import { ApiErrorSchema, GrafanaOverviewSchema, JobSchema } from '@pricklescope/contracts'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import type { JobStore } from '../jobs/store.js'
import type { GrafanaService } from './service.js'

export function registerGrafanaRoutes(
  app: FastifyInstance,
  dependencies: { service: GrafanaService; jobs: JobStore; guards: AuthGuards },
): void {
  const { service, jobs, guards } = dependencies

  app.get(
    '/api/v1/grafana',
    {
      preHandler: [guards.authenticate, guards.authorize('viewer')],
      schema: {
        response: {
          200: GrafanaOverviewSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    () => service.overview(),
  )

  app.post(
    '/api/v1/grafana/reconcile',
    {
      preHandler: [guards.authenticate, guards.authorize('administrator'), guards.csrf],
      schema: {
        response: {
          202: JobSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const job = await jobs.enqueue({
        type: 'grafana.reconcile',
        payload: { actorUserId: request.auth!.user.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 120_000,
      })
      return reply.code(202).send(job)
    },
  )
}
