import * as client from 'openid-client'

import type { Environment, OidcConfig } from '../config.js'

export function discoverOidc(
  settings: OidcConfig,
  environment: Environment,
): Promise<client.Configuration> {
  if (!settings.issuerUrl || !settings.clientId) {
    throw new Error('OIDC discovery requires an issuer URL and client ID')
  }
  return client.discovery(
    new URL(settings.issuerUrl),
    settings.clientId,
    settings.clientSecret ?? undefined,
    undefined,
    environment === 'production' ? undefined : { execute: [client.allowInsecureRequests] },
  )
}
