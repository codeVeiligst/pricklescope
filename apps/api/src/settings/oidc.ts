import type {
  OidcDiscoveryResult,
  OidcProviderSettings,
  OidcSettingsSource,
  UpdateOidcProviderSettingsRequest,
} from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { Kysely, Selectable } from 'kysely'

import type { AuthStore } from '../auth/store.js'
import { discoverOidc } from '../auth/oidc-discovery.js'
import type { AppConfig, OidcConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { OidcSecretCrypto, type EncryptedOidcSecret } from './oidc-secret.js'

const PROVIDER_KEY = 'primary'
const CALLBACK_PATH = '/api/v1/auth/oidc/callback'

type SettingsRow = Selectable<Database['oidc_provider_settings']>

interface EffectiveSettings {
  settings: OidcConfig
  source: OidcSettingsSource
  updatedAt: Date | null
}

function trimmed(value: string | null): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function encryptedSecret(row: SettingsRow): EncryptedOidcSecret | null {
  if (
    row.client_secret_key_version === null ||
    row.client_secret_nonce === null ||
    row.client_secret_ciphertext === null ||
    row.client_secret_auth_tag === null
  ) {
    return null
  }
  return {
    keyVersion: row.client_secret_key_version,
    nonce: row.client_secret_nonce,
    ciphertext: row.client_secret_ciphertext,
    authTag: row.client_secret_auth_tag,
  }
}

export class OidcSettingsService {
  private readonly crypto: OidcSecretCrypto

  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuthStore,
    private readonly config: AppConfig,
  ) {
    this.crypto = new OidcSecretCrypto(
      config.security.credentialKey,
      config.security.credentialKeyVersion,
    )
  }

  async effective(): Promise<OidcConfig> {
    return (await this.loadEffective()).settings
  }

  async get(): Promise<OidcProviderSettings> {
    return this.publicSettings(await this.loadEffective())
  }

  async test(
    input: UpdateOidcProviderSettingsRequest,
    actorUserId: string,
  ): Promise<OidcDiscoveryResult> {
    const current = await this.loadEffective()
    const candidate = this.candidate(input, current.settings)
    this.validate(candidate, true)
    try {
      const result = await this.discover(candidate)
      await this.audit.writeAudit({
        actorUserId,
        action: 'oidc.settings_tested',
        resourceType: 'oidc_provider',
        resourceId: PROVIDER_KEY,
        outcome: 'success',
        metadata: { issuer: result.issuer },
      })
      return result
    } catch (error) {
      await this.audit.writeAudit({
        actorUserId,
        action: 'oidc.settings_tested',
        resourceType: 'oidc_provider',
        resourceId: PROVIDER_KEY,
        outcome: 'failure',
        metadata: { issuer: candidate.issuerUrl },
      })
      if (error instanceof HttpError) throw error
      throw new HttpError(
        400,
        'oidc_discovery_failed',
        'The provider discovery document could not be verified',
      )
    }
  }

  async update(
    input: UpdateOidcProviderSettingsRequest,
    actorUserId: string,
  ): Promise<OidcProviderSettings> {
    await this.requireLocalAdministrator()
    const current = await this.loadEffective()
    const candidate = this.candidate(input, current.settings)
    this.validate(candidate, false)
    if (candidate.enabled) {
      try {
        await this.discover(candidate)
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(
          400,
          'oidc_discovery_failed',
          'OIDC cannot be enabled because provider discovery failed',
        )
      }
    }

    const encrypted = candidate.clientSecret
      ? this.crypto.encrypt(PROVIDER_KEY, candidate.clientSecret)
      : null
    const now = new Date()
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('oidc_provider_settings')
        .values({
          provider_key: PROVIDER_KEY,
          enabled: candidate.enabled,
          name: candidate.name,
          issuer_url: candidate.issuerUrl,
          client_id: candidate.clientId,
          client_secret_key_version: encrypted?.keyVersion ?? null,
          client_secret_nonce: encrypted?.nonce ?? null,
          client_secret_ciphertext: encrypted?.ciphertext ?? null,
          client_secret_auth_tag: encrypted?.authTag ?? null,
          redirect_uri: candidate.redirectUri,
          scopes: candidate.scopes,
          jit_provisioning: candidate.jitProvisioning,
          admin_group: candidate.adminGroup,
          operator_group: candidate.operatorGroup,
          updated_at: now,
          updated_by: actorUserId,
        })
        .onConflict((conflict) =>
          conflict.column('provider_key').doUpdateSet({
            enabled: candidate.enabled,
            name: candidate.name,
            issuer_url: candidate.issuerUrl,
            client_id: candidate.clientId,
            client_secret_key_version: encrypted?.keyVersion ?? null,
            client_secret_nonce: encrypted?.nonce ?? null,
            client_secret_ciphertext: encrypted?.ciphertext ?? null,
            client_secret_auth_tag: encrypted?.authTag ?? null,
            redirect_uri: candidate.redirectUri,
            scopes: candidate.scopes,
            jit_provisioning: candidate.jitProvisioning,
            admin_group: candidate.adminGroup,
            operator_group: candidate.operatorGroup,
            updated_at: now,
            updated_by: actorUserId,
          }),
        )
        .execute()
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'oidc.settings_updated',
          resourceType: 'oidc_provider',
          resourceId: PROVIDER_KEY,
          outcome: 'success',
          metadata: {
            enabled: candidate.enabled,
            issuer: candidate.issuerUrl,
            sourceBefore: current.source,
            clientSecretChanged:
              input.clientSecret !== undefined || input.clearClientSecret === true,
          },
        },
        transaction,
      )
    })
    return this.get()
  }

  async reset(actorUserId: string): Promise<OidcProviderSettings> {
    await this.requireLocalAdministrator()
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom('oidc_provider_settings')
        .where('provider_key', '=', PROVIDER_KEY)
        .execute()
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'oidc.settings_reset',
          resourceType: 'oidc_provider',
          resourceId: PROVIDER_KEY,
          outcome: 'success',
          metadata: { source: 'defaults' },
        },
        transaction,
      )
    })
    return this.get()
  }

  private async loadEffective(): Promise<EffectiveSettings> {
    const row = await this.db
      .selectFrom('oidc_provider_settings')
      .selectAll()
      .where('provider_key', '=', PROVIDER_KEY)
      .executeTakeFirst()
    if (!row) return { settings: { ...this.config.oidc }, source: 'defaults', updatedAt: null }
    const encrypted = encryptedSecret(row)
    return {
      source: 'database',
      updatedAt: row.updated_at,
      settings: {
        enabled: row.enabled,
        name: row.name,
        issuerUrl: row.issuer_url,
        clientId: row.client_id,
        clientSecret: encrypted ? this.crypto.decrypt(PROVIDER_KEY, encrypted) : null,
        redirectUri: row.redirect_uri,
        scopes: row.scopes,
        jitProvisioning: row.jit_provisioning,
        adminGroup: row.admin_group,
        operatorGroup: row.operator_group,
      },
    }
  }

  private candidate(input: UpdateOidcProviderSettingsRequest, current: OidcConfig): OidcConfig {
    if (input.clientSecret !== undefined && input.clearClientSecret) {
      throw new HttpError(
        400,
        'oidc_secret_conflict',
        'Choose either a replacement client secret or remove the existing secret',
      )
    }
    const scopes = [...new Set(input.scopes.trim().split(/\s+/).filter(Boolean))].join(' ')
    return {
      enabled: input.enabled,
      name: input.name.trim(),
      issuerUrl: trimmed(input.issuerUrl),
      clientId: trimmed(input.clientId),
      clientSecret: input.clearClientSecret ? null : (input.clientSecret ?? current.clientSecret),
      redirectUri: input.redirectUri.trim(),
      scopes,
      jitProvisioning: input.jitProvisioning,
      adminGroup: trimmed(input.adminGroup),
      operatorGroup: trimmed(input.operatorGroup),
    }
  }

  private validate(settings: OidcConfig, requireDiscoverable: boolean): void {
    if (!settings.scopes.split(' ').includes('openid')) {
      throw new HttpError(400, 'oidc_scope_invalid', 'OIDC scopes must include openid')
    }
    if (
      settings.adminGroup &&
      settings.operatorGroup &&
      settings.adminGroup === settings.operatorGroup
    ) {
      throw new HttpError(
        400,
        'oidc_group_mapping_invalid',
        'Administrator and operator groups must be different',
      )
    }
    const mustBeComplete = settings.enabled || requireDiscoverable
    if (mustBeComplete && (!settings.issuerUrl || !settings.clientId)) {
      throw new HttpError(
        400,
        'oidc_configuration_incomplete',
        'Issuer URL and client ID are required before testing or enabling OIDC',
      )
    }
    if (settings.issuerUrl) this.validateUrl(settings.issuerUrl, 'issuer')
    const redirect = this.validateUrl(settings.redirectUri, 'redirect')
    if (redirect.pathname !== CALLBACK_PATH || redirect.search || redirect.hash) {
      throw new HttpError(
        400,
        'oidc_redirect_invalid',
        `The redirect URI must use the ${CALLBACK_PATH} callback path`,
      )
    }
  }

  private validateUrl(value: string, kind: 'issuer' | 'redirect'): URL {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new HttpError(400, `oidc_${kind}_invalid`, `The OIDC ${kind} URL is invalid`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new HttpError(400, `oidc_${kind}_invalid`, `The OIDC ${kind} URL is invalid`)
    }
    if (kind === 'issuer' && (url.search || url.hash)) {
      throw new HttpError(
        400,
        'oidc_issuer_invalid',
        'The issuer URL cannot contain a query or hash',
      )
    }
    if (this.config.environment === 'production' && url.protocol !== 'https:') {
      throw new HttpError(400, `oidc_${kind}_insecure`, 'Production OIDC URLs must use HTTPS')
    }
    return url
  }

  private async discover(settings: OidcConfig): Promise<OidcDiscoveryResult> {
    const configuration = await discoverOidc(settings, this.config.environment)
    const metadata = configuration.serverMetadata()
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error('OIDC discovery metadata is missing required endpoints')
    }
    return {
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      testedAt: new Date().toISOString(),
    }
  }

  private publicSettings(effective: EffectiveSettings): OidcProviderSettings {
    return {
      enabled: effective.settings.enabled,
      name: effective.settings.name,
      issuerUrl: effective.settings.issuerUrl,
      clientId: effective.settings.clientId,
      clientSecretConfigured: Boolean(effective.settings.clientSecret),
      redirectUri: effective.settings.redirectUri,
      scopes: effective.settings.scopes,
      jitProvisioning: effective.settings.jitProvisioning,
      adminGroup: effective.settings.adminGroup,
      operatorGroup: effective.settings.operatorGroup,
      source: effective.source,
      updatedAt: effective.updatedAt?.toISOString() ?? null,
    }
  }

  private async requireLocalAdministrator(): Promise<void> {
    const administrator = await this.db
      .selectFrom('users')
      .innerJoin('local_credentials', 'local_credentials.user_id', 'users.id')
      .select('users.id')
      .where('users.role', '=', 'administrator')
      .where('users.active', '=', true)
      .executeTakeFirst()
    if (!administrator) {
      throw new HttpError(
        400,
        'local_administrator_required',
        'Keep an active local administrator before changing OIDC settings',
      )
    }
  }
}
