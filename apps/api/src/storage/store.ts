import type { StoragePolicy } from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { Kysely, Selectable } from 'kysely'

export type StoredStorageSettings = Selectable<Database['storage_settings']>

export class StorageStore {
  constructor(private readonly db: Kysely<Database>) {}

  get(): Promise<StoredStorageSettings> {
    return this.db
      .selectFrom('storage_settings')
      .selectAll()
      .where('settings_key', '=', 'primary')
      .executeTakeFirstOrThrow()
  }

  async update(policy: StoragePolicy, updatedBy: string): Promise<StoredStorageSettings> {
    return this.db
      .updateTable('storage_settings')
      .set({
        raw_retention_days: policy.rawRetentionDays,
        five_minute_retention_days: policy.fiveMinuteRetentionDays,
        hourly_retention_days: policy.hourlyRetentionDays,
        status: 'pending',
        error: null,
        revision: (expression) => expression('revision', '+', 1),
        updated_by: updatedBy,
        updated_at: new Date(),
      })
      .where('settings_key', '=', 'primary')
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async markApplied(): Promise<void> {
    await this.db
      .updateTable('storage_settings')
      .set({ status: 'active', error: null, applied_at: new Date() })
      .where('settings_key', '=', 'primary')
      .execute()
  }

  async markFailed(error: string): Promise<void> {
    await this.db
      .updateTable('storage_settings')
      .set({ status: 'failed', error: error.slice(0, 2_000) })
      .where('settings_key', '=', 'primary')
      .execute()
  }
}
