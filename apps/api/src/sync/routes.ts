import { ApiErrorSchema, SyncApplyResultSchema, SyncStatusSchema } from '@pricklescope/contracts'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import type { SyncService } from './service.js'

export function registerSyncRoutes(
  app: FastifyInstance,
  dependencies: { service: SyncService; guards: AuthGuards },
): void {
  const { service, guards } = dependencies

  app.get(
    '/api/v1/sync',
    {
      preHandler: [guards.authenticate, guards.authorize('viewer')],
      schema: { response: { 200: SyncStatusSchema, 401: ApiErrorSchema } },
    },
    () => service.status(),
  )

  // Applying is a set of jobs, never inline work: each reconcile talks to an
  // external engine and belongs on the job runner like every other one.
  //
  // Administrator, not operator. This enqueues the same jobs the per-domain
  // routes do, and three of the four — storage, Grafana, alerts — require an
  // administrator there. At operator level this endpoint was a way around that:
  // one call applied a retention policy an administrator had set but not yet
  // enacted, rewrote the managed dashboards, and pushed alert rules, none of
  // which an operator can trigger directly. Nothing is lost, because the one
  // target an operator may reconcile has its own route.
  app.post(
    '/api/v1/sync/apply',
    {
      preHandler: [guards.authenticate, guards.authorize('administrator'), guards.csrf],
      schema: { response: { 202: SyncApplyResultSchema, 403: ApiErrorSchema } },
    },
    async (request, reply) => reply.code(202).send(await service.apply(request.auth!.user.id)),
  )
}
