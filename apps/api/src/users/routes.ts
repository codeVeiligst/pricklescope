import {
  ApiErrorSchema,
  CreateLocalUserRequestSchema,
  ManagedUserListSchema,
  ManagedUserSchema,
  ResetUserPasswordRequestSchema,
  UpdateManagedUserRequestSchema,
  type CreateLocalUserRequest,
  type ResetUserPasswordRequest,
  type UpdateManagedUserRequest,
} from '@pricklescope/contracts'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import type { AuthGuards } from '../auth/guards.js'
import { HttpError } from '../errors.js'
import type { UserManagementService } from './service.js'

const IdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) })
type IdParams = { id: string }

function missing(): HttpError {
  return new HttpError(404, 'user_not_found', 'The user does not exist')
}

export function registerUserRoutes(
  app: FastifyInstance,
  dependencies: { users: UserManagementService; guards: AuthGuards },
): void {
  const { users, guards } = dependencies
  const read = [guards.authenticate, guards.authorize('administrator')]
  const mutate = [guards.authenticate, guards.authorize('administrator'), guards.csrf]

  app.get(
    '/api/v1/users',
    {
      preHandler: read,
      schema: {
        response: { 200: ManagedUserListSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async () => ({ users: await users.list() }),
  )

  app.post<{ Body: CreateLocalUserRequest }>(
    '/api/v1/users',
    {
      preHandler: mutate,
      schema: {
        body: CreateLocalUserRequestSchema,
        response: {
          201: ManagedUserSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await users.createLocal(request.body, request.auth!.user.id)
      return reply.code(201).send(user)
    },
  )

  app.patch<{ Params: IdParams; Body: UpdateManagedUserRequest }>(
    '/api/v1/users/:id',
    {
      preHandler: mutate,
      schema: {
        params: IdParamsSchema,
        body: UpdateManagedUserRequestSchema,
        response: {
          200: ManagedUserSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const user = await users.update(request.params.id, request.body, request.auth!.user.id)
      if (!user) throw missing()
      return user
    },
  )

  app.post<{ Params: IdParams; Body: ResetUserPasswordRequest }>(
    '/api/v1/users/:id/password',
    {
      preHandler: mutate,
      schema: {
        params: IdParamsSchema,
        body: ResetUserPasswordRequestSchema,
        response: {
          200: ManagedUserSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const user = await users.resetPassword(
        request.params.id,
        request.body.password,
        request.auth!.user.id,
      )
      if (!user) throw missing()
      return user
    },
  )

  app.post<{ Params: IdParams }>(
    '/api/v1/users/:id/revoke-sessions',
    {
      preHandler: mutate,
      schema: {
        params: IdParamsSchema,
        response: {
          200: Type.Object({ revokedSessions: Type.Integer({ minimum: 0 }) }),
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const count = await users.revokeSessions(request.params.id, request.auth!.user.id)
      if (count === null) throw missing()
      return { revokedSessions: count }
    },
  )

  app.delete<{ Params: IdParams }>(
    '/api/v1/users/:id',
    {
      preHandler: mutate,
      schema: {
        params: IdParamsSchema,
        response: {
          204: Type.Null(),
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await users.delete(request.params.id, request.auth!.user.id))) throw missing()
      return reply.code(204).send()
    },
  )
}
