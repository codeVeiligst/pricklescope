import type { CollectorRevision } from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { Kysely, Selectable } from 'kysely'

import type { EncryptedCollectorConfig } from './config-crypto.js'

type RevisionRow = Selectable<Database['collector_revisions']>

export interface CollectorAssignmentRow {
  checkId: string
  sourceId: string
  sourceName: string
  target: string
  port: number
  transport: 'udp4' | 'udp6'
  siteId: string | null
  tags: string[]
  intervalSeconds: number
  timeoutMs: number
  retries: number
  collectSystem: boolean
  collectInterfaces: boolean
  credential: Selectable<Database['snmp_credentials']>
}

export interface StoredCollectorRevision extends RevisionRow {
  created_by_username: string | null
}

function timestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null
}

export function toCollectorRevision(row: StoredCollectorRevision): CollectorRevision {
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    collector: row.collector,
    status: row.status,
    reason: row.reason,
    sourceRevisionId: row.source_revision_id,
    contentHash: row.content_hash.trim(),
    effectiveConfig: row.rendered_config,
    sourceCount: row.source_count,
    checkCount: row.check_count,
    error: row.error,
    createdBy: row.created_by_username,
    createdAt: row.created_at.toISOString(),
    activatedAt: timestamp(row.activated_at),
  }
}

export class CollectorStore {
  constructor(private readonly db: Kysely<Database>) {}

  async desiredTelegrafAssignments(): Promise<CollectorAssignmentRow[]> {
    const rows = await this.db
      .selectFrom('source_checks')
      .innerJoin('sources', 'sources.id', 'source_checks.source_id')
      .innerJoin('polling_profiles', 'polling_profiles.id', 'source_checks.profile_id')
      .innerJoin('snmp_credentials', 'snmp_credentials.id', 'source_checks.credential_id')
      .select([
        'source_checks.id as check_id',
        'sources.id as source_id',
        'sources.name as source_name',
        'sources.target',
        'sources.port',
        'sources.transport',
        'sources.site_id',
        'sources.tags',
        'polling_profiles.interval_seconds',
        'polling_profiles.timeout_ms',
        'polling_profiles.retries',
        'polling_profiles.collect_system',
        'polling_profiles.collect_interfaces',
        'snmp_credentials.id as credential_id',
        'snmp_credentials.name as credential_name',
        'snmp_credentials.version as credential_version',
        'snmp_credentials.username as credential_username',
        'snmp_credentials.security_level',
        'snmp_credentials.auth_protocol',
        'snmp_credentials.privacy_protocol',
        'snmp_credentials.secret_key_version',
        'snmp_credentials.secret_nonce',
        'snmp_credentials.secret_ciphertext',
        'snmp_credentials.secret_auth_tag',
        'snmp_credentials.created_at as credential_created_at',
        'snmp_credentials.updated_at as credential_updated_at',
      ])
      .where('sources.enabled', '=', true)
      .where('source_checks.enabled', '=', true)
      .where('source_checks.collector_resolved', '=', 'telegraf')
      .orderBy('source_checks.id')
      .execute()

    return rows.map((row) => ({
      checkId: row.check_id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      target: row.target,
      port: row.port,
      transport: row.transport,
      siteId: row.site_id,
      tags: row.tags,
      intervalSeconds: row.interval_seconds,
      timeoutMs: row.timeout_ms,
      retries: row.retries,
      collectSystem: row.collect_system,
      collectInterfaces: row.collect_interfaces,
      credential: {
        id: row.credential_id,
        name: row.credential_name,
        version: row.credential_version,
        username: row.credential_username,
        security_level: row.security_level,
        auth_protocol: row.auth_protocol,
        privacy_protocol: row.privacy_protocol,
        secret_key_version: row.secret_key_version,
        secret_nonce: row.secret_nonce,
        secret_ciphertext: row.secret_ciphertext,
        secret_auth_tag: row.secret_auth_tag,
        created_at: row.credential_created_at,
        updated_at: row.credential_updated_at,
      },
    }))
  }

  private revisionQuery() {
    return this.db
      .selectFrom('collector_revisions')
      .leftJoin('users', 'users.id', 'collector_revisions.created_by')
      .selectAll('collector_revisions')
      .select('users.username as created_by_username')
  }

  async listRevisions(limit = 30): Promise<CollectorRevision[]> {
    const rows = await this.revisionQuery()
      .where('collector', '=', 'telegraf')
      .orderBy('revision_number', 'desc')
      .limit(limit)
      .execute()
    return rows.map(toCollectorRevision)
  }

  async activeRevision(): Promise<StoredCollectorRevision | null> {
    return (
      (await this.revisionQuery()
        .where('collector', '=', 'telegraf')
        .where('status', '=', 'active')
        .executeTakeFirst()) ?? null
    )
  }

  async storedRevision(id: string): Promise<StoredCollectorRevision | null> {
    return (
      (await this.revisionQuery()
        .where('collector_revisions.id', '=', id)
        .where('collector', '=', 'telegraf')
        .executeTakeFirst()) ?? null
    )
  }

  async createPendingRevision(input: {
    id: string
    reason: 'reconcile' | 'rollback'
    sourceRevisionId: string | null
    contentHash: string
    renderedConfig: string
    encrypted: EncryptedCollectorConfig
    sourceCount: number
    checkCount: number
    createdBy: string | null
  }): Promise<void> {
    await this.db
      .insertInto('collector_revisions')
      .values({
        id: input.id,
        collector: 'telegraf',
        status: 'failed',
        reason: input.reason,
        source_revision_id: input.sourceRevisionId,
        content_hash: input.contentHash,
        rendered_config: input.renderedConfig,
        config_key_version: input.encrypted.keyVersion,
        config_nonce: input.encrypted.nonce,
        config_ciphertext: input.encrypted.ciphertext,
        config_auth_tag: input.encrypted.authTag,
        source_count: input.sourceCount,
        check_count: input.checkCount,
        error: 'Activation is pending',
        created_by: input.createdBy,
        activated_at: null,
      })
      .execute()
  }

  async activate(id: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('collector_revisions')
        .set({ status: 'superseded' })
        .where('collector', '=', 'telegraf')
        .where('status', '=', 'active')
        .execute()
      const result = await transaction
        .updateTable('collector_revisions')
        .set({ status: 'active', error: null, activated_at: new Date() })
        .where('id', '=', id)
        .where('status', '=', 'failed')
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) throw new Error('Candidate revision disappeared')
    })
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .updateTable('collector_revisions')
      .set({ status: 'failed', error: error.slice(0, 2000), activated_at: null })
      .where('id', '=', id)
      .execute()
  }
}
