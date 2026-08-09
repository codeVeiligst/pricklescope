import {
  ApiErrorSchema,
  OidcDiscoveryResultSchema,
  OidcProviderSettingsSchema,
  UpdateOidcProviderSettingsRequestSchema,
  type UpdateOidcProviderSettingsRequest,
} from '@pricklescope/contracts'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import type { OidcSettingsService } from './oidc.js'

export function registerSettingsRoutes(
  app: FastifyInstance,
  dependencies: { oidcSettings: OidcSettingsService; guards: AuthGuards },
): void {
  const { oidcSettings, guards } = dependencies
  const read = [guards.authenticate, guards.authorize('administrator')]
  const mutate = [guards.authenticate, guards.authorize('administrator'), guards.csrf]
  const errors = { 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema }

  app.get(
    '/api/v1/settings/oidc',
    {
      preHandler: read,
      schema: { response: { 200: OidcProviderSettingsSchema, ...errors } },
    },
    () => oidcSettings.get(),
  )

  app.put<{ Body: UpdateOidcProviderSettingsRequest }>(
    '/api/v1/settings/oidc',
    {
      preHandler: mutate,
      schema: {
        body: UpdateOidcProviderSettingsRequestSchema,
        response: { 200: OidcProviderSettingsSchema, ...errors },
      },
    },
    (request) => oidcSettings.update(request.body, request.auth!.user.id),
  )

  app.post<{ Body: UpdateOidcProviderSettingsRequest }>(
    '/api/v1/settings/oidc/test',
    {
      preHandler: mutate,
      schema: {
        body: UpdateOidcProviderSettingsRequestSchema,
        response: { 200: OidcDiscoveryResultSchema, ...errors },
      },
    },
    (request) => oidcSettings.test(request.body, request.auth!.user.id),
  )

  app.delete(
    '/api/v1/settings/oidc',
    {
      preHandler: mutate,
      schema: { response: { 200: OidcProviderSettingsSchema, ...errors } },
    },
    (request) => oidcSettings.reset(request.auth!.user.id),
  )
}
