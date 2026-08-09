import {
  ApiErrorSchema,
  AuthProvidersSchema,
  AuthSessionSchema,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  type AuthSession,
  type ChangePasswordRequest,
  type LoginRequest,
} from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import type { AppConfig } from '../config.js'
import type { AuthGuards } from './guards.js'
import type { LocalAuthService } from './local.js'
import type { OidcService } from './oidc.js'
import type { AuthStore } from './store.js'

const OIDC_FLOW_COOKIE = 'pricklescope_oidc_flow'

function response(session: {
  user: AuthSession['user']
  csrfToken: string
  expiresAt: Date
}): AuthSession {
  return {
    user: session.user,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  }
}

function sessionCookie(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.session.secure,
    sameSite: 'lax' as const,
    maxAge: config.session.ttlSeconds,
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: {
    config: AppConfig
    store: AuthStore
    localAuth: LocalAuthService
    oidc: OidcService
    guards: AuthGuards
  },
): void {
  const { config, store, localAuth, oidc, guards } = dependencies

  app.get(
    '/api/v1/auth/providers',
    { schema: { response: { 200: AuthProvidersSchema } } },
    async () => ({
      local: true,
      oidc: await oidc.summary(),
    }),
  )

  app.post<{ Body: LoginRequest }>(
    '/api/v1/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: LoginRequestSchema,
        response: { 200: AuthSessionSchema, 401: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const session = await localAuth.login(request.body.username, request.body.password)
      reply.setCookie(config.session.cookieName, session.token, sessionCookie(config))
      return response(session)
    },
  )

  app.get(
    '/api/v1/auth/session',
    {
      preHandler: [guards.authenticate],
      schema: { response: { 200: AuthSessionSchema, 401: ApiErrorSchema } },
    },
    (request) => response(request.auth!),
  )

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: [guards.authenticate, guards.csrf],
      schema: { response: { 204: Type.Null(), 401: ApiErrorSchema, 403: ApiErrorSchema } },
    },
    async (request, reply) => {
      await store.deleteSession(request.auth!.sessionId)
      reply.clearCookie(config.session.cookieName, { path: '/' })
      return reply.code(204).send()
    },
  )

  app.post<{ Body: ChangePasswordRequest }>(
    '/api/v1/auth/password',
    {
      preHandler: [guards.authenticate, guards.csrf],
      schema: {
        body: ChangePasswordRequestSchema,
        response: {
          204: Type.Null(),
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      await localAuth.changePassword({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        sessionId: request.auth!.sessionId,
        currentPassword: request.body.currentPassword,
        newPassword: request.body.newPassword,
      })
      return reply.code(204).send()
    },
  )

  app.get<{ Querystring: { returnTo?: string } }>(
    '/api/v1/auth/oidc/start',
    {
      schema: {
        querystring: Type.Object({ returnTo: Type.Optional(Type.String({ maxLength: 2048 })) }),
        response: { 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const started = await oidc.start(request.query.returnTo)
      reply.setCookie(OIDC_FLOW_COOKIE, started.flowToken, {
        path: '/api/v1/auth/oidc',
        httpOnly: true,
        secure: config.session.secure,
        sameSite: 'lax',
        maxAge: 600,
      })
      return reply.redirect(started.authorizationUrl)
    },
  )

  app.get('/api/v1/auth/oidc/callback', async (request, reply) => {
    const callbackUrl = new URL(request.url, config.appOrigin)
    const completed = await oidc.finish(request.cookies[OIDC_FLOW_COOKIE], callbackUrl)
    const session = await store.createSession(completed.user.id, config.session.ttlSeconds)
    reply.clearCookie(OIDC_FLOW_COOKIE, { path: '/api/v1/auth/oidc' })
    reply.setCookie(config.session.cookieName, session.token, sessionCookie(config))
    return reply.redirect(`${config.appOrigin}${completed.returnTo}`)
  })
}
