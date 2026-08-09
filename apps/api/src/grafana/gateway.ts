import httpProxy from '@fastify/http-proxy'
import type { Role, User } from '@pricklescope/contracts'
import type { FastifyInstance } from 'fastify'
import type { IncomingHttpHeaders } from 'node:http'

import type { AuthGuards } from '../auth/guards.js'
import type { AppConfig } from '../config.js'

const trustedRequestHeaders = [
  'authorization',
  'proxy-authorization',
  'connection',
  'cookie',
  'x-grafana-org-id',
  'x-webauth-user',
  'x-webauth-name',
  'x-webauth-email',
  'x-webauth-role',
] as const

export function grafanaRole(role: Role): 'Viewer' | 'Editor' {
  return role === 'viewer' ? 'Viewer' : 'Editor'
}

export function grafanaProxyHeaders(headers: IncomingHttpHeaders, user: User): IncomingHttpHeaders {
  const outgoing: IncomingHttpHeaders = { ...headers }
  for (const name of trustedRequestHeaders) delete outgoing[name]
  outgoing['x-webauth-user'] = `ps-${user.id}`
  outgoing['x-webauth-role'] = grafanaRole(user.role)
  return outgoing
}

export async function registerGrafanaGateway(
  app: FastifyInstance,
  dependencies: { config: AppConfig; guards: AuthGuards },
): Promise<void> {
  const { config, guards } = dependencies
  if (!config.grafana.internalUrl) return
  const upstreamOrigin = new URL(config.grafana.internalUrl).origin

  await app.register(async (gateway) => {
    gateway.addHook('preHandler', guards.authenticate)
    gateway.addHook('preHandler', guards.authorize('viewer'))
    await gateway.register(httpProxy, {
      upstream: upstreamOrigin,
      prefix: config.grafana.publicPath,
      rewritePrefix: config.grafana.publicPath,
      websocket: false,
      replyOptions: {
        timeout: 30_000,
        // Grafana is embedded as server-rendered images, so its own framing
        // headers are passed through untouched.
        rewriteRequestHeaders: (request, headers) =>
          grafanaProxyHeaders(headers, request.auth!.user),
      },
    })
  })
}
