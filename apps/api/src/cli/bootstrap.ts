import { createMetadataDatabase } from '@pricklescope/db'

import { bootstrapAdministrator } from '../auth/bootstrap.js'
import { AuthStore } from '../auth/store.js'
import { loadConfig, loadEnvironmentFile } from '../config.js'

loadEnvironmentFile()
const config = loadConfig()
const metadata = createMetadataDatabase(config.databaseUrl)

try {
  const user = await bootstrapAdministrator(new AuthStore(metadata.db), config)
  process.stdout.write(
    user
      ? `Created bootstrap administrator ${user.username}.\n`
      : 'Bootstrap skipped because users already exist or credentials were not configured.\n',
  )
} finally {
  await metadata.destroy()
}
