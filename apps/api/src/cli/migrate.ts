import { createMetadataDatabase, migrateToLatest } from '@pricklescope/db'

import { loadConfig, loadEnvironmentFile } from '../config.js'

loadEnvironmentFile()
const config = loadConfig()
const metadata = createMetadataDatabase(config.databaseUrl)

try {
  await migrateToLatest(metadata.db)
  process.stdout.write('PrickleScope metadata migrations are current.\n')
} finally {
  await metadata.destroy()
}
