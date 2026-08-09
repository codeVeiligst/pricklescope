import { randomUUID } from 'node:crypto'

import type { AuthMethod, Role, User } from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { Kysely, Transaction } from 'kysely'

import { hashToken, normalizeUsername, randomToken } from '../security.js'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>

interface UserRow {
  id: string
  username: string
  display_name: string
  email: string | null
  role: Role
  active: boolean
}

export interface LocalLoginRecord {
  user: User
  passwordHash: string
  active: boolean
}

export interface StoredSession {
  id: string
  user: User
  csrfToken: string
  expiresAt: Date
}

export interface OidcFlow {
  id: string
  state: string
  codeVerifier: string
  nonce: string
  returnTo: string
}

export interface OidcProfile {
  issuer: string
  subject: string
  username: string
  displayName: string
  email: string | null
  role: Role
  claims: Record<string, unknown>
}

async function authMethods(db: DatabaseExecutor, userId: string): Promise<AuthMethod[]> {
  const [local, oidc] = await Promise.all([
    db
      .selectFrom('local_credentials')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('oidc_identities')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
  ])
  const methods: AuthMethod[] = []
  if (local) methods.push('local')
  if (oidc) methods.push('oidc')
  return methods
}

async function toUser(db: DatabaseExecutor, row: UserRow): Promise<User> {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    authMethods: await authMethods(db, row.id),
  }
}

export class AuthStore {
  constructor(private readonly db: Kysely<Database>) {}

  async userCount(): Promise<number> {
    const result = await this.db
      .selectFrom('users')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()
    return Number(result.count)
  }

