import * as contracts from '@pricklescope/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadConfig, redactConfig } from '../../src/config.js'
import { LOG_REDACT_PATHS } from '../../src/logging.js'
import { createHarness, databaseUrl, type Harness } from './harness.js'

/**
 * What the product says about itself.
 *
 * Secrets leak through the boring surfaces — a response that echoes what it was
 * given, an error that quotes the connection string, a log line with the whole
 * request body in it. Each of those is checked here against a value planted for
 * the purpose, so a leak fails loudly rather than being spotted by eye.
 */

const suite = databaseUrl ? describe : describe.skip

const PLANTED = {
  community: 'PLANTED-SNMP-COMMUNITY-c0ffee',
  authPassword: 'PLANTED-AUTH-PASSWORD-c0ffee',
  privacyPassword: 'PLANTED-PRIV-PASSWORD-c0ffee',
  webhookSecret: 'PLANTED-WEBHOOK-SECRET-c0ffee',
  apiKey: 'PLANTED-PROVIDER-APIKEY-c0ffee',
  clientSecret: 'PLANTED-OIDC-CLIENTSECRET-c0ffee',
}

suite('nothing discloses a secret', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  const expectClean = (body: string, where: string): void => {
    for (const [field, value] of Object.entries(PLANTED)) {
      expect(body, `${where} disclosed ${field}`).not.toContain(value)
    }
  }

  it('an SNMP credential never comes back, however it is read', async () => {
    const created = await harness.as(harness.administrator, {
      method: 'POST',
      url: '/api/v1/credentials/snmp',
      payload: {
        name: 'Planted v3 credential',
        version: '3',
        username: 'planted',
        securityLevel: 'authPriv',
        authProtocol: 'sha256',
        authPassword: PLANTED.authPassword,
        privacyProtocol: 'aes',
        privacyPassword: PLANTED.privacyPassword,
      },
    })
    expect(created.statusCode).toBe(201)
    expectClean(created.body, 'the create response')
    const { id } = created.json() as { id: string }

    const list = await harness.as(harness.administrator, {
      method: 'GET',
      url: '/api/v1/credentials/snmp',
    })
    expectClean(list.body, 'the credential list')

    // Rotating returns the record again; that response must be clean too.
    const updated = await harness.as(harness.administrator, {
      method: 'PATCH',
      url: `/api/v1/credentials/snmp/${id}`,
      payload: { authPassword: PLANTED.authPassword },
    })
    expectClean(updated.body, 'the rotate response')
  }, 30_000)

  it('a webhook secret and a provider key never come back', async () => {
    const created = await harness.as(harness.operator, {
      method: 'POST',
      url: '/api/v1/alerts/contact-points',
      payload: {
        name: 'Planted contact',
        kind: 'webhook',
        url: 'https://receiver.example/hook',
        secret: PLANTED.webhookSecret,
        addresses: null,
      },
    })
    expect(created.statusCode).toBe(201)
    expectClean(created.body, 'the contact create response')

    const email = await harness.as(harness.operator, {
      method: 'POST',
      url: '/api/v1/alerts/contact-points',
      payload: {
        name: 'Planted mail contact',
        kind: 'email',
        addresses: 'ops@example.test',
        provider: 'sendgrid',
        providerConfig: { from: 'alerts@example.test' },
        credentials: { apiKey: PLANTED.apiKey },
      },
    })
    expect(email.statusCode).toBe(201)
    expectClean(email.body, 'the email contact create response')

    const list = await harness.as(harness.viewer, {
      method: 'GET',
      url: '/api/v1/alerts/contact-points',
    })
    expectClean(list.body, 'the contact list')
    // The flag that says one exists is fine; the value is not.
    expect(list.body).toContain('secretConfigured')
  }, 30_000)

  it('an OIDC client secret never comes back', async () => {
    const saved = await harness.as(harness.administrator, {
      method: 'PUT',
      url: '/api/v1/settings/oidc',
      payload: {
        enabled: false,
        name: 'Single sign-on',
        issuerUrl: 'https://issuer.example',
        clientId: 'planted-client',
        clientSecret: PLANTED.clientSecret,
        redirectUri: 'http://localhost:5173/api/v1/auth/oidc/callback',
        scopes: 'openid profile email',
        jitProvisioning: true,
        adminGroup: null,
        operatorGroup: null,
      },
    })
    // Asserted, because a rejected save would leave nothing to disclose and the
    // check below would pass without proving anything.
    expect(saved.statusCode, saved.body).toBe(200)
    expectClean(saved.body, 'the OIDC save response')

    const read = await harness.as(harness.administrator, {
      method: 'GET',
      url: '/api/v1/settings/oidc',
    })
    expectClean(read.body, 'the OIDC settings response')
    expect(read.body).toContain('clientSecretConfigured')
  }, 30_000)

  it('no error response quotes infrastructure credentials', async () => {
    // Connection strings carry passwords. An error that includes one turns a
    // stack trace into a credential disclosure.
    const probes = [
      { method: 'GET' as const, url: '/api/v1/graphs/fleet' },
      { method: 'GET' as const, url: '/api/v1/storage' },
      { method: 'GET' as const, url: '/api/v1/system/health' },
      { method: 'GET' as const, url: '/api/v1/nonexistent' },
    ]
    for (const probe of probes) {
      const response = await harness.as(harness.administrator, probe)
      const body = response.body
      for (const marker of ['postgresql://', 'password=', 'pricklescope-postgres', 'Bearer ']) {
        expect(body, `${probe.url} disclosed ${marker}`).not.toContain(marker)
      }
      // Nor the shape of the machine it runs on.
      expect(body, `${probe.url} returned a stack trace`).not.toContain('at Object.')
      expect(body).not.toContain('/home/')
      expect(body).not.toContain('node_modules')
    }
  }, 30_000)

  it('an unhandled failure says nothing beyond a request id', async () => {
    // QuestDB is not configured in this harness, so a graph read fails inside
    // the service — the realistic route to a leaked internal message.
    const response = await harness.as(harness.viewer, {
      method: 'GET',
      url: '/api/v1/graphs/fleet',
    })
    if (response.statusCode >= 500) {
      expect(response.json()).toMatchObject({
        error: 'internal_error',
        message: 'The request could not be completed',
      })
      expect((response.json() as { requestId?: string }).requestId).toBeTruthy()
    }
  })

  it('the redacted configuration keeps every secret out', () => {
    const config = loadConfig({
      PRICKLESCOPE_NODE_ENV: 'test',
      PRICKLESCOPE_DATABASE_URL: `postgresql://user:${PLANTED.community}@localhost:5432/pricklescope_test`,
      PRICKLESCOPE_QUESTDB_DATABASE_URL: `postgresql://user:${PLANTED.authPassword}@localhost:8812/qdb`,
      PRICKLESCOPE_GRAFANA_ADMIN_USER: 'admin',
      PRICKLESCOPE_GRAFANA_ADMIN_PASSWORD: PLANTED.privacyPassword,
      PRICKLESCOPE_GRAFANA_QUESTDB_USER: 'grafana',
      PRICKLESCOPE_GRAFANA_QUESTDB_PASSWORD: PLANTED.webhookSecret,
      PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD: PLANTED.apiKey,
    })
    expectClean(JSON.stringify(redactConfig(config)), 'the redacted configuration')
  })

  it('the log redaction list covers every secret-bearing request field', () => {
    // The list is easy to forget when a schema gains a field. This holds it to
    // what the contracts actually declare.
    const paths = new Set<string>(LOG_REDACT_PATHS)
    const secretish =
      /^(password|currentPassword|newPassword|community|authPassword|privacyPassword|clientSecret|apiKey|refreshToken|secret|token|deliveryToken)$/

    const missing: string[] = []
    const walk = (node: unknown, depth = 0): void => {
      if (depth > 12 || typeof node !== 'object' || node === null) return
      const schema = node as Record<string, unknown>
      if (schema.properties) {
        for (const [key, child] of Object.entries(schema.properties)) {
          if (secretish.test(key) && !paths.has(`*.${key}`)) missing.push(key)
          walk(child, depth + 1)
        }
      }
      for (const branch of ['items', 'anyOf', 'allOf', 'oneOf'] as const) {
        const value = schema[branch]
        if (Array.isArray(value)) value.forEach((child) => walk(child, depth + 1))
        else if (value) walk(value, depth + 1)
      }
    }

    for (const [name, schema] of Object.entries(contracts)) {
      if (!name.endsWith('RequestSchema')) continue
      walk(schema)
    }

    expect([...new Set(missing)], 'add these to LOG_REDACT_PATHS in src/logging.ts').toEqual([])
  })

  it('an SNMP failure message does not quote the credential it used', async () => {
    // The device is unreachable, so the adapter's own error text is what comes
    // back — and that text is where a community string would surface.
    const credential = await harness.as(harness.administrator, {
      method: 'POST',
      url: '/api/v1/credentials/snmp',
      payload: { name: 'Planted v2c', version: '2c', community: PLANTED.community },
    })
    expect(credential.statusCode).toBe(201)
    const { id: credentialId } = credential.json() as { id: string }

    const profiles = await harness.as(harness.viewer, {
      method: 'GET',
      url: '/api/v1/polling-profiles',
    })
    const { profiles: list } = profiles.json() as { profiles: { id: string }[] }
    expect(list.length, 'no polling profile to attach a source to').toBeGreaterThan(0)

    const source = await harness.as(harness.operator, {
      method: 'POST',
      url: '/api/v1/sources',
      payload: {
        name: 'Unreachable planted source',
        // Reserved for documentation; it will not answer.
        target: '192.0.2.1',
        credentialId,
        profileId: list[0]!.id,
      },
    })
    expect(source.statusCode).toBe(201)
    const { id: sourceId } = source.json() as { id: string }

    const test = await harness.as(harness.operator, {
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/test`,
    })
    expectClean(test.body, 'the SNMP test response')
  }, 30_000)
})
