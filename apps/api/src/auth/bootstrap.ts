import type { User } from '@pricklescope/contracts'

import type { AppConfig } from '../config.js'
import { hashPassword } from '../security.js'
import type { AuthStore } from './store.js'

export async function bootstrapAdministrator(
  store: AuthStore,
  config: AppConfig,
): Promise<User | null> {
  const { username, password, displayName } = config.bootstrapAdmin
  if (!username || !password) return null
  if (password.length < 12) {
    throw new Error('Bootstrap administrator password must contain at least 12 characters')
  }
  return store.createBootstrapAdministrator({
    username,
    displayName,
    passwordHash: await hashPassword(password),
  })
}
