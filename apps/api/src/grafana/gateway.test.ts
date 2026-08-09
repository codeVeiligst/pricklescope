import type { User } from '@pricklescope/contracts'
import { describe, expect, it } from 'vitest'

import { grafanaProxyHeaders, grafanaRole } from './gateway.js'

const user: User = {
  id: '70d55baf-8404-4f9b-b94c-77ac045a9a26',
  username: 'operator',
  displayName: 'Network Operator',
  email: null,
  role: 'operator',
  authMethods: ['local'],
}

describe('Grafana gateway security', () => {
  it('strips client identity, credentials, cookies, and connection directives before injection', () => {
    const result = grafanaProxyHeaders(
      {
        authorization: 'Bearer attacker',
        cookie: 'pricklescope_session=secret',
        connection: 'x-webauth-user',
        'x-webauth-user': 'attacker',
        'x-webauth-role': 'Admin',
        'x-grafana-org-id': '99',
        accept: 'text/html',
      },
      user,
    )
    expect(result).toMatchObject({
      accept: 'text/html',
      'x-webauth-user': `ps-${user.id}`,
      'x-webauth-role': 'Editor',
    })
    expect(result).not.toHaveProperty('authorization')
    expect(result).not.toHaveProperty('cookie')
    expect(result).not.toHaveProperty('connection')
    expect(result).not.toHaveProperty('x-grafana-org-id')
  })

  it('never maps a human application user to Grafana Admin', () => {
    expect(grafanaRole('viewer')).toBe('Viewer')
    expect(grafanaRole('operator')).toBe('Editor')
    expect(grafanaRole('administrator')).toBe('Editor')
  })

  it('uses the same stable application identity for local and OIDC sessions', () => {
    const local = grafanaProxyHeaders({}, user)
    const oidc = grafanaProxyHeaders({}, { ...user, authMethods: ['oidc'] })
    expect(oidc['x-webauth-user']).toBe(local['x-webauth-user'])
    expect(oidc['x-webauth-role']).toBe(local['x-webauth-role'])
  })
})
