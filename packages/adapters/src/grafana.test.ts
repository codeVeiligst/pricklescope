import {
  GRAFANA_DASHBOARDS,
  GRAFANA_DATASOURCE_UID,
  GRAFANA_FOLDER_UID,
} from '@pricklescope/contracts'
import { describe, expect, it, vi } from 'vitest'

import { GrafanaApiClient, grafanaResourceDefinitions } from './grafana.js'

describe('Grafana managed resources', () => {
  it('uses stable reusable UIDs and write-only datasource secrets', () => {
    const password = 'grafana-questdb-test-password'
    const resources = grafanaResourceDefinitions({
      server: 'questdb',
      port: 8812,
      username: 'grafana',
      password,
    })

    expect(resources.map((resource) => resource.uid)).toEqual([
      GRAFANA_DATASOURCE_UID,
      GRAFANA_FOLDER_UID,
      ...Object.values(GRAFANA_DASHBOARDS).map((dashboard) => dashboard.uid),
    ])
    expect(resources.filter((resource) => resource.type === 'dashboard')).toHaveLength(4)
    expect(resources.every((resource) => !resource.contentHash.includes(password))).toBe(true)
    expect(JSON.stringify(resources.slice(2))).not.toContain(password)
  })

  it('scopes reusable source and interface dashboards through variables', () => {
    const resources = grafanaResourceDefinitions({
      server: 'questdb',
      port: 8812,
      username: 'grafana',
      password: 'secret',
    })
    const source = resources.find((resource) => resource.uid === GRAFANA_DASHBOARDS.source.uid)!
    const interfaceDashboard = resources.find(
      (resource) => resource.uid === GRAFANA_DASHBOARDS.interface.uid,
    )!
    expect(JSON.stringify(source.body)).toContain('source_id')
    expect(JSON.stringify(source.body)).toContain('if_index')
    expect(JSON.stringify(interfaceDashboard.body)).toContain('${source_id:sqlstring}')
    expect(JSON.stringify(interfaceDashboard.body)).toContain('${if_index:sqlstring}')
  })

  it('keeps the published panel catalogue in step with the generated dashboards', () => {
    const resources = grafanaResourceDefinitions({
      server: 'questdb',
      port: 8812,
      username: 'grafana',
      password: 'secret',
    })

    for (const [key, descriptor] of Object.entries(GRAFANA_DASHBOARDS)) {
      const generated = resources.find((resource) => resource.uid === descriptor.uid)
      const panels = (generated?.body.panels ?? []) as { id: number; title: string }[]
      expect(
        panels.map((panel) => ({ id: panel.id, title: panel.title })),
        key,
      ).toEqual(descriptor.panels.map((panel) => ({ id: panel.id, title: panel.title })))
    }
  })

  it('replaces an existing managed folder instead of failing on its stored version', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ uid: GRAFANA_FOLDER_UID }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const client = GrafanaApiClient.bearer(
      'http://grafana.internal:3000/grafana/',
      'token',
      request as typeof fetch,
    )

    await client.ensureFolder()

    const update = request.mock.calls[1]!
    expect(update[0].toString()).toBe(
      `http://grafana.internal:3000/grafana/api/folders/${GRAFANA_FOLDER_UID}`,
    )
    expect(update[1]?.method).toBe('PUT')
    expect(JSON.parse(String(update[1]?.body))).toMatchObject({ overwrite: true })
  })

  it('preserves the configured Grafana subpath for management API calls', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: '13.1.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const client = GrafanaApiClient.anonymous(
      'http://grafana.internal:3000/grafana/',
      request as typeof fetch,
    )

    await expect(client.health()).resolves.toEqual({ version: '13.1.0' })
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      'http://grafana.internal:3000/grafana/api/health',
    )
  })
})
