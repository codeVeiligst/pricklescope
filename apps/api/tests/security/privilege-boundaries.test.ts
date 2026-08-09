import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createHarness, databaseUrl, type Harness } from './harness.js'

/**
 * Properties the route matrix cannot see.
 *
 * A per-route table proves each endpoint enforces the level it declares. It says
 * nothing about whether that level is *right* — and the way privilege actually
 * leaks is an endpoint that does, indirectly, something the caller could not do
 * directly. `/sync/apply` was exactly that: operator-level, enqueuing the same
 * storage, Grafana, and alert reconciles that require an administrator on their
 * own routes.
 */

const suite = databaseUrl ? describe : describe.skip

suite('an endpoint never exceeds the privilege of what it triggers', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  /** Job type to the lowest role that may enqueue it through its own route. */
  const DIRECT_ROUTES: Record<string, { path: string; role: 'operator' | 'administrator' }> = {
    'collector.telegraf.reconcile': {
      path: '/api/v1/collectors/telegraf/reconcile',
      role: 'operator',
    },
    'storage.questdb.reconcile': { path: '/api/v1/storage/reconcile', role: 'administrator' },
    'grafana.reconcile': { path: '/api/v1/grafana/reconcile', role: 'administrator' },
    'alerts.reconcile': { path: '/api/v1/alerts/reconcile', role: 'administrator' },
  }

  it('an operator cannot reach an administrator reconcile through /sync/apply', async () => {
    const response = await harness.as(harness.operator, {
      method: 'POST',
      url: '/api/v1/sync/apply',
    })
    expect(response.statusCode).toBe(403)
  })

  it('the aggregate applies nothing an administrator could not apply directly', async () => {
    const response = await harness.as(harness.administrator, {
      method: 'POST',
      url: '/api/v1/sync/apply',
    })
    expect(response.statusCode).toBe(202)

    const { jobs } = response.json() as { jobs: { type: string }[] }
    for (const job of jobs) {
      expect(
        DIRECT_ROUTES[job.type],
        `/sync/apply enqueued ${job.type}, which has no direct route to compare against`,
      ).toBeDefined()
    }
  })

  it('the direct routes still enforce the levels the aggregate is measured against', async () => {
    for (const [jobType, route] of Object.entries(DIRECT_ROUTES)) {
      if (route.role !== 'administrator') continue
      const response = await harness.as(harness.operator, { method: 'POST', url: route.path })
      expect(response.statusCode, `${jobType} via ${route.path} as operator`).toBe(403)
    }
  })

  it('a viewer cannot enqueue any background work', async () => {
    for (const route of Object.values(DIRECT_ROUTES)) {
      const response = await harness.as(harness.viewer, { method: 'POST', url: route.path })
      expect(response.statusCode, route.path).toBe(403)
    }
    const dependencyCheck = await harness.as(harness.viewer, {
      method: 'POST',
      url: '/api/v1/jobs/dependency-check',
    })
    expect(dependencyCheck.statusCode).toBe(403)
  })

  it('an operator cannot read or write the credentials an administrator owns', async () => {
    // Listing is deliberately open to operators — they attach credentials to
    // sources — so the property is that the secret never comes back with it.
    const list = await harness.as(harness.operator, {
      method: 'GET',
      url: '/api/v1/credentials/snmp',
    })
    expect(list.statusCode).toBe(200)
    const body = list.body
    for (const leak of ['community', 'authPassword', 'privacyPassword', 'secretCiphertext']) {
      expect(body, `the credential list exposed ${leak}`).not.toContain(leak)
    }

    const created = await harness.as(harness.operator, {
      method: 'POST',
      url: '/api/v1/credentials/snmp',
      payload: { name: 'Operator credential', version: '2c', community: 'public' },
    })
    expect(created.statusCode).toBe(403)
  })

  it('an operator cannot change who may sign in', async () => {
    for (const call of [
      { method: 'GET' as const, url: '/api/v1/users' },
      { method: 'GET' as const, url: '/api/v1/settings/oidc' },
    ]) {
      expect((await harness.as(harness.operator, call)).statusCode, call.url).toBe(403)
    }
  })
})
