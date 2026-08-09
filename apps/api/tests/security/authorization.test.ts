import { ROLE_ORDER } from '@pricklescope/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createHarness, databaseUrl, type Actor, type Harness, type Role } from './harness.js'

/**
 * Every route, every role, from the outside.
 *
 * The matrix below is the product's access-control decision written down once.
 * The sweep then asserts three things per entry, because two of them are the ones
 * that rot quietly:
 *
 *   anonymous            must be refused with 401
 *   below the minimum    must be refused with 403
 *   at or above it       must NOT be refused
 *
 * That last line is what stops the suite from passing because a route is broken,
 * a path is misspelled, or a guard rejects everyone. And `covers every route` at
 * the end fails when a route is added without a line here, so a new endpoint
 * cannot ship without someone stating who may call it.
 */

type Access = 'public' | 'session' | Role | 'token'

interface RouteCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  access: Access
  /** A body good enough to get past schema validation to the guard's verdict. */
  payload?: unknown
  /** Skip the positive check where a valid call would hit an absent engine. */
  refusalOnly?: boolean
  /**
   * The handler itself answers 401 for reasons that are not authorization — wrong
   * credentials, a wrong current password. For these, a permitted caller is only
   * asserted not to be forbidden.
   */
  allow401?: boolean
  /** Ends the session it is called with, so the sweep spends a throwaway one. */
  consumesSession?: boolean
}

const uuid = '00000000-0000-4000-8000-000000000000'

/**
 * Bodies that pass schema validation.
 *
 * Fastify validates before it runs a preHandler, so an invalid body answers 400
 * and the guard never speaks. A malformed payload here would make the sweep
 * assert nothing about authorization while still looking green.
 */
const VALID = {
  source: {
    name: 'Security source',
    target: 'device.example',
    credentialId: uuid,
    profileId: uuid,
  },
  pollingProfile: {
    name: 'Security profile',
    intervalSeconds: 60,
    timeoutMs: 2000,
    retries: 1,
    collectSystem: true,
    collectInterfaces: true,
  },
  alertRule: {
    name: 'Security rule',
    sourceId: uuid,
    metric: 'availability',
    reducer: 'last',
    comparison: 'lt',
    threshold: 99,
    evaluationIntervalSeconds: 60,
    pendingSeconds: 0,
    lookbackSeconds: 300,
    noDataState: 'NoData',
    execErrorState: 'Error',
    severity: 'warning',
    contactPointId: null,
  },
  contactPoint: {
    name: 'Security contact',
    kind: 'webhook',
    url: 'https://receiver.example/hook',
    addresses: null,
  },
  oidcSettings: {
    enabled: false,
    name: 'Single sign-on',
    issuerUrl: null,
    clientId: null,
    redirectUri: 'http://localhost:5173/api/v1/auth/oidc/callback',
    scopes: 'openid profile email',
    jitProvisioning: true,
    adminGroup: null,
    operatorGroup: null,
  },
  storagePolicy: {
    rawRetentionDays: 30,
    fiveMinuteRetentionDays: 365,
    hourlyRetentionDays: 1825,
  },
  user: {
    username: 'newperson',
    displayName: 'New Person',
    role: 'viewer',
    password: 'a-long-enough-password',
  },
  password: { password: 'a-long-enough-password' },
  credential: { name: 'Security credential', version: '2c', community: 'public' },
} as const

