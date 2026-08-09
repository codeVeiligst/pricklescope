import { ROLE_ORDER, type Role, type User } from '@pricklescope/contracts'
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'

import type { AppConfig } from '../config.js'
import { forbidden, HttpError, unauthorized } from '../errors.js'
import { safeEqual } from '../security.js'
import type { AuthStore } from './store.js'

export interface RequestAuth {
  sessionId: string
  csrfToken: string
  expiresAt: Date
  user: User
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null
  }
}

export interface AuthGuards {
  authenticate: preHandlerHookHandler
  authorize: (minimumRole: Role) => preHandlerHookHandler
  csrf: preHandlerHookHandler
}

export function createAuthGuards(store: AuthStore, config: AppConfig): AuthGuards {
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = request.cookies[config.session.cookieName]
    if (!token) throw unauthorized()
    const session = await store.findSession(token)
    if (!session) throw unauthorized()
    request.auth = {
      sessionId: session.id,
      user: session.user,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    }
  }

  const authorize = (minimumRole: Role): preHandlerHookHandler => {
    // Fastify uses the returned promise to know this hook has completed.
    // eslint-disable-next-line @typescript-eslint/require-await
    return async (request): Promise<void> => {
      if (!request.auth) throw unauthorized()
      if (ROLE_ORDER[request.auth.user.role] < ROLE_ORDER[minimumRole]) throw forbidden()
    }
  }

  // Fastify uses the returned promise to know this hook has completed.
  // eslint-disable-next-line @typescript-eslint/require-await
  const csrf = async (request: FastifyRequest): Promise<void> => {
    if (!request.auth) throw unauthorized()
    const provided = request.headers['x-csrf-token']
    if (typeof provided !== 'string' || !safeEqual(provided, request.auth.csrfToken)) {
      throw new HttpError(403, 'csrf_invalid', 'The request could not be verified')
    }
  }

  return { authenticate, authorize, csrf }
}
