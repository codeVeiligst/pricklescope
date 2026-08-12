import type { GrafanaManagedResource } from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { GrafanaResourceDefinition } from '@pricklescope/adapters'
import type { Kysely, Selectable } from 'kysely'

import type { EncryptedGrafanaToken } from './token-crypto.js'

export type StoredGrafanaSettings = Selectable<Database['grafana_settings']>

export class GrafanaStore {
  constructor(private readonly db: Kysely<Database>) {}

  get(): Promise<StoredGrafanaSettings> {
    return this.db
      .selectFrom('grafana_settings')
      .selectAll()
      .where('settings_key', '=', 'primary')
      .executeTakeFirstOrThrow()
  }

  async markPending(updatedBy: string | null): Promise<void> {
    await this.db
      .updateTable('grafana_settings')
      .set({
        status: 'pending',
        error: null,
        revision: (expression) => expression('revision', '+', 1),
        updated_by: updatedBy,
        updated_at: new Date(),
      })
      .where('settings_key', '=', 'primary')
      .execute()
  }

  async saveServiceToken(
    serviceAccountId: number,
    tokenId: number,
    encrypted: EncryptedGrafanaToken,
  ): Promise<void> {
    await this.db
      .updateTable('grafana_settings')
      .set({
        service_account_id: serviceAccountId,
        service_account_token_id: tokenId,
        token_key_version: encrypted.keyVersion,
        token_nonce: encrypted.nonce,
        token_ciphertext: encrypted.ciphertext,
        token_auth_tag: encrypted.authTag,
      })
      .where('settings_key', '=', 'primary')
      .execute()
  }

  async markApplied(grafanaVersion: string, pluginVersion: string): Promise<void> {
    await this.db
      .updateTable('grafana_settings')
      .set({
        status: 'active',
        error: null,
        grafana_version: grafanaVersion,
        plugin_version: pluginVersion,
        applied_at: new Date(),
      })
      .where('settings_key', '=', 'primary')
      .execute()
  }

  async markFailed(error: string): Promise<void> {
    await this.db
      .updateTable('grafana_settings')
      .set({ status: 'failed', error: error.slice(0, 2_000) })
      .where('settings_key', '=', 'primary')
      .execute()
  }

  async saveResource(definition: GrafanaResourceDefinition): Promise<void> {
    const current = await this.db
      .selectFrom('managed_grafana_resources')
      .select(['uid', 'content_hash', 'revision'])
      .where('uid', '=', definition.uid)
      .executeTakeFirst()
    if (!current) {
      await this.db
        .insertInto('managed_grafana_resources')
        .values({
          uid: definition.uid,
          resource_type: definition.type,
          title: definition.title,
          folder_uid: definition.folderUid,
          content_hash: definition.contentHash,
          remote_uid: definition.remoteUid ?? null,
          revision: 1,
          status: 'active',
          error: null,
          reconciled_at: new Date(),
        })
        .execute()
      return
    }
    await this.db
      .updateTable('managed_grafana_resources')
      .set({
        resource_type: definition.type,
        title: definition.title,
        folder_uid: definition.folderUid,
        content_hash: definition.contentHash,
        // Keep a uid already recorded when a caller does not supply one.
        ...(definition.remoteUid ? { remote_uid: definition.remoteUid } : {}),
        revision: current.revision + (current.content_hash === definition.contentHash ? 0 : 1),
        status: 'active',
        error: null,
        reconciled_at: new Date(),
      })
      .where('uid', '=', definition.uid)
      .execute()
  }

  /**
   * Forgets a managed resource. The registry is what "already applied" is judged
   * against, so a row left behind for a deleted rule reads as permanent drift.
   */
  async deleteResource(uid: string): Promise<void> {
    await this.db.deleteFrom('managed_grafana_resources').where('uid', '=', uid).execute()
  }

  /** The uid Grafana holds a managed resource under, or null if never recorded. */
  async remoteUid(uid: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('managed_grafana_resources')
      .select('remote_uid')
      .where('uid', '=', uid)
      .executeTakeFirst()
    return row?.remote_uid ?? null
  }

  /** uid -> stored content hash, so a caller can tell drift from a rewrite. */
  async resourceHashes(): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('managed_grafana_resources')
      .select(['uid', 'content_hash', 'status'])
      .execute()
    return new Map(
      rows
        .filter((row) => row.status === 'active')
        .map((row) => [row.uid, row.content_hash.trim()]),
    )
  }

  async resources(): Promise<GrafanaManagedResource[]> {
    const rows = await this.db
      .selectFrom('managed_grafana_resources')
      .selectAll()
      .orderBy('resource_type')
      .orderBy('title')
      .execute()
    return rows.map((row) => ({
      uid: row.uid,
      type: row.resource_type,
      title: row.title,
      status: row.status,
      revision: row.revision,
      reconciledAt: row.reconciled_at.toISOString(),
    }))
  }
}
