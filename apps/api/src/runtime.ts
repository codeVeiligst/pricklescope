import { createMetadataDatabase, migrateToLatest, type MetadataDatabase } from '@pricklescope/db'

import { bootstrapAdministrator } from './auth/bootstrap.js'
import { AuthStore } from './auth/store.js'
import { loadConfig, loadEnvironmentFile, type AppConfig } from './config.js'

export interface Runtime {
  config: AppConfig
  metadata: MetadataDatabase
}

export async function createRuntime(): Promise<Runtime> {
  loadEnvironmentFile()
  const config = loadConfig()
  const metadata = createMetadataDatabase(config.databaseUrl)
  if (config.autoMigrate) await migrateToLatest(metadata.db)
  const created = await bootstrapAdministrator(new AuthStore(metadata.db), config)
  if (created) {
    process.stdout.write(`Created bootstrap administrator ${created.username}.\n`)
  }
  return { config, metadata }
}
