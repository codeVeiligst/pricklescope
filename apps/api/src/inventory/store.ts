import { randomUUID } from 'node:crypto'

import type {
  CollectorKind,
  CollectorSelection,
  CreatePollingProfileRequest,
  CreateSiteRequest,
  CreateSourceRequest,
  InventoryDiff,
  InventoryInterface,
  InventorySnapshot,
  InventorySystem,
  PollingProfile,
  Site,
  SnmpCredential,
  Source,
  UpdatePollingProfileRequest,
  UpdateSiteRequest,
  UpdateSourceRequest,
} from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from 'kysely'

import type { EncryptedCredentialSecret } from './credential-crypto.js'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>
type CredentialRow = Selectable<Database['snmp_credentials']>
type ProfileRow = Selectable<Database['polling_profiles']>
type SnapshotRow = Selectable<Database['inventory_snapshots']>
type SourceRow = Selectable<Database['sources']>

interface SourceJoined extends SourceRow {
  site_name: string | null
  credential_id: string
  credential_name: string
  credential_version: '2c' | '3'
  profile_id: string
  profile_name: string
  profile_interval_seconds: number
  collector_selection: CollectorSelection
  collector_resolved: CollectorKind
}

export type StoredCredential = CredentialRow

export interface ProbeConfiguration {
  sourceId: string
  target: string
  port: number
  transport: 'udp4' | 'udp6'
  credential: CredentialRow
  profile: {
    timeoutMs: number
    retries: number
    collectInterfaces: boolean
  }
}

function date(value: Date): string {
  return value.toISOString()
}

function nullableDate(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function toSites(rows: Selectable<Database['sites']>[], sourceCounts: Map<string, number>): Site[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const childCounts = new Map<string, number>()
  const totalSourceCounts = new Map(sourceCounts)

  for (const row of rows) {
    if (row.parent_id) childCounts.set(row.parent_id, (childCounts.get(row.parent_id) ?? 0) + 1)
    let ancestor = row.parent_id ? byId.get(row.parent_id) : undefined
    const directCount = sourceCounts.get(row.id) ?? 0
    const visited = new Set<string>([row.id])
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id)
      totalSourceCounts.set(ancestor.id, (totalSourceCounts.get(ancestor.id) ?? 0) + directCount)
      ancestor = ancestor.parent_id ? byId.get(ancestor.parent_id) : undefined
    }
  }

  const sites = rows.map((row): Site => {
    const path: Site['path'] = []
    let current: Selectable<Database['sites']> | undefined = row
    const visited = new Set<string>()
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      path.unshift({ id: current.id, name: current.name })
      current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    return {
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      description: row.description,
      path,
      depth: path.length - 1,
      childCount: childCounts.get(row.id) ?? 0,
      sourceCount: sourceCounts.get(row.id) ?? 0,
      totalSourceCount: totalSourceCounts.get(row.id) ?? 0,
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    }
  })
  return sites.sort((left, right) =>
    left.path
      .map((item) => item.name)
      .join('\u0000')
      .localeCompare(right.path.map((item) => item.name).join('\u0000'), undefined, {
        sensitivity: 'base',
      }),
  )
}

