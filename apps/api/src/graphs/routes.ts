import {
  ApiErrorSchema,
  FleetGraphsSchema,
  InterfaceGraphsSchema,
  GraphRangeQuerySchema,
  SourceGraphsSchema,
  type GraphRangeQuery,
} from '@pricklescope/contracts'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'

import type { AuthGuards } from '../auth/guards.js'
import { HttpError } from '../errors.js'
import { resolveRange, type GraphService } from './service.js'

function range(query: GraphRangeQuery) {
  try {
    return resolveRange(query.from, query.to)
  } catch (error) {
    throw new HttpError(
      400,
      'range_invalid',
      error instanceof Error ? error.message : 'The requested range is not valid',
    )
  }
}

export function registerGraphRoutes(
  app: FastifyInstance,
  dependencies: { service: GraphService; guards: AuthGuards },
): void {
  const { service, guards } = dependencies
  const read = [guards.authenticate, guards.authorize('viewer')]
  // Every one of these runs a QuestDB query. A dashboard redrawing on each range
  // change is nowhere near this; a script walking source IDs is.
  const metered = { rateLimit: { max: 120, timeWindow: '1 minute' } }

  app.get<{ Querystring: GraphRangeQuery }>(
    '/api/v1/graphs/fleet',
    {
      preHandler: read,
      config: metered,
      schema: {
        querystring: GraphRangeQuerySchema,
        response: { 200: FleetGraphsSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    (request) => service.fleet(range(request.query)),
  )

  app.get<{ Params: { id: string }; Querystring: GraphRangeQuery }>(
    '/api/v1/graphs/sources/:id',
    {
      preHandler: read,
      config: metered,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: GraphRangeQuerySchema,
        response: { 200: SourceGraphsSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    (request) => service.source(request.params.id, range(request.query)),
  )

  app.get<{ Params: { id: string }; Querystring: GraphRangeQuery }>(
    '/api/v1/graphs/sources/:id/interfaces',
    {
      preHandler: read,
      config: metered,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        querystring: GraphRangeQuerySchema,
        response: { 200: InterfaceGraphsSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    (request) => service.interfaces(request.params.id, range(request.query)),
  )
}
