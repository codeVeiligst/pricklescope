import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createHarness, databaseUrl, type Harness } from './harness.js'

/**
 * The protections that only matter because a browser is involved: forged
 * cross-site requests, cross-origin reads, response headers, and the lifetime of
 * a session.
 */

const suite = databaseUrl ? describe : describe.skip

suite('browser-facing protections', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  /** A mutation deliberately made without the helpers that would make it valid. */
  const raw = (options: Parameters<Harness['app']['inject']>[0]) => harness.app.inject(options)

  describe('cross-site request forgery', () => {
    const site = { name: 'CSRF probe', parentId: null }

    it('refuses a mutation with a session but no CSRF token', async () => {
      const response = await raw({
        method: 'POST',
        url: '/api/v1/sites',
        headers: { cookie: harness.operator.cookie, origin: harness.appOrigin },
        payload: site,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: 'csrf_invalid' })
    })

    it('refuses a token that is not this session’s', async () => {
      // The token is bound to the session, so holding *a* valid token is not
      // enough — otherwise any signed-in user could supply their own.
      const response = await raw({
        method: 'POST',
        url: '/api/v1/sites',
        headers: {
          cookie: harness.operator.cookie,
          origin: harness.appOrigin,
          'x-csrf-token': harness.administrator.csrf,
        },
        payload: site,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: 'csrf_invalid' })
    })

    it('refuses a token of the right shape but the wrong value', async () => {
      const response = await raw({
        method: 'POST',
        url: '/api/v1/sites',
        headers: {
          cookie: harness.operator.cookie,
          origin: harness.appOrigin,
          'x-csrf-token': 'x'.repeat(harness.operator.csrf.length),
        },
        payload: site,
      })
      expect(response.statusCode).toBe(403)
    })

    it('refuses a mutation from another origin even with the right token', async () => {
      for (const origin of ['https://attacker.example', 'null', 'http://localhost:5174']) {
        const response = await raw({
          method: 'POST',
          url: '/api/v1/sites',
          headers: {
            cookie: harness.operator.cookie,
            origin,
            'x-csrf-token': harness.operator.csrf,
          },
          payload: site,
        })
        expect(response.statusCode, `origin ${origin}`).toBe(403)
        expect(response.json(), `origin ${origin}`).toMatchObject({ error: 'origin_invalid' })
      }
    })

    it('accepts the same mutation when both are right', async () => {
      // Without this the four refusals above could all be a broken route.
      const response = await harness.as(harness.operator, {
        method: 'POST',
        url: '/api/v1/sites',
        payload: { name: 'CSRF control', parentId: null },
      })
      expect(response.statusCode).toBe(201)
    })

    it('applies the check to every mutating method', async () => {
      const uuid = '00000000-0000-4000-8000-000000000000'
      // Bodies have to be schema-valid: Fastify validates before it runs a
      // preHandler, so an invalid one answers 400 and the CSRF guard never
      // speaks — the check would look enforced when it had not run.
      for (const probe of [
        { method: 'PATCH' as const, url: `/api/v1/sites/${uuid}`, payload: { name: 'x' } },
        { method: 'DELETE' as const, url: `/api/v1/sites/${uuid}` },
        {
          method: 'PUT' as const,
          url: '/api/v1/settings/oidc',
          payload: {
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
        },
      ]) {
        const response = await raw({
          ...probe,
          headers: { cookie: harness.administrator.cookie, origin: harness.appOrigin },
        })
        expect(response.statusCode, `${probe.method} ${probe.url}`).toBe(403)
      }
    })
  })

  describe('cross-origin reads', () => {
    it('never grants another origin permission to read a response', async () => {
      // No CORS plugin is registered, so the browser's same-origin policy is the
      // control. This asserts nothing has quietly started sending the header
      // that would switch that off.
      for (const url of ['/api/v1/auth/providers', '/api/v1/sites', '/api/v1/system/health']) {
        const response = await raw({
          method: 'GET',
          url,
          headers: { cookie: harness.administrator.cookie, origin: 'https://attacker.example' },
        })
        expect(response.headers['access-control-allow-origin'], url).toBeUndefined()
        expect(response.headers['access-control-allow-credentials'], url).toBeUndefined()
      }
    })
  })

  describe('response headers', () => {
    it('sends the hardening headers on API responses', async () => {
      const response = await harness.as(harness.administrator, {
        method: 'GET',
        url: '/api/v1/sites',
      })
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['x-frame-options']).toBeDefined()
      expect(response.headers['x-dns-prefetch-control']).toBeDefined()
    })

    it('does not advertise what it is running', async () => {
      const response = await raw({ method: 'GET', url: '/api/v1' })
      expect(response.headers['x-powered-by']).toBeUndefined()
      expect(response.headers.server).toBeUndefined()
    })
  })

  describe('session lifetime', () => {
    it('a signed-out session stops working immediately', async () => {
      const session = await harness.disposableSession(harness.viewer)
      expect((await harness.as(session, { method: 'GET', url: '/api/v1/sites' })).statusCode).toBe(
        200,
      )

      const logout = await harness.as(session, { method: 'POST', url: '/api/v1/auth/logout' })
      expect(logout.statusCode).toBe(204)

      expect((await harness.as(session, { method: 'GET', url: '/api/v1/sites' })).statusCode).toBe(
        401,
      )
    })

    it('changing a password ends every other session but not the one that did it', async () => {
      const staying = await harness.disposableSession(harness.viewer)
      const elsewhere = await harness.disposableSession(harness.viewer)

      const changed = await harness.as(staying, {
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: {
          currentPassword: 'security-role-password',
          newPassword: 'a-brand-new-password-1',
        },
      })
      expect(changed.statusCode).toBe(204)

      expect(
        (await harness.as(elsewhere, { method: 'GET', url: '/api/v1/sites' })).statusCode,
        'a session elsewhere survived a password change',
      ).toBe(401)
      expect(
        (await harness.as(staying, { method: 'GET', url: '/api/v1/sites' })).statusCode,
        'the session that changed the password was signed out too',
      ).toBe(200)
    })

    it('a role change takes effect on the next request, without a new session', async () => {
      const session = await harness.disposableSession(harness.operator)
      expect((await harness.as(session, { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(
        403,
      )

      await harness.metadata.db
        .updateTable('users')
        .set({ role: 'administrator' })
        .where('id', '=', harness.operator.userId)
        .execute()

      expect(
        (await harness.as(session, { method: 'GET', url: '/api/v1/users' })).statusCode,
        'the role is being read from the session rather than the account',
      ).toBe(200)

      await harness.metadata.db
        .updateTable('users')
        .set({ role: 'operator' })
        .where('id', '=', harness.operator.userId)
        .execute()
    })

    it('a disabled account cannot keep using the session it already had', async () => {
      const session = await harness.disposableSession(harness.operator)
      expect((await harness.as(session, { method: 'GET', url: '/api/v1/sites' })).statusCode).toBe(
        200,
      )

      await harness.metadata.db
        .updateTable('users')
        .set({ active: false })
        .where('id', '=', harness.operator.userId)
        .execute()

      expect(
        (await harness.as(session, { method: 'GET', url: '/api/v1/sites' })).statusCode,
        'a disabled account was still served',
      ).toBe(401)

      await harness.metadata.db
        .updateTable('users')
        .set({ active: true })
        .where('id', '=', harness.operator.userId)
        .execute()
    })

    it('a made-up session token is refused', async () => {
      for (const token of ['', 'not-a-token', 'a'.repeat(43), harness.viewer.cookie]) {
        const response = await raw({
          method: 'GET',
          url: '/api/v1/sites',
          headers: { cookie: `pricklescope_session=${token}` },
        })
        expect(response.statusCode, `token ${token.slice(0, 20)}`).toBe(401)
      }
    })
  })

  describe('authentication throttling', () => {
    it('stops answering after a burst of failed sign-ins', async () => {
      const attempt = () =>
        raw({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: harness.appOrigin },
          payload: { username: harness.credentials.username, password: 'wrong-password' },
        })

      const statuses: number[] = []
      for (let index = 0; index < 8; index += 1) statuses.push((await attempt()).statusCode)

      expect(statuses.filter((status) => status === 401).length).toBeGreaterThan(0)
      expect(
        statuses.filter((status) => status === 429).length,
        `throttling never engaged: ${statuses.join(',')}`,
      ).toBeGreaterThan(0)
      expect(statuses, 'a throttled attempt was reported as a server fault').not.toContain(500)
    }, 30_000)

    /**
     * The bypass an external audit found on 2026-08-11. The global limiter keys
     * by the session cookie when one is present, and it reads that cookie before
     * anything has validated it — so an unauthenticated caller picks their own
     * bucket, and a fresh made-up value buys another five guesses. Twenty
     * attempts with twenty cookies returned twenty 401s and no 429.
     */
    it('cannot be bypassed by rotating an invented session cookie', async () => {
      const statuses: number[] = []
      for (let index = 0; index < 20; index += 1) {
        const response = await raw({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            origin: harness.appOrigin,
            cookie: `pricklescope_session=invented-${index}`,
          },
          payload: { username: harness.credentials.username, password: 'wrong-password' },
        })
        statuses.push(response.statusCode)
      }
      expect(
        statuses.filter((status) => status === 429).length,
        `a rotating cookie defeated the login throttle: ${statuses.join(',')}`,
      ).toBeGreaterThan(0)
    }, 30_000)

    it('the throttle refuses even a correct password', async () => {
      // Otherwise the limit only slows down the guesses that were going to fail.
      const response = await raw({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: harness.appOrigin },
        payload: harness.credentials,
      })
      expect(response.statusCode).toBe(429)
      expect(response.json()).toMatchObject({ error: 'rate_limited' })
    })
  })
})