  async createBootstrapAdministrator(input: {
    username: string
    displayName: string
    passwordHash: string
  }): Promise<User | null> {
    return this.db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('users')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow()
      if (Number(existing.count) > 0) return null

      const userId = randomUUID()
      const row = await transaction
        .insertInto('users')
        .values({
          id: userId,
          username: input.username.trim(),
          username_normalized: normalizeUsername(input.username),
          display_name: input.displayName.trim(),
          email: null,
          role: 'administrator',
          last_login_at: null,
        })
        .returning(['id', 'username', 'display_name', 'email', 'role', 'active'])
        .executeTakeFirstOrThrow()
      await transaction
        .insertInto('local_credentials')
        .values({ user_id: userId, password_hash: input.passwordHash })
        .execute()
      await this.writeAudit(
        {
          actorUserId: userId,
          action: 'user.bootstrap',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'success',
          metadata: { role: 'administrator' },
        },
        transaction,
      )
      return toUser(transaction, row)
    })
  }

  async findLocalLogin(username: string): Promise<LocalLoginRecord | null> {
    const row = await this.db
      .selectFrom('users')
      .innerJoin('local_credentials', 'local_credentials.user_id', 'users.id')
      .select([
        'users.id',
        'users.username',
        'users.display_name',
        'users.email',
        'users.role',
        'users.active',
        'local_credentials.password_hash',
      ])
      .where('users.username_normalized', '=', normalizeUsername(username))
      .executeTakeFirst()
    if (!row) return null
    return {
      user: await toUser(this.db, row),
      passwordHash: row.password_hash,
      active: row.active,
    }
  }

  async getUser(userId: string): Promise<User | null> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'display_name', 'email', 'role', 'active'])
      .where('id', '=', userId)
      .where('active', '=', true)
      .executeTakeFirst()
    return row ? toUser(this.db, row) : null
  }

  async createSession(
    userId: string,
    ttlSeconds: number,
  ): Promise<StoredSession & { token: string }> {
    const token = randomToken()
    const csrfToken = randomToken()
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000)
    await this.db
      .insertInto('sessions')
      .values({
        id,
        user_id: userId,
        token_hash: hashToken(token),
        csrf_token: csrfToken,
        expires_at: expiresAt,
      })
      .execute()
    const user = await this.getUser(userId)
    if (!user) throw new Error('Cannot create a session for an inactive user')
    return { id, user, csrfToken, expiresAt, token }
  }

  async findSession(token: string): Promise<StoredSession | null> {
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id',
        'sessions.csrf_token',
        'sessions.expires_at',
        'sessions.last_seen_at',
        'users.id as user_id',
        'users.username',
        'users.display_name',
        'users.email',
        'users.role',
        'users.active',
      ])
      .where('sessions.token_hash', '=', hashToken(token))
      .where('sessions.expires_at', '>', new Date())
      .where('users.active', '=', true)
      .executeTakeFirst()
    if (!row) return null
    if (Date.now() - row.last_seen_at.getTime() > 60_000) {
      void this.db
        .updateTable('sessions')
        .set({ last_seen_at: new Date() })
        .where('id', '=', row.id)
        .execute()
    }
    return {
      id: row.id,
      user: await toUser(this.db, {
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        email: row.email,
        role: row.role,
        active: row.active,
      }),
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('id', '=', sessionId).execute()
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.db
      .updateTable('users')
      .set({ last_login_at: new Date(), updated_at: new Date() })
      .where('id', '=', userId)
      .execute()
  }

  async changePassword(userId: string, passwordHash: string, keepSessionId: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('local_credentials')
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow()
      await transaction
        .deleteFrom('sessions')
        .where('user_id', '=', userId)
        .where('id', '!=', keepSessionId)
        .execute()
      await this.writeAudit(
        {
          actorUserId: userId,
          action: 'credential.password_changed',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'success',
          metadata: {},
        },
        transaction,
      )
    })
  }

  async createOidcFlow(input: {
    flowToken: string
    state: string
    codeVerifier: string
    nonce: string
    returnTo: string
  }): Promise<void> {
    await this.db
      .insertInto('oidc_login_flows')
      .values({
        id: randomUUID(),
        flow_token_hash: hashToken(input.flowToken),
        state: input.state,
        code_verifier: input.codeVerifier,
        nonce: input.nonce,
        return_to: input.returnTo,
        expires_at: new Date(Date.now() + 10 * 60_000),
      })
      .execute()
  }

  async consumeOidcFlow(flowToken: string): Promise<OidcFlow | null> {
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('oidc_login_flows')
        .selectAll()
        .where('flow_token_hash', '=', hashToken(flowToken))
        .where('expires_at', '>', new Date())
        .forUpdate()
        .executeTakeFirst()
      if (!row) return null
      await transaction.deleteFrom('oidc_login_flows').where('id', '=', row.id).execute()
      return {
        id: row.id,
        state: row.state,
        codeVerifier: row.code_verifier,
        nonce: row.nonce,
        returnTo: row.return_to,
      }
    })
  }

  async findOrCreateOidcUser(profile: OidcProfile, allowCreate: boolean): Promise<User | null> {
    return this.db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('oidc_identities')
        .innerJoin('users', 'users.id', 'oidc_identities.user_id')
        .select([
          'users.id',
          'users.username',
          'users.display_name',
          'users.email',
          'users.role',
          'users.active',
          'oidc_identities.id as identity_id',
        ])
        .where('oidc_identities.issuer', '=', profile.issuer)
        .where('oidc_identities.subject', '=', profile.subject)
        .executeTakeFirst()

      if (existing) {
        if (!existing.active) return null
        await transaction
          .updateTable('oidc_identities')
          .set({ email: profile.email, claims: profile.claims, updated_at: new Date() })
          .where('id', '=', existing.identity_id)
          .execute()
        await transaction
          .updateTable('users')
          .set({
            display_name: profile.displayName,
            email: profile.email,
            last_login_at: new Date(),
            updated_at: new Date(),
          })
          .where('id', '=', existing.id)
          .execute()
        return toUser(transaction, existing)
      }

      if (!allowCreate) return null
      const username = await this.availableUsername(transaction, profile.username)
      const userId = randomUUID()
      const row = await transaction
        .insertInto('users')
        .values({
          id: userId,
          username,
          username_normalized: normalizeUsername(username),
          display_name: profile.displayName,
          email: profile.email,
          role: profile.role,
          last_login_at: new Date(),
        })
        .returning(['id', 'username', 'display_name', 'email', 'role', 'active'])
        .executeTakeFirstOrThrow()
      await transaction
        .insertInto('oidc_identities')
        .values({
          id: randomUUID(),
          user_id: userId,
          issuer: profile.issuer,
          subject: profile.subject,
          email: profile.email,
          claims: profile.claims,
        })
        .execute()
      await this.writeAudit(
        {
          actorUserId: userId,
          action: 'user.oidc_provisioned',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'success',
          metadata: { issuer: profile.issuer, role: profile.role },
        },
        transaction,
      )
      return toUser(transaction, row)
    })
  }

  private async availableUsername(db: DatabaseExecutor, requested: string): Promise<string> {
    const base =
      normalizeUsername(requested)
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96) || `oidc-user-${randomUUID().slice(0, 8)}`
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`
      const exists = await db
        .selectFrom('users')
        .select('id')
        .where('username_normalized', '=', candidate)
        .executeTakeFirst()
      if (!exists) return candidate
    }
    throw new Error('Could not allocate a unique OIDC username')
  }

  async writeAudit(
    input: {
      actorUserId: string | null
      action: string
      resourceType: string
      resourceId: string | null
      outcome: 'success' | 'failure'
      metadata: Record<string, unknown>
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .insertInto('audit_events')
      .values({
        actor_user_id: input.actorUserId,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        outcome: input.outcome,
        metadata: input.metadata,
      })
      .execute()
  }

  async deleteExpiredArtifacts(): Promise<void> {
    const now = new Date()
    await Promise.all([
      this.db.deleteFrom('sessions').where('expires_at', '<=', now).execute(),
      this.db.deleteFrom('oidc_login_flows').where('expires_at', '<=', now).execute(),
    ])
  }
}