const ROUTES: RouteCase[] = [
  // Unauthenticated by necessity: orchestrator probes and the sign-in surface.
  { method: 'GET', path: '/health/live', access: 'public' },
  { method: 'GET', path: '/health/ready', access: 'public' },
  { method: 'GET', path: '/api/v1', access: 'public' },
  { method: 'GET', path: '/api/v1/auth/providers', access: 'public' },
  { method: 'POST', path: '/api/v1/auth/login', access: 'public', payload: { username: 'nobody', password: 'nobody-password' }, allow401: true },
  { method: 'GET', path: '/api/v1/auth/oidc/start', access: 'public', refusalOnly: true },
  { method: 'GET', path: '/api/v1/auth/oidc/callback', access: 'public', refusalOnly: true },

  // Any signed-in account, whatever its role.
  { method: 'GET', path: '/api/v1/auth/session', access: 'session' },
  { method: 'POST', path: '/api/v1/auth/logout', access: 'session', consumesSession: true },
  {
    method: 'POST',
    path: '/api/v1/auth/password',
    access: 'session',
    payload: { currentPassword: 'wrong-password', newPassword: 'a-new-password-1' },
    allow401: true,
  },

  // Read-only.
  { method: 'GET', path: '/api/v1/system/health', access: 'viewer' },
  { method: 'GET', path: '/api/v1/sync', access: 'viewer' },
  { method: 'GET', path: '/api/v1/sites', access: 'viewer' },
  { method: 'GET', path: '/api/v1/sources', access: 'viewer' },
  { method: 'GET', path: `/api/v1/sources/${uuid}`, access: 'viewer' },
  { method: 'GET', path: `/api/v1/sources/${uuid}/inventory`, access: 'viewer' },
  { method: 'GET', path: '/api/v1/storage', access: 'viewer' },
  { method: 'GET', path: '/api/v1/alerts', access: 'viewer' },
  { method: 'GET', path: '/api/v1/alerts/rules', access: 'viewer' },
  { method: 'GET', path: '/api/v1/alerts/contact-points', access: 'viewer' },
  { method: 'GET', path: '/api/v1/jobs', access: 'viewer' },
  { method: 'GET', path: `/api/v1/jobs/${uuid}`, access: 'viewer' },
  { method: 'GET', path: '/api/v1/collectors/capabilities', access: 'viewer' },
  { method: 'GET', path: '/api/v1/collectors/telegraf', access: 'viewer' },
  { method: 'GET', path: '/api/v1/collectors/telegraf/revisions', access: 'viewer' },
  { method: 'GET', path: '/api/v1/polling-profiles', access: 'viewer' },
  { method: 'GET', path: `/api/v1/inventory/${uuid}`, access: 'viewer' },
  { method: 'GET', path: '/api/v1/grafana', access: 'viewer' },
  { method: 'GET', path: '/api/v1/graphs/fleet', access: 'viewer' },
  { method: 'GET', path: `/api/v1/graphs/sources/${uuid}`, access: 'viewer' },
  { method: 'GET', path: `/api/v1/graphs/sources/${uuid}/interfaces`, access: 'viewer' },

  // Day-to-day changes.
  { method: 'POST', path: '/api/v1/sites', access: 'operator', payload: { name: 'Site', parentId: null } },
  { method: 'PATCH', path: `/api/v1/sites/${uuid}`, access: 'operator', payload: { name: 'Renamed' } },
  { method: 'DELETE', path: `/api/v1/sites/${uuid}`, access: 'operator' },
  { method: 'POST', path: '/api/v1/sources', access: 'operator', payload: VALID.source },
  { method: 'PATCH', path: `/api/v1/sources/${uuid}`, access: 'operator', payload: { name: 'Renamed' } },
  { method: 'DELETE', path: `/api/v1/sources/${uuid}`, access: 'operator' },
  { method: 'POST', path: `/api/v1/sources/${uuid}/test`, access: 'operator' },
  { method: 'POST', path: `/api/v1/sources/${uuid}/inventory`, access: 'operator' },
  { method: 'POST', path: `/api/v1/inventory/${uuid}/apply`, access: 'operator' },
  { method: 'GET', path: '/api/v1/credentials/snmp', access: 'operator' },
  { method: 'POST', path: '/api/v1/polling-profiles', access: 'operator', payload: VALID.pollingProfile },
  { method: 'PATCH', path: `/api/v1/polling-profiles/${uuid}`, access: 'operator', payload: { name: 'Renamed' } },
  { method: 'DELETE', path: `/api/v1/polling-profiles/${uuid}`, access: 'operator' },
  { method: 'POST', path: '/api/v1/jobs/dependency-check', access: 'operator', refusalOnly: true },
  { method: 'POST', path: `/api/v1/jobs/${uuid}/cancel`, access: 'operator' },
  { method: 'POST', path: '/api/v1/collectors/telegraf/reconcile', access: 'operator', refusalOnly: true },
  { method: 'POST', path: `/api/v1/collectors/telegraf/revisions/${uuid}/rollback`, access: 'operator', refusalOnly: true },
  { method: 'POST', path: '/api/v1/alerts/rules', access: 'operator', payload: VALID.alertRule },
  { method: 'PUT', path: `/api/v1/alerts/rules/${uuid}`, access: 'operator', payload: VALID.alertRule },
  { method: 'DELETE', path: `/api/v1/alerts/rules/${uuid}`, access: 'operator' },
  { method: 'POST', path: '/api/v1/alerts/preview', access: 'operator', payload: VALID.alertRule },
  { method: 'POST', path: '/api/v1/alerts/contact-points', access: 'operator', payload: VALID.contactPoint },
  { method: 'PUT', path: `/api/v1/alerts/contact-points/${uuid}`, access: 'operator', payload: VALID.contactPoint },
  { method: 'DELETE', path: `/api/v1/alerts/contact-points/${uuid}`, access: 'operator' },
  { method: 'POST', path: `/api/v1/alerts/contact-points/${uuid}/test`, access: 'operator' },

  // Who may configure the installation and who may use it.
  { method: 'GET', path: '/api/v1/settings/oidc', access: 'administrator' },
  { method: 'PUT', path: '/api/v1/settings/oidc', access: 'administrator', payload: VALID.oidcSettings },
  { method: 'DELETE', path: '/api/v1/settings/oidc', access: 'administrator', refusalOnly: true },
  { method: 'POST', path: '/api/v1/settings/oidc/test', access: 'administrator', payload: VALID.oidcSettings, refusalOnly: true },
  { method: 'PUT', path: '/api/v1/storage/policy', access: 'administrator', payload: VALID.storagePolicy },
  { method: 'POST', path: '/api/v1/storage/reconcile', access: 'administrator', refusalOnly: true },
  { method: 'POST', path: '/api/v1/alerts/reconcile', access: 'administrator', refusalOnly: true },
  { method: 'POST', path: '/api/v1/grafana/reconcile', access: 'administrator', refusalOnly: true },
  // Aggregates three administrator reconciles; see privilege-boundaries.test.ts.
  { method: 'POST', path: '/api/v1/sync/apply', access: 'administrator', refusalOnly: true },
  { method: 'GET', path: '/api/v1/users', access: 'administrator' },
  { method: 'POST', path: '/api/v1/users', access: 'administrator', payload: VALID.user },
  { method: 'PATCH', path: `/api/v1/users/${uuid}`, access: 'administrator', payload: {} },
  { method: 'DELETE', path: `/api/v1/users/${uuid}`, access: 'administrator' },
  { method: 'POST', path: `/api/v1/users/${uuid}/password`, access: 'administrator', payload: VALID.password },
  { method: 'POST', path: `/api/v1/users/${uuid}/revoke-sessions`, access: 'administrator' },
  { method: 'POST', path: '/api/v1/credentials/snmp', access: 'administrator', payload: VALID.credential },
  { method: 'PATCH', path: `/api/v1/credentials/snmp/${uuid}`, access: 'administrator', payload: { name: 'Renamed' } },
  { method: 'DELETE', path: `/api/v1/credentials/snmp/${uuid}`, access: 'administrator' },

  // Grafana calls this one with a generated bearer token, not a session.
  { method: 'POST', path: `/api/v1/alerts/notify/${uuid}`, access: 'token' },

  // The API's own description. Anonymous callers get the whole surface.
  { method: 'GET', path: '/api/openapi.json', access: 'viewer' },
]

