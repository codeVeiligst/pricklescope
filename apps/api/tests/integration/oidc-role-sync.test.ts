import { randomUUID } from 'node:crypto'

import { createMetadataDatabase, migrateToLatest, type MetadataDatabase } from '@pricklescope/db'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AuthStore } from '../../src/auth/store.js'
import { loadEnvironmentFile } from '../../src/config.js'

/**
 * The provider's groups govern the role on every login, not only when the user
 * is created (audit finding F2, 2026-08-11). Before this, a user removed from
 * the administrator group in the identity provider stayed an administrator here
 * for as long as the account existed.
 */
loadEnvironmentFile()
const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must target a database whose name ends in _test')
  }
}
const integration = databaseUrl ? describe : describe.skip

integration('OIDC role synchronisation', () => {
  let metadata: MetadataDatabase
  let store: AuthStore

  const profile = (role: 'administrator' | 'operator' | 'viewer', roleFromProvider = true) => ({
    issuer: 'https://idp.example.invalid',
    subject: 'subject-under-test',
    username: 'oidc-user',
    displayName: 'OIDC User',
    email: 'oidc-user@example.invalid',
    role,
    roleFromProvider,
    claims: {},
  })

  beforeAll(async () => {
    metadata = createMetadataDatabase(databaseUrl!)
    await migrateToLatest(metadata.db)
    await sql`truncate table audit_events, sessions, oidc_identities, local_credentials, users restart identity cascade`.execute(
      metadata.db,
    )
    store = new AuthStore(metadata.db)
    // A second administrator, so the last-administrator guard is not what is
    // being measured in the promotion and demotion cases.
    await metadata.db
      .insertInto('users')
      .values({
        id: randomUUID(),
        username: 'standing-admin',
        username_normalized: 'standing-admin',
        display_name: 'Standing Administrator',
        role: 'administrator',
      })
      .execute()
  })

  afterAll(async () => {
    await metadata.destroy()
  })

  it('creates the user with the role its groups map to', async () => {
    const user = await store.findOrCreateOidcUser(profile('administrator'), true)
    expect(user?.role).toBe('administrator')
  })

  it('demotes a user the provider has removed from the administrator group', async () => {
    const user = await store.findOrCreateOidcUser(profile('viewer'), true)
    expect(user?.role).toBe('viewer')

    const stored = await metadata.db
      .selectFrom('users')
      .select('role')
      .where('username', '=', 'oidc-user')
      .executeTakeFirstOrThrow()
    expect(stored.role).toBe('viewer')
  })

  it('promotes a user the provider has added to a group', async () => {
    const user = await store.findOrCreateOidcUser(profile('operator'), true)
    expect(user?.role).toBe('operator')
  })

  it('audits the change so a silent demotion is traceable', async () => {
    const events = await metadata.db
      .selectFrom('audit_events')
      .select(['action', 'metadata'])
      .where('action', '=', 'auth.oidc.role_synchronised')
      .execute()
    expect(events.length).toBeGreaterThan(0)
  })

  /**
   * With no group mapped, the mapping always answers `viewer`. Synchronising on
   * that would demote every OIDC user on an installation that maps no groups and
   * assigns roles by hand — a supported way to run this.
   */
  it('leaves the role alone when no group is mapped', async () => {
    const before = await store.findOrCreateOidcUser(profile('operator'), true)
    expect(before?.role).toBe('operator')

    const after = await store.findOrCreateOidcUser(profile('viewer', false), true)
    expect(after?.role).toBe('operator')
  })

  /**
   * A provider misconfiguration must not lock every administrator out at once,
   * leaving no account able to repair it.
   */
  it('refuses to demote the last active administrator', async () => {
    await metadata.db
      .updateTable('users')
      .set({ role: 'viewer' })
      .where('username', '=', 'standing-admin')
      .execute()
    await store.findOrCreateOidcUser(profile('administrator'), true)

    const demoted = await store.findOrCreateOidcUser(profile('viewer'), true)
    expect(demoted?.role, 'the only administrator was demoted by the provider').toBe(
      'administrator',
    )

    const refusals = await metadata.db
      .selectFrom('audit_events')
      .select('action')
      .where('action', '=', 'auth.oidc.role_synchronisation_refused')
      .execute()
    expect(refusals.length).toBeGreaterThan(0)
  })
})
