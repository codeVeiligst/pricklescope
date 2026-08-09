import { describe, expect, it } from 'vitest'

import {
  alertRuleDefinition,
  alertRuleUid,
  alignPending,
  contactPointDefinition,
} from './alert-rules.js'

const base = {
  id: '9c0fdbd6-ad23-4684-aec6-c21dfbc7368a',
  name: 'Firewall availability',
  description: null,
  sourceId: '863face2-7220-4b9f-a0fc-1050cc1c86f8',
  ifIndex: null,
  metric: 'availability' as const,
  reducer: 'last' as const,
  comparison: 'lt' as const,
  threshold: 99,
  recoveryThreshold: null,
  evaluationIntervalSeconds: 30,
  pendingSeconds: 60,
  lookbackSeconds: 600,
  noDataState: 'NoData' as const,
  execErrorState: 'Error' as const,
  severity: 'warning' as const,
  contactPoint: null,
}

function condition(definition: Record<string, unknown>) {
  const data = definition.data as Array<{ refId: string; model: Record<string, unknown> }>
  const threshold = data.find((entry) => entry.refId === 'C')!
  return (threshold.model.conditions as Record<string, unknown>[])[0]!
}

describe('Grafana alert rule definitions', () => {
  it('keeps a stable uid so a rule survives renames and reconciles', () => {
    expect(alertRuleUid(base.id)).toBe(alertRuleUid(base.id))
    expect(alertRuleUid(base.id)).not.toBe(alertRuleUid('11111111-2222-3333-4444-555555555555'))
  })

  it('builds query, reduce, and threshold with the threshold as the condition', () => {
    const definition = alertRuleDefinition(base)
    const data = definition.data as Array<{ refId: string; datasourceUid: string }>
    expect(data.map((entry) => entry.refId)).toEqual(['A', 'B', 'C'])
    expect(definition.condition).toBe('C')
    expect(data[1]?.datasourceUid).toBe('__expr__')
  })

  it('drops non-numeric results so a stale source is No Data rather than zero', () => {
    const data = alertRuleDefinition(base).data as Array<{
      refId: string
      model: Record<string, unknown>
    }>
    const reduce = data.find((entry) => entry.refId === 'B')!
    expect(reduce.model.settings).toEqual({ mode: 'dropNN' })
    expect(alertRuleDefinition(base).noDataState).toBe('NoData')
  })

  it('adds an unload evaluator only when a recovery threshold is set', () => {
    expect(condition(alertRuleDefinition(base)).unloadEvaluator).toBeUndefined()

    const hysteresis = condition(alertRuleDefinition({ ...base, recoveryThreshold: 99.5 }))
    // Fires below 99, clears above 99.5: the inverse comparison.
    expect(hysteresis.unloadEvaluator).toEqual({ type: 'gt', params: [99.5] })

    const upper = condition(
      alertRuleDefinition({ ...base, comparison: 'gt', threshold: 90, recoveryThreshold: 85 }),
    )
    expect(upper.unloadEvaluator).toEqual({ type: 'lt', params: [85] })
  })

  it('rounds the pending period up to whole evaluation intervals', () => {
    expect(alignPending(0, 60)).toBe(0)
    expect(alignPending(60, 60)).toBe(60)
    // Grafana rejects a `for` that is not a multiple of the interval.
    expect(alignPending(70, 60)).toBe(120)
    expect(alignPending(600, 30)).toBe(600)
    expect(alertRuleDefinition({ ...base, pendingSeconds: 70 }).for).toBe('90s')
  })

  it('routes on the rule so provisioning never rewrites the global policy tree', () => {
    expect(alertRuleDefinition(base).notification_settings).toBeUndefined()
    expect(
      alertRuleDefinition({ ...base, contactPoint: 'Ops webhook' }).notification_settings,
    ).toEqual({ receiver: 'Ops webhook' })
  })

  it('carries the controller rule id as a label so state can be matched back', () => {
    const labels = alertRuleDefinition(base).labels as Record<string, string>
    expect(labels.pricklescope_rule).toBe(base.id)
    expect(labels.severity).toBe('warning')
  })
})

describe('contact point definitions', () => {
  it('sends a webhook bearer token only when one is configured', () => {
    const plain = contactPointDefinition({
      name: 'Ops',
      kind: 'webhook',
      url: 'https://example.test/hook',
      addresses: null,
      secret: null,
    })
    expect(plain.type).toBe('webhook')
    expect(plain.settings).toEqual({ url: 'https://example.test/hook', httpMethod: 'POST' })

    const authorized = contactPointDefinition({
      name: 'Ops',
      kind: 'webhook',
      url: 'https://example.test/hook',
      addresses: null,
      secret: 'shhh',
    })
    expect(authorized.settings).toMatchObject({
      authorization_scheme: 'Bearer',
      authorization_credentials: 'shhh',
    })
  })

  it('points email back at the controller instead of an SMTP relay', () => {
    const email = contactPointDefinition({
      name: 'Ops',
      kind: 'email',
      url: null,
      addresses: 'ops@example.test',
      secret: null,
      deliveryUrl: 'http://host.docker.internal:3001/api/v1/alerts/notify/ref-1',
      deliveryToken: 'delivery-token',
    })
    expect(email.type).toBe('webhook')
    expect(email.settings).toEqual({
      url: 'http://host.docker.internal:3001/api/v1/alerts/notify/ref-1',
      httpMethod: 'POST',
      authorization_scheme: 'Bearer',
      authorization_credentials: 'delivery-token',
    })
  })

  it('refuses an email contact point Grafana could not call back', () => {
    expect(() =>
      contactPointDefinition({
        name: 'Ops',
        kind: 'email',
        url: null,
        addresses: 'ops@example.test',
        secret: null,
      }),
    ).toThrow(/delivery URL/)
  })
})
