import {
  UpsertAlertRuleRequestSchema,
  UpsertContactPointRequestSchema,
} from '@pricklescope/contracts'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

/**
 * Fastify validates bodies with Ajv type coercion on. Ajv coerces inside
 * `anyOf` and keeps the first branch that passes, so a nullable field written as
 * a union silently turned an explicit `null` into `''` or `0` — clearing an
 * interface scope stored an empty string, and clearing a recovery threshold
 * stored zero. These tests hold the request schemas to what the form sends.
 */
async function parse(schema: object, body: unknown): Promise<Record<string, unknown>> {
  const app = Fastify()
  let received: Record<string, unknown> = {}
  app.post('/probe', { schema: { body: schema } }, (request, reply) => {
    received = request.body as Record<string, unknown>
    return reply.code(204).send()
  })
  const response = await app.inject({ method: 'POST', url: '/probe', payload: body })
  await app.close()
  if (response.statusCode !== 204) throw new Error(response.body)
  return received
}

const rule = {
  name: 'Firewall availability',
  sourceId: '863face2-7220-4b9f-a0fc-1050cc1c86f8',
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
}

describe('alert request schemas keep an explicit null', () => {
  it('leaves a cleared interface scope and recovery threshold as null', async () => {
    const body = await parse(UpsertAlertRuleRequestSchema, {
      ...rule,
      description: null,
      ifIndex: null,
      recoveryThreshold: null,
    })
    expect(body.description).toBeNull()
    expect(body.ifIndex).toBeNull()
    expect(body.recoveryThreshold).toBeNull()
    expect(body.contactPointId).toBeNull()
  })

  it('still accepts a fleet-wide rule with no source', async () => {
    const body = await parse(UpsertAlertRuleRequestSchema, { ...rule, sourceId: null })
    expect(body.sourceId).toBeNull()
  })

  it('keeps a real zero recovery threshold', async () => {
    const body = await parse(UpsertAlertRuleRequestSchema, { ...rule, recoveryThreshold: 0 })
    expect(body.recoveryThreshold).toBe(0)
  })

  /**
   * The email adapter lets a caller override each provider's base URL so its own
   * tests can assert the request it builds. `UpsertContactPointRequestSchema`
   * closes itself to unknown keys, but a nested object does not inherit that, so
   * `providerConfig.apiBaseUrl` used to survive validation and was stored verbatim
   * — an operator could make the controller post the provider's API key to a host
   * of their choosing.
   */
  it('drops a provider setting the product does not define', async () => {
    const body = await parse(UpsertContactPointRequestSchema, {
      name: 'Ops mail',
      kind: 'email',
      addresses: 'ops@example.test',
      provider: 'sendgrid',
      providerConfig: { from: 'alerts@example.test', apiBaseUrl: 'https://attacker.example' },
    })
    expect(body.providerConfig).toEqual({ from: 'alerts@example.test' })
  })

  it('drops an unknown credential field', async () => {
    const body = await parse(UpsertContactPointRequestSchema, {
      name: 'Ops mail',
      kind: 'email',
      addresses: 'ops@example.test',
      provider: 'sendgrid',
      providerConfig: { from: 'alerts@example.test' },
      credentials: { apiKey: 'SG.real', tokenBaseUrl: 'https://attacker.example' },
    })
    expect(body.credentials).toEqual({ apiKey: 'SG.real' })
  })

  it('leaves the unused half of a contact point as null', async () => {
    const webhook = await parse(UpsertContactPointRequestSchema, {
      name: 'Ops',
      kind: 'webhook',
      url: 'https://example.test/hook',
      addresses: null,
    })
    expect(webhook.addresses).toBeNull()

    const email = await parse(UpsertContactPointRequestSchema, {
      name: 'Ops mail',
      kind: 'email',
      url: null,
      addresses: 'ops@example.test',
      provider: 'sendgrid',
    })
    expect(email.url).toBeNull()
  })
})
