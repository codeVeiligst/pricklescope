import {
  ApiErrorSchema,
  CollectorCapabilityListSchema,
  CreatePollingProfileRequestSchema,
  CreateSiteRequestSchema,
  CreateSnmpCredentialRequestSchema,
  CreateSourceRequestSchema,
  InventorySnapshotListSchema,
  InventorySnapshotSchema,
  JobSchema,
  PollingProfileListSchema,
  PollingProfileSchema,
  SiteListSchema,
  SiteSchema,
  SnmpCredentialListSchema,
  SnmpCredentialSchema,
  SourceListSchema,
  SourceSchema,
  UpdatePollingProfileRequestSchema,
  UpdateSiteRequestSchema,
  UpdateSnmpCredentialRequestSchema,
  UpdateSourceRequestSchema,
  type CreatePollingProfileRequest,
  type CreateSiteRequest,
  type CreateSnmpCredentialRequest,
  type CreateSourceRequest,
  type UpdatePollingProfileRequest,
  type UpdateSiteRequest,
  type UpdateSnmpCredentialRequest,
  type UpdateSourceRequest,
} from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import type { AuthStore } from '../auth/store.js'
import { HttpError } from '../errors.js'
import type { JobStore } from '../jobs/store.js'
import type { CredentialService } from './service.js'
import { normalizedSourceInput, resolveCollector, validateTarget } from './service.js'
import type { InventoryStore } from './store.js'

const IdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
type IdParams = { id: string }

function missing(resource: string): HttpError {
  return new HttpError(
    404,
    `${resource}_not_found`,
    `The ${resource.replaceAll('_', ' ')} does not exist`,
  )
}

