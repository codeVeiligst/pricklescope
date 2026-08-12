import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadDotenv } from 'dotenv'

export type Environment = 'development' | 'test' | 'production'

export interface OidcConfig {
  enabled: boolean
  name: string
  issuerUrl: string | null
  clientId: string | null
  clientSecret: string | null
  redirectUri: string
  scopes: string
  jitProvisioning: boolean
  adminGroup: string | null
  operatorGroup: string | null
}

export interface AppConfig {
  environment: Environment
  version: string
  host: string
  port: number
  appOrigin: string
  databaseUrl: string
  bootstrapAdmin: {
    username: string | null
    password: string | null
    displayName: string
  }
  session: {
    cookieName: string
    ttlSeconds: number
    secure: boolean
  }
  trustProxy: boolean
  autoMigrate: boolean
  runJobs: boolean
  jobs: {
    pollIntervalMs: number
    concurrency: number
  }
  security: {
    credentialKey: Buffer
    credentialKeyVersion: number
  }
  oidc: OidcConfig
  collectors: {
    telegrafConfigDirectory: string
  }
  storage: {
    questdbDatabaseUrl: string | null
    statementTimeoutMs: number
    queryLimit: number
  }
  grafana: {
    internalUrl: string | null
    publicPath: string
    adminUsername: string | null
    adminPassword: string | null
    questdbServer: string
    questdbPort: number
    questdbUsername: string | null
    questdbPassword: string | null
    // Where Grafana can reach this API to hand back an alert for email delivery.
    // Defaults to the app origin, which is wrong whenever Grafana runs in a
    // container and the API does not.
    notifyBaseUrl: string
  }
  dependencies: {
    questdbHealthUrl: string | null
    grafanaHealthUrl: string | null
    telegrafHost: string | null
    telegrafPort: number | null
  }
}

