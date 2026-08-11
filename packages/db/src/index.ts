import { Kysely, PostgresDialect } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import { Pool } from 'pg'

import * as foundationMigration from './migrations/001_foundation.js'
import * as inventoryMigration from './migrations/002_inventory.js'
import * as oidcSettingsMigration from './migrations/003_oidc_settings.js'
import * as collectorRevisionsMigration from './migrations/004_collector_revisions.js'
import * as storageSettingsMigration from './migrations/005_storage_settings.js'
import * as siteHierarchyMigration from './migrations/006_site_hierarchy.js'
import * as grafanaIntegrationMigration from './migrations/007_grafana_integration.js'
import * as alertingMigration from './migrations/008_alerting.js'
import * as emailDeliveryMigration from './migrations/009_email_delivery.js'
import * as healthAlertsMigration from './migrations/010_health_alerts.js'
import type { Database } from './types.js'

export type { Database } from './types.js'

const migrations: Record<string, Migration> = {
  '001_foundation': foundationMigration,
  '002_inventory': inventoryMigration,
  '003_oidc_settings': oidcSettingsMigration,
  '004_collector_revisions': collectorRevisionsMigration,
  '005_storage_settings': storageSettingsMigration,
  '006_site_hierarchy': siteHierarchyMigration,
  '007_grafana_integration': grafanaIntegrationMigration,
  '008_alerting': alertingMigration,
  '009_email_delivery': emailDeliveryMigration,
  '010_health_alerts': healthAlertsMigration,
}

class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  }
}

export interface MetadataDatabase {
  db: Kysely<Database>
  pool: Pool
  destroy: () => Promise<void>
}

export function createMetadataDatabase(databaseUrl: string): MetadataDatabase {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'pricklescope-api',
  })
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

  return {
    db,
    pool,
    destroy: async () => {
      await db.destroy()
    },
  }
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  })
  const result = await migrator.migrateToLatest()

  for (const migration of result.results ?? []) {
    if (migration.status === 'Error') {
      throw new Error(`Migration ${migration.migrationName} failed`)
    }
  }

  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error('Database migration failed', { cause: result.error })
  }
}
