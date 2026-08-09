import { ApiErrorSchema, SystemHealthSchema } from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import type { AppConfig } from '../config.js'
import type { AuthGuards } from '../auth/guards.js'
import type { HealthService } from '../health/service.js'

const ProbeSchema = Type.Object({
  status: Type.String(),
  version: Type.String(),
})

export function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: { config: AppConfig; health: HealthService; guards: AuthGuards },
): void {
  const { config, health, guards } = dependencies

  app.get('/health/live', { schema: { response: { 200: ProbeSchema } } }, () => ({
    status: 'alive',
    version: config.version,
  }))

  app.get(
    '/health/ready',
    { schema: { response: { 200: ProbeSchema, 503: ProbeSchema } } },
    async (_request, reply) => {
      const result = await health.check()
      const status = result.status === 'unavailable' ? 'unavailable' : 'ready'
      return reply.code(result.status === 'unavailable' ? 503 : 200).send({
        status,
        version: config.version,
      })
    },
  )

  app.get(
    '/api/v1/system/health',
    {
      preHandler: [guards.authenticate, guards.authorize('viewer')],
      schema: {
        response: { 200: SystemHealthSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async () => health.check(),
  )

  app.get('/api/v1', () => ({ name: 'PrickleScope API', version: config.version }))
}
