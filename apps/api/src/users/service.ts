import { randomUUID } from 'node:crypto'

import type {
  AuthMethod,
  CreateLocalUserRequest,
  ManagedUser,
  UpdateManagedUserRequest,
} from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely'

import { HttpError } from '../errors.js'
import { hashPassword, normalizeUsername } from '../security.js'
import type { AuthStore } from '../auth/store.js'

type Executor = Kysely<Database> | Transaction<Database>
type UserRow = Selectable<Database['users']>

function timestamp(value: Date): string {
  return value.toISOString()
}

function nullableTimestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

export class UserManagementService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuthStore,
  ) {}

  async list(): Promise<ManagedUser[]> {
    const rows = await this.db.selectFrom('users').selectAll().orderBy('username').execute()
    return this.enrich(rows, this.db)
  }

  async createLocal(input: CreateLocalUserRequest, actorUserId: string): Promise<ManagedUser> {
    const id = randomUUID()
    const passwordHash = await hashPassword(input.password)
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('users')
        .values({
          id,
          username: input.username.trim(),
          username_normalized: normalizeUsername(input.username),
          display_name: input.displayName.trim(),
          email: input.email?.trim() || null,
          role: input.role,
          active: true,
          last_login_at: null,
        })
        .execute()
      await transaction
        .insertInto('local_credentials')
        .values({ user_id: id, password_hash: passwordHash })
        .execute()
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'user.created',
          resourceType: 'user',
          resourceId: id,
          outcome: 'success',
          metadata: { username: input.username.trim(), role: input.role, method: 'local' },
        },
        transaction,
      )
    })
    return (await this.get(id))!
  }

  async update(
    id: string,
    input: UpdateManagedUserRequest,
    actorUserId: string,
  ): Promise<ManagedUser | null> {
    const changed = await this.db.transaction().execute(async (transaction) => {
      const target = await transaction
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!target) return false
      const nextRole = input.role ?? target.role
      const nextActive = input.active ?? target.active
      if (id === actorUserId && (nextRole !== 'administrator' || !nextActive)) {
        throw new HttpError(
          400,
          'self_lockout',
          'Use another administrator account to change your own role or access',
        )
      }
      if (
        target.role === 'administrator' &&
        target.active &&
        (nextRole !== 'administrator' || !nextActive)
      ) {
        await this.requireAnotherAdministrator(transaction, id)
      }

      const values: Updateable<Database['users']> = { updated_at: new Date() }
      if (input.displayName !== undefined) values.display_name = input.displayName.trim()
      if (input.email !== undefined) values.email = input.email?.trim() || null
      if (input.role !== undefined) values.role = input.role
      if (input.active !== undefined) values.active = input.active
      await transaction.updateTable('users').set(values).where('id', '=', id).execute()

      const securityChanged = target.role !== nextRole || target.active !== nextActive
      if (securityChanged) {
        await transaction.deleteFrom('sessions').where('user_id', '=', id).execute()
      }
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'user.updated',
          resourceType: 'user',
          resourceId: id,
          outcome: 'success',
          metadata: {
            fields: Object.keys(input),
            sessionsRevoked: securityChanged,
          },
        },
        transaction,
      )
      return true
    })
    return changed ? this.get(id) : null
  }

  async resetPassword(
    id: string,
    password: string,
    actorUserId: string,
  ): Promise<ManagedUser | null> {
    if (id === actorUserId) {
      throw new HttpError(
        400,
        'self_password_reset',
        'Change your own password from your profile using the current password',
      )
    }
    const passwordHash = await hashPassword(password)
    const changed = await this.db.transaction().execute(async (transaction) => {
      const target = await transaction
        .selectFrom('users')
        .leftJoin('local_credentials', 'local_credentials.user_id', 'users.id')
        .select(['users.id', 'local_credentials.user_id as local_user_id'])
        .where('users.id', '=', id)
        .forUpdate('users')
        .executeTakeFirst()
      if (!target) return false
      if (!target.local_user_id) {
        throw new HttpError(
          400,
          'local_login_unavailable',
          'This user signs in through OIDC and has no local password',
        )
      }
      await transaction
        .updateTable('local_credentials')
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where('user_id', '=', id)
        .execute()
      await transaction.deleteFrom('sessions').where('user_id', '=', id).execute()
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'user.password_reset',
          resourceType: 'user',
          resourceId: id,
          outcome: 'success',
          metadata: { sessionsRevoked: true },
        },
        transaction,
      )
      return true
    })
    return changed ? this.get(id) : null
  }

  async revokeSessions(id: string, actorUserId: string): Promise<number | null> {
    if (id === actorUserId) {
      throw new HttpError(400, 'self_session_revoke', 'Use Sign out to end your current session')
    }
    return this.db.transaction().execute(async (transaction) => {
      const target = await transaction
        .selectFrom('users')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!target) return null
      const result = await transaction
        .deleteFrom('sessions')
        .where('user_id', '=', id)
        .executeTakeFirst()
      const count = Number(result.numDeletedRows)
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'user.sessions_revoked',
          resourceType: 'user',
          resourceId: id,
          outcome: 'success',
          metadata: { sessionCount: count },
        },
        transaction,
      )
      return count
    })
  }

  async delete(id: string, actorUserId: string): Promise<boolean> {
    if (id === actorUserId) {
      throw new HttpError(400, 'self_delete', 'You cannot delete your own account')
    }
    return this.db.transaction().execute(async (transaction) => {
      const target = await transaction
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!target) return false
      if (target.role === 'administrator' && target.active) {
        await this.requireAnotherAdministrator(transaction, id)
      }
      await transaction.deleteFrom('users').where('id', '=', id).execute()
      await this.audit.writeAudit(
        {
          actorUserId,
          action: 'user.deleted',
          resourceType: 'user',
          resourceId: id,
          outcome: 'success',
          metadata: { username: target.username, role: target.role },
        },
        transaction,
      )
      return true
    })
  }

  private async get(id: string): Promise<ManagedUser | null> {
    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    return (await this.enrich([row], this.db))[0] ?? null
  }

  private async enrich(rows: UserRow[], executor: Executor): Promise<ManagedUser[]> {
    if (!rows.length) return []
    const ids = rows.map((row) => row.id)
    const [localRows, oidcRows, sessionRows] = await Promise.all([
      executor
        .selectFrom('local_credentials')
        .select('user_id')
        .where('user_id', 'in', ids)
        .execute(),
      executor
        .selectFrom('oidc_identities')
        .select(['user_id', 'issuer'])
        .where('user_id', 'in', ids)
        .execute(),
      executor
        .selectFrom('sessions')
        .select('user_id')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('user_id', 'in', ids)
        .where('expires_at', '>', new Date())
        .groupBy('user_id')
        .execute(),
    ])
    const local = new Set(localRows.map((row) => row.user_id))
    const issuers = new Map<string, string[]>()
    for (const row of oidcRows) {
      const values = issuers.get(row.user_id) ?? []
      if (!values.includes(row.issuer)) values.push(row.issuer)
      issuers.set(row.user_id, values)
    }
    const sessions = new Map(sessionRows.map((row) => [row.user_id, Number(row.count)]))
    return rows.map((row) => {
      const authMethods: AuthMethod[] = []
      if (local.has(row.id)) authMethods.push('local')
      if (issuers.has(row.id)) authMethods.push('oidc')
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        role: row.role,
        active: row.active,
        authMethods,
        oidcIssuers: issuers.get(row.id) ?? [],
        sessionCount: sessions.get(row.id) ?? 0,
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
        lastLoginAt: nullableTimestamp(row.last_login_at),
      }
    })
  }

  private async requireAnotherAdministrator(
    transaction: Transaction<Database>,
    excludedId: string,
  ): Promise<void> {
    const administrators = await transaction
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'administrator')
      .where('active', '=', true)
      .forUpdate()
      .execute()
    if (!administrators.some((administrator) => administrator.id !== excludedId)) {
      throw new HttpError(
        400,
        'last_administrator',
        'At least one active administrator must remain',
      )
    }
  }
}
