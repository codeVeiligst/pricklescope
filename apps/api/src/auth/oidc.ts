import type { Role, User } from '@pricklescope/contracts'
import * as client from 'openid-client'

import type { AppConfig, OidcConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { randomToken, safeReturnTo } from '../security.js'
import { discoverOidc } from './oidc-discovery.js'
import type { AuthStore } from './store.js'

interface OidcStart {
  authorizationUrl: string
  flowToken: string
}

interface OidcFinish {
  user: User
  returnTo: string
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function groupsClaim(claims: Record<string, unknown>): string[] {
  const groups = claims.groups
  if (Array.isArray(groups))
    return groups.filter((group): group is string => typeof group === 'string')
  if (typeof groups === 'string') return groups.split(/[ ,]+/).filter(Boolean)
  return []
}

export function roleFromOidcClaims(
  claims: Record<string, unknown>,
  source: AppConfig | OidcConfig,
): Role {
  const settings = 'oidc' in source ? source.oidc : source
  const groups = new Set(groupsClaim(claims))
  if (settings.adminGroup && groups.has(settings.adminGroup)) return 'administrator'
  if (settings.operatorGroup && groups.has(settings.operatorGroup)) return 'operator'
  return 'viewer'
}

interface OidcSettingsProvider {
  effective: () => Promise<OidcConfig>
}

export class OidcService {
  private cachedConfiguration: {
    fingerprint: string
    configuration: Promise<client.Configuration>
  } | null = null

  constructor(
    private readonly store: AuthStore,
    private readonly config: AppConfig,
    private readonly settingsProvider?: OidcSettingsProvider,
  ) {}

  async summary(): Promise<{ enabled: boolean; name: string }> {
    const settings = await this.settings()
    return { enabled: settings.enabled, name: settings.name }
  }

  private async settings(): Promise<OidcConfig> {
    return this.settingsProvider ? this.settingsProvider.effective() : this.config.oidc
  }

  private async configuration(): Promise<{
    configuration: client.Configuration
    settings: OidcConfig
  }> {
    const settings = await this.settings()
    if (!settings.enabled || !settings.issuerUrl || !settings.clientId) {
      throw new HttpError(404, 'oidc_disabled', 'OpenID Connect is not configured')
    }
    const fingerprint = JSON.stringify(settings)
    if (this.cachedConfiguration?.fingerprint !== fingerprint) {
      this.cachedConfiguration = {
        fingerprint,
        configuration: discoverOidc(settings, this.config.environment),
      }
    }
    try {
      return { configuration: await this.cachedConfiguration.configuration, settings }
    } catch (error) {
      if (this.cachedConfiguration?.fingerprint === fingerprint) this.cachedConfiguration = null
      throw error
    }
  }

  async start(returnTo?: string): Promise<OidcStart> {
    const { configuration: oidcConfiguration, settings } = await this.configuration()
    const codeVerifier = client.randomPKCECodeVerifier()
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
    const state = client.randomState()
    const nonce = client.randomNonce()
    const flowToken = randomToken()
    await this.store.createOidcFlow({
      flowToken,
      state,
      codeVerifier,
      nonce,
      returnTo: safeReturnTo(returnTo),
    })

    const authorizationUrl = client.buildAuthorizationUrl(oidcConfiguration, {
      redirect_uri: settings.redirectUri,
      scope: settings.scopes,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })
    return { authorizationUrl: authorizationUrl.toString(), flowToken }
  }

  async finish(flowToken: string | undefined, callbackUrl: URL): Promise<OidcFinish> {
    if (!flowToken) throw new HttpError(400, 'oidc_flow_missing', 'The sign-in flow has expired')
    const flow = await this.store.consumeOidcFlow(flowToken)
    if (!flow)
      throw new HttpError(400, 'oidc_flow_invalid', 'The sign-in flow is invalid or expired')
    const { configuration: oidcConfiguration, settings } = await this.configuration()
    const configuredCallbackUrl = new URL(settings.redirectUri)
    configuredCallbackUrl.search = callbackUrl.search
    const tokens = await client.authorizationCodeGrant(oidcConfiguration, configuredCallbackUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
    })
    const rawClaims = tokens.claims()
    if (!rawClaims?.sub || !rawClaims.iss) {
      throw new HttpError(
        401,
        'oidc_claims_invalid',
        'The identity provider returned invalid claims',
      )
    }
    const claims = rawClaims as Record<string, unknown>
    const email = rawClaims.email_verified === false ? null : stringClaim(claims, 'email')
    const requestedUsername =
      stringClaim(claims, 'preferred_username') ??
      email?.split('@')[0] ??
      stringClaim(claims, 'name') ??
      `oidc-${rawClaims.sub.slice(0, 12)}`
    const user = await this.store.findOrCreateOidcUser(
      {
        issuer: rawClaims.iss,
        subject: rawClaims.sub,
        username: requestedUsername,
        displayName: stringClaim(claims, 'name') ?? requestedUsername,
        email,
        role: roleFromOidcClaims(claims, settings),
        claims,
      },
      settings.jitProvisioning,
    )
    if (!user) {
      throw new HttpError(
        403,
        'oidc_user_denied',
        'This identity is not allowed to use PrickleScope',
      )
    }
    await this.store.writeAudit({
      actorUserId: user.id,
      action: 'auth.oidc_login',
      resourceType: 'session',
      resourceId: null,
      outcome: 'success',
      metadata: { issuer: rawClaims.iss },
    })
    return { user, returnTo: flow.returnTo }
  }
}
