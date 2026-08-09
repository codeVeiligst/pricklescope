import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMetadataDatabase, migrateToLatest, type MetadataDatabase } from '@pricklescope/db'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { sql } from 'kysely'

import { buildApp } from '../../src/app.js'
import { bootstrapAdministrator } from '../../src/auth/bootstrap.js'
import { AuthStore } from '../../src/auth/store.js'
import { loadConfig, loadEnvironmentFile } from '../../src/config.js'
import { hashPassword } from '../../src/security.js'

loadEnvironmentFile()

export const databaseUrl = process.env.TEST_DATABASE_URL

if (databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must target a database whose name ends in _test')
  }
}

export type Role = 'viewer' | 'operator' | 'administrator'

export interface Actor {
  role: Role | 'anonymous'
  cookie: string
  csrf: string
  userId: string
}

const ADMIN_PASSWORD = 'security-admin-password'
const ROLE_PASSWORD = 'security-role-password'

export interface Harness {
  app: FastifyInstance
  metadata: MetadataDatabase
  /** The origin the API accepts mutations from, for tests that vary it. */
  appOrigin: string
  /** Credentials the login route will accept, for tests that exercise it. */
  credentials: { username: string; password: string }
  anonymous: Actor
  viewer: Actor
  operator: Actor
  administrator: Actor
  /** Every actor including the unauthenticated one, for exhaustive sweeps. */
  actors: Actor[]
  /**
   * One request as a given actor. Mutations carry the actor's CSRF token and a
   * matching Origin by default, so a test that wants to attack those has to say
   * so explicitly rather than passing by accident.
   */
  as: (actor: Actor, options: InjectOptions) => ReturnType<FastifyInstance['inject']>
  /** A second session for the same account, for tests that end the one they use. */
  disposableSession: (actor: Actor) => Promise<Actor>
  close: () => Promise<void>
}

/**
 * The composed application against real PostgreSQL, with one account per role.
 *
 * Security tests run against `buildApp` rather than a hand-assembled subset for
 * the same reason the error-handler defect only appeared there: guards, hooks,
 * plugin order, and the encapsulation the Grafana gateway introduces are part of
 * what is being tested.
 */
export async function createHarness(): Promise<Harness> {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

  const config = loadConfig({
    PRICKLESCOPE_NODE_ENV: 'test',
    PRICKLESCOPE_DATABASE_URL: databaseUrl,
    PRICKLESCOPE_APP_ORIGIN: 'http://localhost:5173',
    PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME: 'secadmin',
    PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    PRICKLESCOPE_BOOTSTRAP_ADMIN_DISPLAY_NAME: 'Security Administrator',
    PRICKLESCOPE_SESSION_TTL_SECONDS: '3600',
    // The job runner would reconcile against engines these tests do not stand up.
    PRICKLESCOPE_RUN_JOBS: 'false',
  })

  const collectorDirectory = await mkdtemp(join(tmpdir(), 'pricklescope-security-'))
  config.collectors.telegrafConfigDirectory = collectorDirectory

  const metadata = createMetadataDatabase(config.databaseUrl)
  await migrateToLatest(metadata.db)
  await sql`
    truncate table managed_grafana_resources, grafana_settings, collector_revisions,
    inventory_snapshots, source_checks, sources, sites, snmp_credentials, contact_points,
    alert_rules, oidc_provider_settings, audit_events, desired_state, jobs, oidc_login_flows,
    sessions, oidc_identities, local_credentials, users restart identity cascade
  `.execute(metadata.db)
  await metadata.db.deleteFrom('polling_profiles').where('system_defined', '=', false).execute()

  await bootstrapAdministrator(new AuthStore(metadata.db), config)
  const app = await buildApp({ config, metadata, logger: false })
  await app.ready()

  const authStore = new AuthStore(metadata.db)

  /**
   * Sessions are minted through the store rather than the login route on purpose.
   * Login is throttled to five attempts a minute per address — correctly — and a
   * suite that signs in for every fixture would exhaust that and start measuring
   * the throttle instead of the thing under test. The throttle gets its own test,
   * which is where it belongs.
   */
  const sessionFor = async (userId: string, role: Role): Promise<Actor> => {
    const session = await authStore.createSession(userId, config.session.ttlSeconds)
    return {
      role,
      cookie: `${config.session.cookieName}=${session.token}`,
      csrf: session.csrfToken,
      userId,
    }
  }

  const createUser = async (username: string, role: Role): Promise<string> => {
    const id = randomUUID()
    await metadata.db
      .insertInto('users')
      .values({
        id,
        username,
        username_normalized: username,
        display_name: `Security ${role}`,
        email: null,
        role,
        last_login_at: null,
      })
      .execute()
    await metadata.db
      .insertInto('local_credentials')
      .values({ user_id: id, password_hash: await hashPassword(ROLE_PASSWORD) })
      .execute()
    return id
  }

  const administratorRow = await metadata.db
    .selectFrom('users')
    .select('id')
    .where('username_normalized', '=', 'secadmin')
    .executeTakeFirstOrThrow()

  const administrator = await sessionFor(administratorRow.id, 'administrator')
  const operator = await sessionFor(await createUser('secoperator', 'operator'), 'operator')
  const viewer = await sessionFor(await createUser('secviewer', 'viewer'), 'viewer')
  const anonymous: Actor = { role: 'anonymous', cookie: '', csrf: '', userId: '' }

  const disposableSession = async (actor: Actor): Promise<Actor> => {
    if (actor.role === 'anonymous') return actor
    return sessionFor(actor.userId, actor.role)
  }

  const as: Harness['as'] = (actor, options) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      (options.method ?? 'GET').toString().toUpperCase(),
    )
    const headers: Record<string, string> = {}
    if (actor.cookie) headers.cookie = actor.cookie
    if (mutating) {
      headers.origin = config.appOrigin
      if (actor.csrf) headers['x-csrf-token'] = actor.csrf
    }
    return app.inject({ ...options, headers: { ...headers, ...(options.headers ?? {}) } })
  }

  return {
    app,
    metadata,
    appOrigin: config.appOrigin,
    credentials: { username: 'secadmin', password: ADMIN_PASSWORD },
    anonymous,
    viewer,
    operator,
    administrator,
    actors: [anonymous, viewer, operator, administrator],
    as,
    disposableSession,
    close: async () => {
      await app.close()
      await metadata.destroy()
      await rm(collectorDirectory, { recursive: true, force: true })
    },
  }
}
