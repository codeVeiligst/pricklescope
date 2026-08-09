import { describe, expect, it } from 'vitest'

import type { OidcConfig } from '../config.js'
import { roleFromOidcClaims } from './oidc.js'

const config: OidcConfig = {
  enabled: true,
  name: 'Test provider',
  issuerUrl: 'https://issuer.example',
  clientId: 'client',
  clientSecret: null,
  redirectUri: 'https://pricklescope.example/api/v1/auth/oidc/callback',
  scopes: 'openid profile email',
  jitProvisioning: true,
  adminGroup: 'admins',
  operatorGroup: 'operators',
}

describe('OIDC role mapping', () => {
  it('defaults unknown identities to viewer', () => {
    expect(roleFromOidcClaims({}, config)).toBe('viewer')
  })

  it('prioritizes the administrator mapping', () => {
    expect(roleFromOidcClaims({ groups: ['operators', 'admins'] }, config)).toBe('administrator')
  })
})
