import { describe, expect, it } from 'vitest'

import { loadConfig, redactConfig } from './config.js'

const minimumEnvironment: NodeJS.ProcessEnv = {
  PRICKLESCOPE_NODE_ENV: 'test',
  PRICKLESCOPE_DATABASE_URL: 'postgresql://user:secret@database/pricklescope',
}

describe('application configuration', () => {
  it('loads typed defaults', () => {
    const config = loadConfig(minimumEnvironment)
    expect(config.port).toBe(3001)
    expect(config.oidc.enabled).toBe(false)
    expect(config.jobs.concurrency).toBe(2)
    expect(config.storage.questdbDatabaseUrl).toBeNull()
    expect(config.grafana.internalUrl).toBeNull()
  })

  it('derives GUI-owned OIDC defaults from the public application origin', () => {
    const config = loadConfig({
      ...minimumEnvironment,
      PRICKLESCOPE_APP_ORIGIN: 'https://monitoring.example',
    })
    expect(config.oidc).toMatchObject({
      enabled: false,
      issuerUrl: null,
      clientId: null,
      clientSecret: null,
      redirectUri: 'https://monitoring.example/api/v1/auth/oidc/callback',
    })
  })

  it('defaults production sessions to secure cookies for same-origin embedding', () => {
    const config = loadConfig({
      ...minimumEnvironment,
      PRICKLESCOPE_NODE_ENV: 'production',
      PRICKLESCOPE_APP_ORIGIN: 'https://monitoring.example',
      PRICKLESCOPE_CREDENTIAL_KEY: Buffer.alloc(32).toString('base64'),
    })
    expect(config.session.secure).toBe(true)
  })

  it('redacts every configured secret', () => {
    const config = loadConfig({
      ...minimumEnvironment,
      PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-secret',
      PRICKLESCOPE_QUESTDB_DATABASE_URL: 'postgresql://controller:questdb-secret@questdb/qdb',
      PRICKLESCOPE_GRAFANA_ADMIN_USER: 'grafana-admin',
      PRICKLESCOPE_GRAFANA_ADMIN_PASSWORD: 'grafana-admin-secret',
      PRICKLESCOPE_GRAFANA_QUESTDB_USER: 'grafana-reader',
      PRICKLESCOPE_GRAFANA_QUESTDB_PASSWORD: 'grafana-questdb-secret',
    })
    const serialized = JSON.stringify(redactConfig(config))
    expect(serialized).not.toContain('bootstrap-secret')
    expect(serialized).not.toContain('user:secret')
    expect(serialized).not.toContain('questdb-secret')
    expect(serialized).not.toContain('grafana-admin-secret')
    expect(serialized).not.toContain('grafana-questdb-secret')
    expect(serialized).toContain('REDACTED')
  })
})