function telegrafConfigDirectory(env: NodeJS.ProcessEnv): string {
  const explicit = optional(env.PRICKLESCOPE_TELEGRAF_CONFIG_DIR)
  if (explicit) return resolve(explicit)
  const candidates = [
    resolve(process.cwd(), 'infra/runtime/telegraf'),
    resolve(process.cwd(), '../../infra/runtime/telegraf'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Expected boolean value, received ${value}`)
}

function integerValue(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function environmentValue(value: string | undefined): Environment {
  if (!value) return 'development'
  if (value === 'development' || value === 'test' || value === 'production') return value
  throw new Error('PRICKLESCOPE_NODE_ENV must be development, test, or production')
}

function bootstrapPassword(env: NodeJS.ProcessEnv): string | null {
  const direct = optional(env.PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD)
  const file = optional(env.PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD_FILE)
  if (direct && file) {
    throw new Error('Configure only one bootstrap administrator password source')
  }
  if (!file) return direct
  return readFileSync(file, 'utf8').trimEnd()
}

/**
 * Fingerprint of the key that shipped in .env.example before it was replaced with
 * a placeholder.
 *
 * Copying the example is how a .env gets made, so an installation can be running
 * on a key published in the repository without anyone having chosen it. Refusing
 * it in production is the only check that catches that after the fact.
 *
 * Held as a hash rather than the key itself: the literal is a base64 blob that a
 * secret scanner flags on sight, and a check against a bad key does not need to
 * carry the bad key.
 */
const PUBLISHED_EXAMPLE_KEY_SHA256 = // gitleaks:allow — a digest, not a secret
  '7c9789eb2885105073eba2edd5d09e384c0c35e0a87e9b71e53fce91b4215c8e'

function credentialKey(env: NodeJS.ProcessEnv, environment: Environment): Buffer {
  const direct = optional(env.PRICKLESCOPE_CREDENTIAL_KEY)
  const file = optional(env.PRICKLESCOPE_CREDENTIAL_KEY_FILE)
  if (direct && file) throw new Error('Configure only one credential encryption key source')
  if (!direct && !file) {
    if (environment === 'test') return Buffer.alloc(32)
    throw new Error('PRICKLESCOPE_CREDENTIAL_KEY or PRICKLESCOPE_CREDENTIAL_KEY_FILE is required')
  }
  const encoded = file ? readFileSync(file, 'utf8').trim() : direct!
  const fingerprint = createHash('sha256').update(encoded).digest('hex')
  if (fingerprint === PUBLISHED_EXAMPLE_KEY_SHA256 && environment === 'production') {
    throw new Error(
      'PRICKLESCOPE_CREDENTIAL_KEY is the example key from the repository. ' +
        'Generate one with: openssl rand -base64 32',
    )
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) {
    throw new Error('The credential encryption key must be exactly 32 bytes encoded as base64')
  }
  return key
}

function required(value: string | null, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function loadEnvironmentFile(): void {
  const explicit = optional(process.env.PRICKLESCOPE_ENV_FILE)
  const candidates = explicit
    ? [explicit]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]
  const selected = candidates.find((candidate) => existsSync(candidate))
  if (selected) loadDotenv({ path: selected, quiet: true })
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = environmentValue(env.PRICKLESCOPE_NODE_ENV)
  const appOrigin = optional(env.PRICKLESCOPE_APP_ORIGIN) ?? 'http://localhost:5173'

  const config: AppConfig = {
    environment,
    // Only reached when PRICKLESCOPE_VERSION is unset, which is development and
    // tests. Naming a real released version there made a dev build claim to be
    // one; `0.0.0-dev` cannot be mistaken for anything published.
    version: optional(env.PRICKLESCOPE_VERSION) ?? '0.0.0-dev',
    host: optional(env.PRICKLESCOPE_HOST) ?? 'localhost',
    port: integerValue(env.PRICKLESCOPE_API_PORT, 3001, 'PRICKLESCOPE_API_PORT', 1, 65_535),
    appOrigin,
    databaseUrl: required(optional(env.PRICKLESCOPE_DATABASE_URL), 'PRICKLESCOPE_DATABASE_URL'),
    bootstrapAdmin: {
      username: optional(env.PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME),
      password: bootstrapPassword(env),
      displayName:
        optional(env.PRICKLESCOPE_BOOTSTRAP_ADMIN_DISPLAY_NAME) ?? 'PrickleScope Administrator',
    },
    session: {
      cookieName: optional(env.PRICKLESCOPE_SESSION_COOKIE_NAME) ?? 'pricklescope_session',
      ttlSeconds: integerValue(
        env.PRICKLESCOPE_SESSION_TTL_SECONDS,
        28_800,
        'PRICKLESCOPE_SESSION_TTL_SECONDS',
        300,
        2_592_000,
      ),
      secure: booleanValue(
        env.PRICKLESCOPE_COOKIE_SECURE,
        env.PRICKLESCOPE_NODE_ENV === 'production',
      ),
    },
    trustProxy: booleanValue(env.PRICKLESCOPE_TRUST_PROXY, false),
    autoMigrate: booleanValue(env.PRICKLESCOPE_AUTO_MIGRATE, false),
    runJobs: booleanValue(env.PRICKLESCOPE_RUN_JOBS, true),
    jobs: {
      pollIntervalMs: integerValue(
        env.PRICKLESCOPE_JOB_POLL_INTERVAL_MS,
        1_000,
        'PRICKLESCOPE_JOB_POLL_INTERVAL_MS',
        100,
        60_000,
      ),
      concurrency: integerValue(
        env.PRICKLESCOPE_JOB_CONCURRENCY,
        2,
        'PRICKLESCOPE_JOB_CONCURRENCY',
        1,
        16,
      ),
    },
    security: {
      credentialKey: credentialKey(env, environment),
      credentialKeyVersion: integerValue(
        env.PRICKLESCOPE_CREDENTIAL_KEY_VERSION,
        1,
        'PRICKLESCOPE_CREDENTIAL_KEY_VERSION',
        1,
        2_147_483_647,
      ),
    },
    oidc: {
      enabled: false,
      name: 'Single sign-on',
      issuerUrl: null,
      clientId: null,
      clientSecret: null,
      redirectUri: `${appOrigin}/api/v1/auth/oidc/callback`,
      scopes: 'openid profile email',
      jitProvisioning: true,
      adminGroup: null,
      operatorGroup: null,
    },
    collectors: {
      telegrafConfigDirectory: telegrafConfigDirectory(env),
    },
    storage: {
      questdbDatabaseUrl: optional(env.PRICKLESCOPE_QUESTDB_DATABASE_URL),
      statementTimeoutMs: integerValue(
        env.PRICKLESCOPE_QUESTDB_STATEMENT_TIMEOUT_MS,
        5_000,
        'PRICKLESCOPE_QUESTDB_STATEMENT_TIMEOUT_MS',
        500,
        60_000,
      ),
      queryLimit: integerValue(
        env.PRICKLESCOPE_QUESTDB_QUERY_LIMIT,
        500,
        'PRICKLESCOPE_QUESTDB_QUERY_LIMIT',
        1,
        10_000,
      ),
    },
    grafana: {
      notifyBaseUrl:
        optional(env.PRICKLESCOPE_NOTIFY_BASE_URL) ??
        optional(env.PRICKLESCOPE_APP_ORIGIN) ??
        'http://localhost:5173',
      internalUrl: optional(env.PRICKLESCOPE_GRAFANA_URL),
      publicPath: '/grafana',
      adminUsername: optional(env.PRICKLESCOPE_GRAFANA_ADMIN_USER),
      adminPassword: optional(env.PRICKLESCOPE_GRAFANA_ADMIN_PASSWORD),
      questdbServer: optional(env.PRICKLESCOPE_GRAFANA_QUESTDB_SERVER) ?? 'questdb',
      questdbPort: integerValue(
        env.PRICKLESCOPE_GRAFANA_QUESTDB_PORT,
        8812,
        'PRICKLESCOPE_GRAFANA_QUESTDB_PORT',
        1,
        65_535,
      ),
      questdbUsername: optional(env.PRICKLESCOPE_GRAFANA_QUESTDB_USER),
      questdbPassword: optional(env.PRICKLESCOPE_GRAFANA_QUESTDB_PASSWORD),
    },
    dependencies: {
      questdbHealthUrl: optional(env.PRICKLESCOPE_QUESTDB_HEALTH_URL),
      grafanaHealthUrl: optional(env.PRICKLESCOPE_GRAFANA_HEALTH_URL),
      telegrafHost: optional(env.PRICKLESCOPE_TELEGRAF_HOST),
      telegrafPort: optional(env.PRICKLESCOPE_TELEGRAF_PORT)
        ? integerValue(
            env.PRICKLESCOPE_TELEGRAF_PORT,
            1234,
            'PRICKLESCOPE_TELEGRAF_PORT',
            1,
            65_535,
          )
        : null,
    },
  }

  if (config.bootstrapAdmin.username && !config.bootstrapAdmin.password) {
    throw new Error('A bootstrap administrator password is required when a username is configured')
  }
  if (!config.bootstrapAdmin.username && config.bootstrapAdmin.password) {
    throw new Error('A bootstrap administrator username is required when a password is configured')
  }
  if (config.environment === 'production' && !config.session.secure) {
    throw new Error('Secure session cookies are required in production')
  }
  if (Boolean(config.grafana.adminUsername) !== Boolean(config.grafana.adminPassword)) {
    throw new Error(
      'Grafana bootstrap administrator username and password must be configured together',
    )
  }
  if (Boolean(config.grafana.questdbUsername) !== Boolean(config.grafana.questdbPassword)) {
    throw new Error('Grafana QuestDB username and password must be configured together')
  }

  return config
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.password) url.password = 'REDACTED'
    return url.toString()
  } catch {
    return 'REDACTED'
  }
}

export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    databaseUrl: redactUrl(config.databaseUrl),
    bootstrapAdmin: {
      ...config.bootstrapAdmin,
      password: config.bootstrapAdmin.password ? 'REDACTED' : null,
    },
    oidc: {
      ...config.oidc,
      clientSecret: config.oidc.clientSecret ? 'REDACTED' : null,
    },
    security: {
      ...config.security,
      credentialKey: 'REDACTED',
    },
    storage: {
      ...config.storage,
      questdbDatabaseUrl: config.storage.questdbDatabaseUrl
        ? redactUrl(config.storage.questdbDatabaseUrl)
        : null,
    },
    grafana: {
      ...config.grafana,
      adminPassword: config.grafana.adminPassword ? 'REDACTED' : null,
      questdbPassword: config.grafana.questdbPassword ? 'REDACTED' : null,
    },
  }
}