function requireProfileMetrics(input: {
  collectSystem?: boolean
  collectInterfaces?: boolean
}): void {
  if (input.collectSystem === false && input.collectInterfaces === false) {
    throw new HttpError(400, 'profile_invalid', 'A profile must collect at least one metric group')
  }
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  dependencies: {
    store: InventoryStore
    credentials: CredentialService
    jobs: JobStore
    guards: AuthGuards
    audit: AuthStore
  },
): void {
  const { store, credentials, jobs, guards, audit } = dependencies
  const read = [guards.authenticate, guards.authorize('viewer')]
  const operate = [guards.authenticate, guards.authorize('operator'), guards.csrf]
  const administer = [guards.authenticate, guards.authorize('administrator'), guards.csrf]

  app.get(
    '/api/v1/sites',
    {
      preHandler: read,
      schema: { response: { 200: SiteListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema } },
    },
    async () => ({ sites: await store.listSites() }),
  )

  app.post<{ Body: CreateSiteRequest }>(
    '/api/v1/sites',
    {
      preHandler: operate,
      schema: {
        body: CreateSiteRequestSchema,
        response: {
          201: SiteSchema,
          400: ApiErrorSchema,
          409: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const parentIssue = await store.siteParentIssue(null, request.body.parentId ?? null)
      if (parentIssue === 'missing') throw missing('parent_site')
      const site = await store.createSite(request.body)
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'site.created',
        resourceType: 'site',
        resourceId: site.id,
        outcome: 'success',
        metadata: { name: site.name },
      })
      return reply.code(201).send(site)
    },
  )

  app.patch<{ Params: IdParams; Body: UpdateSiteRequest }>(
    '/api/v1/sites/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        body: UpdateSiteRequestSchema,
        response: {
          200: SiteSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      if (request.body.parentId !== undefined) {
        const parentIssue = await store.siteParentIssue(request.params.id, request.body.parentId)
        if (parentIssue === 'missing') throw missing('parent_site')
        if (parentIssue === 'cycle') {
          throw new HttpError(400, 'site_cycle', 'A site cannot be moved below itself')
        }
      }
      const site = await store.updateSite(request.params.id, request.body)
      if (!site) throw missing('site')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'site.updated',
        resourceType: 'site',
        resourceId: site.id,
        outcome: 'success',
        metadata: { fields: Object.keys(request.body) },
      })
      return site
    },
  )

  app.delete<{ Params: IdParams }>(
    '/api/v1/sites/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        response: {
          204: Type.Null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (await store.siteHasChildren(request.params.id)) {
        throw new HttpError(
          409,
          'site_has_children',
          'Move or remove this site’s child locations before deleting it',
        )
      }
      if (!(await store.deleteSite(request.params.id))) throw missing('site')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'site.deleted',
        resourceType: 'site',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: {},
      })
      return reply.code(204).send()
    },
  )

  app.get(
    '/api/v1/credentials/snmp',
    {
      preHandler: [guards.authenticate, guards.authorize('operator')],
      schema: {
        response: { 200: SnmpCredentialListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async () => ({ credentials: await store.listCredentials() }),
  )

  app.post<{ Body: CreateSnmpCredentialRequest }>(
    '/api/v1/credentials/snmp',
    {
      preHandler: administer,
      schema: {
        body: CreateSnmpCredentialRequestSchema,
        response: {
          201: SnmpCredentialSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const credential = await credentials.create(request.body)
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'credential.created',
        resourceType: 'snmp_credential',
        resourceId: credential.id,
        outcome: 'success',
        metadata: { name: credential.name, version: credential.version },
      })
      return reply.code(201).send(credential)
    },
  )

  app.patch<{ Params: IdParams; Body: UpdateSnmpCredentialRequest }>(
    '/api/v1/credentials/snmp/:id',
    {
      preHandler: administer,
      schema: {
        params: IdParamsSchema,
        body: UpdateSnmpCredentialRequestSchema,
        response: {
          200: SnmpCredentialSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const credential = await credentials.update(request.params.id, request.body)
      if (!credential) throw missing('snmp_credential')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'credential.updated',
        resourceType: 'snmp_credential',
        resourceId: credential.id,
        outcome: 'success',
        metadata: {
          fields: Object.keys(request.body).filter(
            (field) => !['community', 'authPassword', 'privacyPassword'].includes(field),
          ),
          secretRotated: Boolean(
            request.body.community || request.body.authPassword || request.body.privacyPassword,
          ),
        },
      })
      return credential
    },
  )

  app.delete<{ Params: IdParams }>(
    '/api/v1/credentials/snmp/:id',
    {
      preHandler: administer,
      schema: {
        params: IdParamsSchema,
        response: {
          204: Type.Null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await store.deleteCredential(request.params.id))) throw missing('snmp_credential')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'credential.deleted',
        resourceType: 'snmp_credential',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: {},
      })
      return reply.code(204).send()
    },
  )

  app.get(
    '/api/v1/polling-profiles',
    {
      preHandler: read,
      schema: {
        response: { 200: PollingProfileListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async () => ({ profiles: await store.listProfiles() }),
  )

  app.post<{ Body: CreatePollingProfileRequest }>(
    '/api/v1/polling-profiles',
    {
      preHandler: operate,
      schema: {
        body: CreatePollingProfileRequestSchema,
        response: {
          201: PollingProfileSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      requireProfileMetrics(request.body)
      const profile = await store.createProfile(request.body)
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'polling_profile.created',
        resourceType: 'polling_profile',
        resourceId: profile.id,
        outcome: 'success',
        metadata: { name: profile.name },
      })
      return reply.code(201).send(profile)
    },
  )

  app.patch<{ Params: IdParams; Body: UpdatePollingProfileRequest }>(
    '/api/v1/polling-profiles/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        body: UpdatePollingProfileRequestSchema,
        response: {
          200: PollingProfileSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const current = await store.getProfile(request.params.id)
      if (!current) throw missing('polling_profile')
      if (current.systemDefined) {
        throw new HttpError(400, 'profile_read_only', 'Built-in polling profiles cannot be changed')
      }
      requireProfileMetrics({
        collectSystem: request.body.collectSystem ?? current.collectSystem,
        collectInterfaces: request.body.collectInterfaces ?? current.collectInterfaces,
      })
      const profile = await store.updateProfile(request.params.id, request.body)
      if (!profile) throw missing('polling_profile')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'polling_profile.updated',
        resourceType: 'polling_profile',
        resourceId: profile.id,
        outcome: 'success',
        metadata: { fields: Object.keys(request.body) },
      })
      return profile
    },
  )

  app.delete<{ Params: IdParams }>(
    '/api/v1/polling-profiles/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        response: {
          204: Type.Null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await store.deleteProfile(request.params.id))) throw missing('polling_profile')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'polling_profile.deleted',
        resourceType: 'polling_profile',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: {},
      })
      return reply.code(204).send()
    },
  )

  app.get(
    '/api/v1/collectors/capabilities',
    {
      preHandler: read,
      schema: {
        response: {
          200: CollectorCapabilityListSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    () => ({
      recommended: 'telegraf' as const,
      capabilities: [
        {
          kind: 'telegraf' as const,
          label: 'Telegraf',
          available: true,
          supportedInputs: ['snmp', 'ping'],
          reason: 'Recommended for SNMP and traditional infrastructure polling.',
        },
        {
          kind: 'alloy' as const,
          label: 'Grafana Alloy',
          available: false,
          supportedInputs: ['prometheus'],
          reason: 'Not built: Telegraf covers the supported inputs (D-024).',
        },
      ],
    }),
  )

  const SourceListQuerySchema = Type.Object({
    siteId: Type.Optional(Type.String({ format: 'uuid' })),
    includeDescendants: Type.Optional(Type.Boolean({ default: true })),
  })

  app.get<{ Querystring: { siteId?: string; includeDescendants?: boolean } }>(
    '/api/v1/sources',
    {
      preHandler: read,
      schema: {
        querystring: SourceListQuerySchema,
        response: { 200: SourceListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async (request) => {
      const siteId = request.query.siteId
      return {
        sources: await store.listSources({
          ...(siteId ? { siteId } : {}),
          includeDescendants: request.query.includeDescendants ?? true,
        }),
      }
    },
  )

  app.get<{ Params: IdParams }>(
    '/api/v1/sources/:id',
    {
      preHandler: read,
      schema: {
        params: IdParamsSchema,
        response: {
          200: SourceSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const source = await store.getSource(request.params.id)
      if (!source) throw missing('source')
      return source
    },
  )

  app.post<{ Body: CreateSourceRequest }>(
    '/api/v1/sources',
    {
      preHandler: operate,
      schema: {
        body: CreateSourceRequestSchema,
        response: {
          201: SourceSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const input = normalizedSourceInput(request.body)
      const source = await store.createSource(
        input,
        resolveCollector(input.collectorSelection ?? 'auto'),
      )
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'source.created',
        resourceType: 'source',
        resourceId: source.id,
        outcome: 'success',
        metadata: { name: source.name, collector: source.collector },
      })
      return reply.code(201).send(source)
    },
  )

  app.patch<{ Params: IdParams; Body: UpdateSourceRequest }>(
    '/api/v1/sources/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        body: UpdateSourceRequestSchema,
        response: {
          200: SourceSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const current = await store.getSource(request.params.id)
      if (!current) throw missing('source')
      const transport = request.body.transport ?? current.transport
      const target = validateTarget(request.body.target ?? current.target, transport)
      const input = request.body.target === undefined ? request.body : { ...request.body, target }
      const collector = request.body.collectorSelection
        ? resolveCollector(request.body.collectorSelection)
        : null
      const source = await store.updateSource(request.params.id, input, collector)
      if (!source) throw missing('source')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'source.updated',
        resourceType: 'source',
        resourceId: source.id,
        outcome: 'success',
        metadata: { fields: Object.keys(request.body), collector: source.collector },
      })
      return source
    },
  )

  app.delete<{ Params: IdParams }>(
    '/api/v1/sources/:id',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        response: {
          204: Type.Null(),
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await store.deleteSource(request.params.id))) throw missing('source')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'source.deleted',
        resourceType: 'source',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: {},
      })
      return reply.code(204).send()
    },
  )

  app.post<{ Params: IdParams }>(
    '/api/v1/sources/:id/test',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        response: { 202: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!(await store.getSource(request.params.id))) throw missing('source')
      const job = await jobs.enqueue({
        type: 'snmp.connection-test',
        payload: { sourceId: request.params.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 90_000,
      })
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'source.test_requested',
        resourceType: 'source',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: { jobId: job.id },
      })
      return reply.code(202).send(job)
    },
  )

  app.post<{ Params: IdParams }>(
    '/api/v1/sources/:id/inventory',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        response: { 202: JobSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!(await store.getSource(request.params.id))) throw missing('source')
      const job = await jobs.enqueue({
        type: 'snmp.inventory',
        payload: { sourceId: request.params.id },
        requestedBy: request.auth!.user.id,
        timeoutMs: 180_000,
      })
      await store.markInventoryPending(request.params.id)
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'inventory.requested',
        resourceType: 'source',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: { jobId: job.id },
      })
      return reply.code(202).send(job)
    },
  )

  app.get<{ Params: IdParams }>(
    '/api/v1/sources/:id/inventory',
    {
      preHandler: read,
      schema: {
        params: IdParamsSchema,
        response: {
          200: InventorySnapshotListSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request) => ({ snapshots: await store.listSnapshots(request.params.id) }),
  )

  app.get<{ Params: IdParams }>(
    '/api/v1/inventory/:id',
    {
      preHandler: read,
      schema: {
        params: IdParamsSchema,
        response: {
          200: InventorySnapshotSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const snapshot = await store.getSnapshot(request.params.id)
      if (!snapshot) throw missing('inventory_snapshot')
      return snapshot
    },
  )

  app.post<{ Params: IdParams }>(
    '/api/v1/inventory/:id/apply',
    {
      preHandler: operate,
      schema: {
        params: IdParamsSchema,
        response: {
          200: SourceSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const source = await store.applySnapshot(request.params.id, request.auth!.user.id)
      if (!source) throw missing('inventory_snapshot')
      await audit.writeAudit({
        actorUserId: request.auth!.user.id,
        action: 'inventory.applied',
        resourceType: 'inventory_snapshot',
        resourceId: request.params.id,
        outcome: 'success',
        metadata: { sourceId: source.id },
      })
      return source
    },
  )
}
