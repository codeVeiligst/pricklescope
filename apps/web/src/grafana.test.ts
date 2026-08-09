import { describe, expect, it } from 'vitest'

import { grafanaUrl } from './grafana.js'

describe('Grafana links', () => {
  it('uses stable variables without URL credentials', () => {
    const result = new URL(
      grafanaUrl('pricklescope-fleet', {
        site_id: ['site-one', 'site-two'],
        source_id: 'source-one',
      }),
      'http://pricklescope.test',
    )
    expect(result.pathname).toBe('/grafana/d/pricklescope-fleet')
    expect(result.searchParams.getAll('var-site_id')).toEqual(['site-one', 'site-two'])
    expect(result.searchParams.get('var-source_id')).toBe('source-one')
    expect(result.toString()).not.toMatch(/token|auth|password/i)
  })

  it('builds a focused panel route', () => {
    expect(grafanaUrl('pricklescope-source', {}, { panelId: 3 })).toContain(
      '/grafana/d-solo/pricklescope-source?',
    )
  })

  it('never points the browser at a Grafana render endpoint', () => {
    expect(grafanaUrl('pricklescope-fleet')).not.toContain('/render/')
  })
})