function toCredential(row: CredentialRow, sourceCount: number): SnmpCredential {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    username: row.username,
    securityLevel: row.security_level,
    authProtocol: row.auth_protocol,
    privacyProtocol: row.privacy_protocol,
    secretConfigured: row.secret_ciphertext.length > 0,
    sourceCount,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

function toProfile(row: ProfileRow, sourceCount: number): PollingProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    retries: row.retries,
    collectSystem: row.collect_system,
    collectInterfaces: row.collect_interfaces,
    systemDefined: row.system_defined,
    sourceCount,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

function toSource(row: SourceJoined): Source {
  return {
    id: row.id,
    name: row.name,
    target: row.target,
    port: row.port,
    transport: row.transport,
    enabled: row.enabled,
    status: row.status,
    tags: row.tags,
    site: row.site_id && row.site_name ? { id: row.site_id, name: row.site_name } : null,
    credential: {
      id: row.credential_id,
      name: row.credential_name,
      version: row.credential_version,
    },
    profile: {
      id: row.profile_id,
      name: row.profile_name,
      intervalSeconds: row.profile_interval_seconds,
    },
    collectorSelection: row.collector_selection,
    collector: row.collector_resolved,
    systemName: row.system_name,
    systemDescription: row.system_description,
    sysObjectId: row.sys_object_id,
    lastTestAt: nullableDate(row.last_test_at),
    lastTestMessage: row.last_test_message,
    lastInventoryAt: nullableDate(row.last_inventory_at),
    pendingSnapshotId: row.pending_inventory_snapshot_id,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

function toSnapshot(row: SnapshotRow): InventorySnapshot {
  return {
    id: row.id,
    sourceId: row.source_id,
    jobId: row.job_id,
    observedAt: date(row.observed_at),
    appliedAt: nullableDate(row.applied_at),
    partial: row.partial,
    errors: row.errors,
    system: row.system_data,
    interfaces: row.interfaces,
    diff: row.diff,
  }
}

export class InventoryStore {
  constructor(private readonly db: Kysely<Database>) {}

  private async sourceCounts(
    column: 'site_id' | 'credential_id' | 'profile_id',
  ): Promise<Map<string, number>> {
    if (column === 'site_id') {
      const rows = await this.db
        .selectFrom('sources')
        .select(['site_id'])
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('site_id', 'is not', null)
        .groupBy('site_id')
        .execute()
      return new Map(rows.flatMap((row) => (row.site_id ? [[row.site_id, Number(row.count)]] : [])))
    }
    const rows = await this.db
      .selectFrom('source_checks')
      .select(column)
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .groupBy(column)
      .execute()
    return new Map(rows.map((row) => [row[column], Number(row.count)]))
  }

  async listSites(): Promise<Site[]> {
    const [rows, counts] = await Promise.all([
      this.db.selectFrom('sites').selectAll().orderBy('name').execute(),
      this.sourceCounts('site_id'),
    ])
    return toSites(rows, counts)
  }

  async siteParentIssue(
    siteId: string | null,
    parentId: string | null,
  ): Promise<'missing' | 'cycle' | null> {
    if (!parentId) return null
    if (parentId === siteId) return 'cycle'
    const rows = await this.db.selectFrom('sites').select(['id', 'parent_id']).execute()
    const byId = new Map(rows.map((row) => [row.id, row.parent_id]))
    if (!byId.has(parentId)) return 'missing'
    let current: string | null | undefined = parentId
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      if (current === siteId) return 'cycle'
      visited.add(current)
      current = byId.get(current)
    }
    return null
  }

  async siteHasChildren(id: string): Promise<boolean> {
    const child = await this.db
      .selectFrom('sites')
      .select('id')
      .where('parent_id', '=', id)
      .executeTakeFirst()
    return Boolean(child)
  }

  async createSite(input: CreateSiteRequest): Promise<Site> {
    const row = await this.db
      .insertInto('sites')
      .values({
        id: randomUUID(),
        parent_id: input.parentId ?? null,
        name: input.name.trim(),
        description: input.description?.trim() || null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return (await this.listSites()).find((site) => site.id === row.id)!
  }

  async updateSite(id: string, input: UpdateSiteRequest): Promise<Site | null> {
    const values: Updateable<Database['sites']> = { updated_at: new Date() }
    if (input.name !== undefined) values.name = input.name.trim()
    if (input.description !== undefined) values.description = input.description.trim() || null
    if (input.parentId !== undefined) values.parent_id = input.parentId
    const row = await this.db
      .updateTable('sites')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    if (!row) return null
    return (await this.listSites()).find((site) => site.id === row.id)!
  }

  async deleteSite(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('sites').where('id', '=', id).executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  async listCredentials(): Promise<SnmpCredential[]> {
    const [rows, counts] = await Promise.all([
      this.db.selectFrom('snmp_credentials').selectAll().orderBy('name').execute(),
      this.sourceCounts('credential_id'),
    ])
    return rows.map((row) => toCredential(row, counts.get(row.id) ?? 0))
  }

  async getStoredCredential(id: string): Promise<StoredCredential | null> {
    return (
      (await this.db
        .selectFrom('snmp_credentials')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()) ?? null
    )
  }

  async createCredential(input: {
    id: string
    name: string
    version: '2c' | '3'
    username: string | null
    securityLevel: CredentialRow['security_level']
    authProtocol: CredentialRow['auth_protocol']
    privacyProtocol: CredentialRow['privacy_protocol']
    encrypted: EncryptedCredentialSecret
  }): Promise<SnmpCredential> {
    const row = await this.db
      .insertInto('snmp_credentials')
      .values({
        id: input.id,
        name: input.name.trim(),
        version: input.version,
        username: input.username,
        security_level: input.securityLevel,
        auth_protocol: input.authProtocol,
        privacy_protocol: input.privacyProtocol,
        secret_key_version: input.encrypted.keyVersion,
        secret_nonce: input.encrypted.nonce,
        secret_ciphertext: input.encrypted.ciphertext,
        secret_auth_tag: input.encrypted.authTag,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toCredential(row, 0)
  }

  async updateCredential(
    id: string,
    input: {
      name?: string
      username?: string | null
      securityLevel?: CredentialRow['security_level']
      authProtocol?: CredentialRow['auth_protocol']
      privacyProtocol?: CredentialRow['privacy_protocol']
      encrypted?: EncryptedCredentialSecret
    },
  ): Promise<SnmpCredential | null> {
    const values: Updateable<Database['snmp_credentials']> = { updated_at: new Date() }
    if (input.name !== undefined) values.name = input.name.trim()
    if (input.username !== undefined) values.username = input.username
    if (input.securityLevel !== undefined) values.security_level = input.securityLevel
    if (input.authProtocol !== undefined) values.auth_protocol = input.authProtocol
    if (input.privacyProtocol !== undefined) values.privacy_protocol = input.privacyProtocol
    if (input.encrypted) {
      values.secret_key_version = input.encrypted.keyVersion
      values.secret_nonce = input.encrypted.nonce
      values.secret_ciphertext = input.encrypted.ciphertext
      values.secret_auth_tag = input.encrypted.authTag
    }
    const row = await this.db
      .updateTable('snmp_credentials')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    if (!row) return null
    const counts = await this.sourceCounts('credential_id')
    return toCredential(row, counts.get(id) ?? 0)
  }

  async deleteCredential(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('snmp_credentials')
      .where('id', '=', id)
      .executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  async listProfiles(): Promise<PollingProfile[]> {
    const [rows, counts] = await Promise.all([
      this.db.selectFrom('polling_profiles').selectAll().orderBy('name').execute(),
      this.sourceCounts('profile_id'),
    ])
    return rows.map((row) => toProfile(row, counts.get(row.id) ?? 0))
  }

  async getProfile(id: string): Promise<PollingProfile | null> {
    const row = await this.db
      .selectFrom('polling_profiles')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    const counts = await this.sourceCounts('profile_id')
    return toProfile(row, counts.get(id) ?? 0)
  }

  async createProfile(input: CreatePollingProfileRequest): Promise<PollingProfile> {
    const row = await this.db
      .insertInto('polling_profiles')
      .values({
        id: randomUUID(),
        name: input.name.trim(),
        description: input.description?.trim() || null,
        interval_seconds: input.intervalSeconds,
        timeout_ms: input.timeoutMs,
        retries: input.retries,
        collect_system: input.collectSystem,
        collect_interfaces: input.collectInterfaces,
        system_defined: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toProfile(row, 0)
  }

  async updateProfile(
    id: string,
    input: UpdatePollingProfileRequest,
  ): Promise<PollingProfile | null> {
    const existing = await this.db
      .selectFrom('polling_profiles')
      .select('system_defined')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!existing) return null
    if (existing.system_defined) return null
    const values: Updateable<Database['polling_profiles']> = { updated_at: new Date() }
    if (input.name !== undefined) values.name = input.name.trim()
    if (input.description !== undefined) values.description = input.description.trim() || null
    if (input.intervalSeconds !== undefined) values.interval_seconds = input.intervalSeconds
    if (input.timeoutMs !== undefined) values.timeout_ms = input.timeoutMs
    if (input.retries !== undefined) values.retries = input.retries
    if (input.collectSystem !== undefined) values.collect_system = input.collectSystem
    if (input.collectInterfaces !== undefined) values.collect_interfaces = input.collectInterfaces
    const row = await this.db
      .updateTable('polling_profiles')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    if (!row) return null
    const counts = await this.sourceCounts('profile_id')
    return toProfile(row, counts.get(id) ?? 0)
  }

  async deleteProfile(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('polling_profiles')
      .where('id', '=', id)
      .where('system_defined', '=', false)
      .executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  private sourceQuery(executor: DatabaseExecutor = this.db) {
    return executor
      .selectFrom('sources')
      .innerJoin('source_checks', 'source_checks.source_id', 'sources.id')
      .innerJoin('snmp_credentials', 'snmp_credentials.id', 'source_checks.credential_id')
      .innerJoin('polling_profiles', 'polling_profiles.id', 'source_checks.profile_id')
      .leftJoin('sites', 'sites.id', 'sources.site_id')
      .selectAll('sources')
      .select([
        'sites.name as site_name',
        'snmp_credentials.id as credential_id',
        'snmp_credentials.name as credential_name',
        'snmp_credentials.version as credential_version',
        'polling_profiles.id as profile_id',
        'polling_profiles.name as profile_name',
        'polling_profiles.interval_seconds as profile_interval_seconds',
        'source_checks.collector_selection',
        'source_checks.collector_resolved',
      ])
  }

  private async siteSubtreeIds(siteId: string): Promise<string[]> {
    const rows = await this.db.selectFrom('sites').select(['id', 'parent_id']).execute()
    const ids = new Set([siteId])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (row.parent_id && ids.has(row.parent_id) && !ids.has(row.id)) {
          ids.add(row.id)
          changed = true
        }
      }
    }
    return [...ids]
  }

  async listSources(
    options: { siteId?: string; includeDescendants?: boolean } = {},
  ): Promise<Source[]> {
    let query = this.sourceQuery()
    if (options.siteId) {
      const siteIds = options.includeDescendants
        ? await this.siteSubtreeIds(options.siteId)
        : [options.siteId]
      query = query.where('sources.site_id', 'in', siteIds)
    }
    const rows = await query.orderBy('sources.name').execute()
    return rows.map(toSource)
  }

  async getSource(id: string): Promise<Source | null> {
    const row = await this.sourceQuery().where('sources.id', '=', id).executeTakeFirst()
    return row ? toSource(row) : null
  }

  async createSource(input: CreateSourceRequest, collector: CollectorKind): Promise<Source> {
    const id = randomUUID()
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('sources')
        .values({
          id,
          site_id: input.siteId ?? null,
          name: input.name.trim(),
          target: input.target.trim(),
          port: input.port ?? 161,
          transport: input.transport ?? 'udp4',
          enabled: input.enabled ?? true,
          status: 'new',
          tags: input.tags ?? [],
          system_name: null,
          system_description: null,
          sys_object_id: null,
          last_test_at: null,
          last_test_message: null,
          last_inventory_at: null,
          pending_inventory_snapshot_id: null,
          applied_inventory_snapshot_id: null,
        })
        .execute()
      await transaction
        .insertInto('source_checks')
        .values({
          id: randomUUID(),
          source_id: id,
          credential_id: input.credentialId,
          profile_id: input.profileId,
          collector_selection: input.collectorSelection ?? 'auto',
          collector_resolved: collector,
          enabled: input.enabled ?? true,
        })
        .execute()
    })
    return (await this.getSource(id))!
  }

  async updateSource(
    id: string,
    input: UpdateSourceRequest,
    collector: CollectorKind | null,
  ): Promise<Source | null> {
    const exists = await this.db
      .selectFrom('sources')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()
    if (!exists) return null
    await this.db.transaction().execute(async (transaction) => {
      const sourceValues: Updateable<Database['sources']> = { updated_at: new Date() }
      if (input.name !== undefined) sourceValues.name = input.name.trim()
      if (input.target !== undefined) sourceValues.target = input.target.trim()
      if (input.port !== undefined) sourceValues.port = input.port
      if (input.transport !== undefined) sourceValues.transport = input.transport
      if (input.enabled !== undefined) sourceValues.enabled = input.enabled
      if (input.tags !== undefined) sourceValues.tags = input.tags
      if (input.siteId !== undefined) sourceValues.site_id = input.siteId
      if (input.target !== undefined || input.port !== undefined || input.transport !== undefined) {
        sourceValues.status = 'new'
        sourceValues.last_test_message = null
      }
      await transaction.updateTable('sources').set(sourceValues).where('id', '=', id).execute()

      const checkValues: Updateable<Database['source_checks']> = { updated_at: new Date() }
      if (input.credentialId !== undefined) checkValues.credential_id = input.credentialId
      if (input.profileId !== undefined) checkValues.profile_id = input.profileId
      if (input.collectorSelection !== undefined)
        checkValues.collector_selection = input.collectorSelection
      if (collector) checkValues.collector_resolved = collector
      if (input.enabled !== undefined) checkValues.enabled = input.enabled
      await transaction
        .updateTable('source_checks')
        .set(checkValues)
        .where('source_id', '=', id)
        .execute()
    })
    return this.getSource(id)
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('sources').where('id', '=', id).executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  async getProbeConfiguration(sourceId: string): Promise<ProbeConfiguration | null> {
    const row = await this.db
      .selectFrom('sources')
      .innerJoin('source_checks', 'source_checks.source_id', 'sources.id')
      .innerJoin('snmp_credentials', 'snmp_credentials.id', 'source_checks.credential_id')
      .innerJoin('polling_profiles', 'polling_profiles.id', 'source_checks.profile_id')
      .select([
        'sources.id as source_id',
        'sources.target',
        'sources.port',
        'sources.transport',
        'snmp_credentials.id',
        'snmp_credentials.name',
        'snmp_credentials.version',
        'snmp_credentials.username',
        'snmp_credentials.security_level',
        'snmp_credentials.auth_protocol',
        'snmp_credentials.privacy_protocol',
        'snmp_credentials.secret_key_version',
        'snmp_credentials.secret_nonce',
        'snmp_credentials.secret_ciphertext',
        'snmp_credentials.secret_auth_tag',
        'snmp_credentials.created_at',
        'snmp_credentials.updated_at',
        'polling_profiles.timeout_ms',
        'polling_profiles.retries',
        'polling_profiles.collect_interfaces',
      ])
      .where('sources.id', '=', sourceId)
      .executeTakeFirst()
    if (!row) return null
    return {
      sourceId: row.source_id,
      target: row.target,
      port: row.port,
      transport: row.transport,
      credential: row,
      profile: {
        timeoutMs: row.timeout_ms,
        retries: row.retries,
        collectInterfaces: row.collect_interfaces,
      },
    }
  }

  async markTesting(sourceId: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ status: 'testing', updated_at: new Date() })
      .where('id', '=', sourceId)
      .execute()
  }

  async markInventoryPending(sourceId: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ status: 'inventory_pending', updated_at: new Date() })
      .where('id', '=', sourceId)
      .execute()
  }

  async recordInventoryFailure(sourceId: string, message: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({
        status: 'unreachable',
        last_test_message: message.slice(0, 1000),
        updated_at: new Date(),
      })
      .where('id', '=', sourceId)
      .execute()
  }

  async recordTest(
    sourceId: string,
    input: { reachable: boolean; message: string; system?: InventorySystem },
  ): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({
        status: input.reachable ? 'reachable' : 'unreachable',
        last_test_at: new Date(),
        last_test_message: input.message.slice(0, 1000),
        system_name: input.system?.name,
        system_description: input.system?.description,
        sys_object_id: input.system?.objectId,
        updated_at: new Date(),
      })
      .where('id', '=', sourceId)
      .execute()
  }

  async getAppliedInventory(
    sourceId: string,
  ): Promise<{ system: InventorySystem; interfaces: InventoryInterface[] } | null> {
    const row = await this.db
      .selectFrom('sources')
      .innerJoin(
        'inventory_snapshots',
        'inventory_snapshots.id',
        'sources.applied_inventory_snapshot_id',
      )
      .select(['inventory_snapshots.system_data', 'inventory_snapshots.interfaces'])
      .where('sources.id', '=', sourceId)
      .executeTakeFirst()
    return row ? { system: row.system_data, interfaces: row.interfaces } : null
  }

  async saveSnapshot(input: {
    sourceId: string
    jobId: string
    system: InventorySystem
    interfaces: InventoryInterface[]
    diff: InventoryDiff
    partial: boolean
    errors: string[]
  }): Promise<InventorySnapshot> {
    const id = randomUUID()
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .insertInto('inventory_snapshots')
        .values({
          id,
          source_id: input.sourceId,
          job_id: input.jobId,
          system_data: sql<InventorySystem>`${JSON.stringify(input.system)}::jsonb`,
          interfaces: sql<InventoryInterface[]>`${JSON.stringify(input.interfaces)}::jsonb`,
          diff: sql<InventoryDiff>`${JSON.stringify(input.diff)}::jsonb`,
          partial: input.partial,
          errors: sql<string[]>`${JSON.stringify(input.errors)}::jsonb`,
          applied_at: null,
          applied_by: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await transaction
        .updateTable('sources')
        .set({
          pending_inventory_snapshot_id: id,
          last_inventory_at: row.observed_at,
          status: 'inventory_pending',
          updated_at: new Date(),
        })
        .where('id', '=', input.sourceId)
        .execute()
      return toSnapshot(row)
    })
  }

  async listSnapshots(sourceId: string): Promise<InventorySnapshot[]> {
    const rows = await this.db
      .selectFrom('inventory_snapshots')
      .selectAll()
      .where('source_id', '=', sourceId)
      .orderBy('observed_at', 'desc')
      .limit(20)
      .execute()
    return rows.map(toSnapshot)
  }

  async getSnapshot(id: string): Promise<InventorySnapshot | null> {
    const row = await this.db
      .selectFrom('inventory_snapshots')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? toSnapshot(row) : null
  }

  async applySnapshot(id: string, userId: string): Promise<Source | null> {
    const sourceId = await this.db.transaction().execute(async (transaction) => {
      const snapshot = await transaction
        .selectFrom('inventory_snapshots')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!snapshot) return null
      const now = new Date()
      const source = await transaction
        .updateTable('sources')
        .set({
          applied_inventory_snapshot_id: id,
          pending_inventory_snapshot_id: null,
          status: 'ready',
          system_name: snapshot.system_data.name,
          system_description: snapshot.system_data.description,
          sys_object_id: snapshot.system_data.objectId,
          updated_at: now,
        })
        .where('id', '=', snapshot.source_id)
        .where('pending_inventory_snapshot_id', '=', id)
        .returning('id')
        .executeTakeFirst()
      if (!source) return null
      await transaction
        .updateTable('inventory_snapshots')
        .set({ applied_at: now, applied_by: userId })
        .where('id', '=', id)
        .execute()
      return snapshot.source_id
    })
    return sourceId ? this.getSource(sourceId) : null
  }
}
