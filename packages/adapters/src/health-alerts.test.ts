import { HEALTH_ALERT_CATALOGUE, type HealthAlertKey } from '@pricklescope/contracts'
import { describe, expect, it } from 'vitest'

import { HEALTH_ALERT_REDUCER, buildHealthAlertQuery } from './alert-query.js'
import { healthAlertRuleDefinition, healthAlertRuleUid } from './alert-rules.js'

const keys = Object.keys(HEALTH_ALERT_CATALOGUE) as HealthAlertKey[]

function definition(key: HealthAlertKey) {
  return healthAlertRuleDefinition({
    key,
    threshold: 1,
    forSeconds: 120,
    contactPoint: 'Ops',
  }) as Record<string, unknown>
}

describe('built-in health alert rules', () => {
  it('covers every key in the catalogue', () => {
    // The catalogue is what the settings screen renders. A key present there and
    // missing here would be a toggle that provisions nothing.
    for (const key of keys) {
      expect(() => buildHealthAlertQuery(key, 600), key).not.toThrow()
      expect(definition(key).uid, key).toBe(healthAlertRuleUid(key))
    }
    expect(keys).toHaveLength(5)
  })

  /**
   * The reconciler deletes remote rules carrying `pricklescope_rule` that it no
   * longer owns. If a health rule carried that label it would be deleted on
   * every reconcile, having just been written by the same reconcile.
   */
  it('labels health rules distinctly from user rules', () => {
    for (const key of keys) {
      const labels = definition(key).labels as Record<string, string>
      expect(labels.pricklescope_health, key).toBe(key)
      expect(labels.pricklescope_rule, key).toBeUndefined()
      expect(String(definition(key).uid), key).toMatch(/^ps-health-/)
    }
  })

  /**
   * The load-bearing property. The controller cannot record that QuestDB is down
   * or that it is dead itself, because both stop the write (D-041) — so a rule
   * with nothing to read has to fire rather than go quiet.
   */
  it('treats silence and query failure as alerting, never as health', () => {
    for (const key of keys) {
      expect(definition(key).noDataState, key).toBe('Alerting')
      expect(definition(key).execErrState, key).toBe('Alerting')
    }
  })

  it('reads each signal from the table that actually carries it', () => {
    expect(buildHealthAlertQuery('collector_silent', 600)).toContain('from collector_health')
    expect(buildHealthAlertQuery('dependency_down', 600)).toContain('from controller_health')
    expect(buildHealthAlertQuery('source_silent', 600)).toContain('from network_availability')
  })

  /**
   * The agent row is the only one carrying both error counts. "Neither input nor
   * output" also matches the processor and parser rows, which have neither and
   * no counts either — the first version of these queries returned them.
   */
  it('selects the collector agent row by go_version, not by absent tags', () => {
    for (const key of ['collector_silent', 'collector_write_errors'] as HealthAlertKey[]) {
      expect(buildHealthAlertQuery(key, 600), key).toContain('go_version is not null')
    }
  })

  /**
   * A source that has stopped reporting produces no rows, so a query counting
   * samples per source cannot see it: the missing series is the symptom. Asking
   * for the age of the last sample keeps the source in the result.
   */
  it('detects a silent source by age rather than by counting its samples', () => {
    const sql = buildHealthAlertQuery('source_silent', 600)
    expect(sql).toContain('datediff')
    // By id, not by name. A rename produced a phantom that never reported again
    // beside a new series that had only just started (audit F4).
    expect(sql).toContain('group by source_id')
    expect(sql).not.toContain('group by source_name')
    // Not scoped to the rule's lookback: a source silent for longer than the
    // window would drop out and stop alerting exactly when it got worse.
    expect(sql).toContain("dateadd('h', -24, now())")
  })

  /**
   * Filtering the failures out in the WHERE clause meant a healthy minute
   * produced no bucket at all, so the reducer kept reading the last failing one:
   * a blip stayed true for the whole window and fired after recovery. Counting
   * with a CASE keeps a zero in every bucket (audit F4).
   */
  it("reads the current dependency state, not the window's worst moment", () => {
    const sql = buildHealthAlertQuery('dependency_down', 300)
    expect(sql).toContain('case when')
    expect(sql).not.toMatch(/where\s+state\s*!=\s*'up'/)
    expect(HEALTH_ALERT_REDUCER.dependency_down).toBe('last')
    expect(HEALTH_ALERT_REDUCER.collector_buffer).toBe('last')
  })

  it('counts a cumulative counter as a delta over the window', () => {
    const sql = buildHealthAlertQuery('collector_write_errors', 600)
    expect(sql).toContain('max(write_errors) - min(write_errors)')
  })

  it('routes to the chosen contact point, and omits routing when there is none', () => {
    expect(definition('dependency_down').notification_settings).toEqual({ receiver: 'Ops' })
    const unrouted = healthAlertRuleDefinition({
      key: 'dependency_down',
      threshold: 0,
      forSeconds: 0,
      contactPoint: null,
    })
    expect(unrouted.notification_settings).toBeUndefined()
  })

  it('carries the catalogue description into Grafana so the alert explains itself', () => {
    const annotations = definition('collector_silent').annotations as Record<string, string>
    expect(annotations.description).toBe(HEALTH_ALERT_CATALOGUE.collector_silent.description)
    expect(annotations.__pricklescope_managed__).toBe('true')
  })
})