function permitted(access: Access, actor: Actor): boolean {
  if (access === 'public' || access === 'token') return true
  if (actor.role === 'anonymous') return false
  if (access === 'session') return true
  return ROLE_ORDER[actor.role] >= ROLE_ORDER[access]
}

const suite = databaseUrl ? describe : describe.skip

suite('every route refuses the roles it is not for', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  for (const route of ROUTES) {
    const name = `${route.method} ${route.path.replace(uuid, ':id')}`

    it(`${name} (${route.access})`, async () => {
      for (const base of harness.actors) {
        // Logout would end the session every later case depends on.
        const actor =
          route.consumesSession && base.role !== 'anonymous'
            ? await harness.disposableSession(base)
            : base

        const response = await harness.as(actor, {
          method: route.method,
          url: route.path,
          ...(route.payload === undefined ? {} : { payload: route.payload }),
        })
        const where = `${name} as ${actor.role} returned ${response.statusCode}`

        if (permitted(route.access, actor)) {
          // Not asserting success: a dummy payload or a missing row is fine.
          // Asserting that authorization is not what stopped it.
          if (!route.allow401) expect(response.statusCode, where).not.toBe(401)
          expect(response.statusCode, where).not.toBe(403)
          continue
        }

        if (actor.role === 'anonymous') {
          expect(response.statusCode, where).toBe(401)
        } else {
          expect(response.statusCode, where).toBe(403)
        }
      }
    }, 30_000)
  }

  it('covers every route the application registers', () => {
    const declared = new Set(ROUTES.map((route) => `${route.method} ${route.path}`))
    const missing: string[] = []
    // `printRoutes` draws a tree, so a line carries only its own segment and the
    // full path has to be rebuilt from the indentation of its ancestors.
    const prefixes: string[] = []

    for (const line of harness.app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^([│\s]*)(?:[├└]──\s)?(\/\S*)(?:\s+\(([A-Z, ]+)\))?/.exec(line)
      if (!match?.[2]) continue
      const depth = Math.floor(match[1]!.length / 4)
      prefixes[depth] = match[2]
      prefixes.length = depth + 1
      if (!match[3]) continue

      const path = prefixes.join('')
      for (const method of match[3].split(',').map((value) => value.trim())) {
        if (method === 'HEAD' || method === 'OPTIONS') continue
        // The tree carries parameter names; the matrix uses a concrete uuid.
        const concrete = path.replace(/:id\b/g, uuid).replace(/:ref\b/g, uuid)
        if (!declared.has(`${method} ${concrete}`)) missing.push(`${method} ${path}`)
      }
    }

    expect(missing, 'these routes have no entry in ROUTES — decide who may call them').toEqual([])
    // A matrix that matched nothing would also report no gaps.
    expect(declared.size).toBeGreaterThan(50)
  })
})
