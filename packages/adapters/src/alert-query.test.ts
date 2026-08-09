import { describe, expect, it } from 'vitest'

import { buildAlertQuery } from './alert-query.js'

const source = '863face2-7220-4b9f-a0fc-1050cc1c86f8'

describe('alert rule queries', () => {
  it('builds concrete SQL with no dashboard variables, because rules evaluate standalone', () => {
    const sql = buildAlertQuery('availability', { sourceId: source, ifIndex: null }, 600)
    expect(sql).toContain(`source_id = '${source}'`)
    expect(sql).toContain("dateadd('s', -600, now())")
    expect(sql).not.toMatch(/\$\{|\$__|var-/)
  })

  it('keeps each source a separate series so a fleet rule alerts per source', () => {
    expect(buildAlertQuery('latency', { sourceId: null, ifIndex: null }, 600)).toContain(
      'source_name',
    )
  })

  it('scopes to an interface only for per-interface metrics', () => {
    const sql = buildAlertQuery('inbound_bps', { sourceId: source, ifIndex: '25' }, 300)
    expect(sql).toContain("if_index = '25'")
    expect(() => buildAlertQuery('availability', { sourceId: source, ifIndex: '25' }, 300)).toThrow(
      /not measured per interface/,
    )
  })

  it('refuses scope values that cannot appear safely in a rule query', () => {
    for (const bad of ["x' or '1'='1", 'a;drop table network_system', "'"]) {
      expect(() => buildAlertQuery('latency', { sourceId: bad, ifIndex: null }, 600)).toThrow(
        /cannot be used/,
      )
    }
  })
})
