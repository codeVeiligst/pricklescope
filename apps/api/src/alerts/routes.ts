import {
  AlertOverviewSchema,
  AlertPreviewSchema,
  AlertRuleListSchema,
  AlertRuleSchema,
  ApiErrorSchema,
  ContactPointListSchema,
  ContactPointSchema,
  HealthAlertSettingsSchema,
  JobSchema,
  UpdateHealthAlertsRequestSchema,
  UpsertAlertRuleRequestSchema,
  UpsertContactPointRequestSchema,
  type UpdateHealthAlertsRequest,
  type UpsertAlertRuleRequest,
  type UpsertContactPointRequest,
} from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import { HttpError } from '../errors.js'
import type { JobStore } from '../jobs/store.js'
import type { AlertService, GrafanaNotification } from './service.js'

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

function badRequest(error: unknown): never {
  throw new HttpError(
    400,
    'alert_invalid',
    error instanceof Error ? error.message : 'The alert rule is not valid',
  )
}

export function registerAlertRoutes(
  app: FastifyInstance,
  dependencies: { service: AlertService; jobs: JobStore; guards: AuthGuards },
): void {
  const { service, jobs, guards } = dependencies
  const read = [guards.authenticate, guards.authorize('viewer')]
  const operate = [guards.authenticate, guards.authorize('operator'), guards.csrf]
  const administer = [guards.authenticate, guards.authorize('administrator'), guards.csrf]

  app.get(
    '/api/v1/alerts',
    {
      preHandler: read,
      schema: { response: { 200: AlertOverviewSchema, 401: ApiErrorSchema } },
    },
    () => service.overview(),
  )

  app.get(
    '/api/v1/alerts/rules',
    {
      preHandler: read,
      schema: { response: { 200: AlertRuleListSchema, 401: ApiErrorSchema } },
    },
    async () => ({ rules: await service.rules() }),
  )

  app.post<{ Body: UpsertAlertRuleRequest }>(
    '/api/v1/alerts/rules',
    {
      preHandler: operate,
      schema: {
        body: UpsertAlertRuleRequestSchema,
        response: { 201: AlertRuleSchema, 400: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      try {
        return await reply.code(201).send(await service.createRule(request.body))
      } catch (error) {
        return badRequest(error)
      }
    },
  )

  app.put<{ Params: { id: string }; Body: UpsertAlertRuleRequest }>(
    '/api/v1/alerts/rules/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParams,
        body: UpsertAlertRuleRequestSchema,
        response: { 200: AlertRuleSchema, 400: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async (request) => {
      try {
        return await service.updateRule(request.params.id, request.body)
      } catch (error) {
        return badRequest(error)
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/v1/alerts/rules/:id',
    { preHandler: operate, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await service.deleteRule(request.params.id)
      return reply.code(204).send()
    },
  )

  // The body is a rule definition, never SQL: the controller generates the query.
  app.post<{ Body: UpsertAlertRuleRequest }>(
    '/api/v1/alerts/preview',
    {
      preHandler: operate,
      // Runs the rule's real query against QuestDB, so it is metered like the
      // graph endpoints rather than like a metadata read.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        body: UpsertAlertRuleRequestSchema,
        response: { 200: AlertPreviewSchema, 400: ApiErrorSchema },
      },
    },
    async (request) => {
      try {
        return await service.preview(request.body)
      } catch (error) {
        return badRequest(error)
      }
    },
  )

  // The controller's own health alerts. Reading is viewer, changing is
  // administrator: where the system's own failures get sent is not an
  // operator's call, and it is the same reasoning that gates /sync/apply.
  app.get(
    '/api/v1/alerts/health',
    {
      preHandler: read,
      schema: { response: { 200: HealthAlertSettingsSchema, 401: ApiErrorSchema } },
    },
    () => service.healthAlerts(),
  )

  app.put<{ Body: UpdateHealthAlertsRequest }>(
    '/api/v1/alerts/health',
    {
      preHandler: administer,
      schema: {
        body: UpdateHealthAlertsRequestSchema,
        response: {
          200: HealthAlertSettingsSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      service.updateHealthAlerts(request.body, request.auth!.user.id).catch(badRequest),
  )

  app.get(
    '/api/v1/alerts/contact-points',
    {
      preHandler: read,
      schema: { response: { 200: ContactPointListSchema, 401: ApiErrorSchema } },
    },
    async () => ({ contactPoints: await service.contactPoints() }),
  )

  app.post<{ Body: UpsertContactPointRequest }>(
    '/api/v1/alerts/contact-points',
    {
      preHandler: operate,
      schema: {
        body: UpsertContactPointRequestSchema,
        response: { 201: ContactPointSchema, 400: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      try {
        return await reply.code(201).send(await service.upsertContactPoint(request.body))
      } catch (error) {
        return badRequest(error)
      }
    },
  )

  app.put<{ Params: { id: string }; Body: UpsertContactPointRequest }>(
    '/api/v1/alerts/contact-points/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParams,
        body: UpsertContactPointRequestSchema,
        response: { 200: ContactPointSchema, 400: ApiErrorSchema },
      },
    },
    async (request) => {
      try {
        return await service.upsertContactPoint(request.body, request.params.id)
      } catch (error) {
        return badRequest(error)
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/v1/alerts/contact-points/:id',
    { preHandler: operate, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await service.deleteContactPoint(request.params.id)
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/v1/alerts/contact-points/:id/test',
    {
      preHandler: operate,
      schema: { params: IdParams, response: { 204: Type.Null(), 400: ApiErrorSchema } },
    },
    async (request, reply) => {
      try {
        await service.testContactPoint(request.params.id)
        return await reply.code(204).send()
      } catch (error) {
        return badRequest(error)
      }
    },
  )

  // Grafana calls this when an email contact point fires. It is authenticated by
  // a per-contact bearer token the controller generated, not by a user session,
  // so it deliberately sits outside the session guards.
  app.post<{ Params: { ref: string }; Body: GrafanaNotification }>(
    '/api/v1/alerts/notify/:ref',
    {
      // Address, for the same reason as the login route: this endpoint has no
      // session, so the global key would let a caller choose their own bucket.
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => `notify:${request.ip}`,
        },
      },
      schema: {
        params: Type.Object({ ref: Type.String({ format: 'uuid' }) }),
        body: Type.Unknown(),
        response: { 204: Type.Null(), 401: ApiErrorSchema, 502: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const header = request.headers.authorization ?? ''
      const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : null
      await service.deliverNotification(request.params.ref, bearer, request.body)
      return reply.code(204).send()
    },
  )

  app.post(
    '/api/v1/alerts/reconcile',
    {
      preHandler: [guards.authenticate, guards.authorize('administrator'), guards.csrf],
      schema: { response: { 202: JobSchema, 403: ApiErrorSchema } },
    },
    async (request, reply) => {
      const job = await jobs.enqueue({
        type: 'alerts.reconcile',
        payload: { actorUserId: request.auth!.user.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 120_000,
      })
      return reply.code(202).send(job)
    },
  )
}
