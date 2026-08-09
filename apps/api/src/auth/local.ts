import type { AppConfig } from '../config.js'
import { HttpError } from '../errors.js'
import { hashPassword, randomToken, verifyPassword } from '../security.js'
import type { AuthStore, StoredSession } from './store.js'

export class LocalAuthService {
  private constructor(
    private readonly store: AuthStore,
    private readonly config: AppConfig,
    private readonly dummyPasswordHash: string,
  ) {}

  static async create(store: AuthStore, config: AppConfig): Promise<LocalAuthService> {
    const dummyPasswordHash = await hashPassword(randomToken())
    return new LocalAuthService(store, config, dummyPasswordHash)
  }

  async login(username: string, password: string): Promise<StoredSession & { token: string }> {
    const record = await this.store.findLocalLogin(username)
    const passwordHash = record?.passwordHash ?? this.dummyPasswordHash
    const passwordMatches = await verifyPassword(passwordHash, password)

    if (!record || !record.active || !passwordMatches) {
      await this.store.writeAudit({
        actorUserId: record?.user.id ?? null,
        action: 'auth.local_login',
        resourceType: 'session',
        resourceId: null,
        outcome: 'failure',
        metadata: { username: username.trim().slice(0, 128) },
      })
      throw new HttpError(401, 'invalid_credentials', 'The username or password is incorrect')
    }

    await this.store.updateLastLogin(record.user.id)
    const session = await this.store.createSession(record.user.id, this.config.session.ttlSeconds)
    await this.store.writeAudit({
      actorUserId: record.user.id,
      action: 'auth.local_login',
      resourceType: 'session',
      resourceId: session.id,
      outcome: 'success',
      metadata: {},
    })
    return session
  }

  async changePassword(input: {
    userId: string
    username: string
    sessionId: string
    currentPassword: string
    newPassword: string
  }): Promise<void> {
    if (input.newPassword.length < 12) {
      throw new HttpError(
        400,
        'weak_password',
        'The new password must contain at least 12 characters',
      )
    }
    const record = await this.store.findLocalLogin(input.username)
    if (!record || !(await verifyPassword(record.passwordHash, input.currentPassword))) {
      throw new HttpError(400, 'invalid_current_password', 'The current password is incorrect')
    }
    if (await verifyPassword(record.passwordHash, input.newPassword)) {
      throw new HttpError(400, 'password_unchanged', 'The new password must be different')
    }
    await this.store.changePassword(
      input.userId,
      await hashPassword(input.newPassword),
      input.sessionId,
    )
  }
}
