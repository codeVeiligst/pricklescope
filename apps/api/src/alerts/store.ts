import type { Database } from '@pricklescope/db'
import type { Insertable, Kysely, Updateable } from 'kysely'

export type StoredAlertRule = {
  id: string
  name: string
  description: string | null
  enabled: boolean
  source_id: string | null
  source_name: string | null
  if_index: string | null
  metric: 'availability' | 'latency' | 'inbound_bps' | 'outbound_bps' | 'interface_errors'
  reducer: 'last' | 'avg' | 'min' | 'max'
  comparison: 'gt' | 'lt'
  threshold: number
  recovery_threshold: number | null
  evaluation_interval_seconds: number
  pending_seconds: number
  lookback_seconds: number
  no_data_state: 'NoData' | 'Alerting' | 'OK' | 'KeepLast'
  exec_error_state: 'Error' | 'Alerting' | 'OK' | 'KeepLast'
  severity: 'info' | 'warning' | 'critical'
  contact_point_id: string | null
  contact_point_name: string | null
  created_at: Date
  updated_at: Date
}

export type StoredContactPoint = {
  id: string
  name: string
  kind: 'webhook' | 'email'
  url: string | null
  addresses: string | null
  secret_key_version: number | null
  secret_nonce: Buffer | null
  secret_ciphertext: Buffer | null
  secret_auth_tag: Buffer | null
  provider: 'graph' | 'gmail' | 'sendgrid' | 'mailgun' | 'postmark' | 'nylas' | null
  provider_config: Record<string, unknown>
  delivery_ref: string
  last_delivery_at: Date | null
  last_delivery_ok: boolean | null
  last_delivery_error: string | null
  created_at: Date
  updated_at: Date
}

/** The controller's built-in health alerts (D-042). */
export type StoredHealthAlertRule = {
  alert_key: string
  enabled: boolean
  threshold: number
  for_seconds: number
  updated_at: Date
}

export type StoredHealthAlertSettings = {
  contact_point_id: string | null
  contact_point_name: string | null
  updated_at: Date
}

export class AlertStore {
  constructor(private readonly db: Kysely<Database>) {}

  rules(): Promise<StoredAlertRule[]> {
    return this.db
      .selectFrom('alert_rules')
      .leftJoin('sources', 'sources.id', 'alert_rules.source_id')
      .leftJoin('contact_points', 'contact_points.id', 'alert_rules.contact_point_id')
      .select([
        'alert_rules.id',
        'alert_rules.name',
        'alert_rules.description',
        'alert_rules.enabled',
        'alert_rules.source_id',
        'sources.name as source_name',
        'alert_rules.if_index',
        'alert_rules.metric',
        'alert_rules.reducer',
        'alert_rules.comparison',
        'alert_rules.threshold',
        'alert_rules.recovery_threshold',
        'alert_rules.evaluation_interval_seconds',
        'alert_rules.pending_seconds',
        'alert_rules.lookback_seconds',
        'alert_rules.no_data_state',
        'alert_rules.exec_error_state',
        'alert_rules.severity',
        'alert_rules.contact_point_id',
        'contact_points.name as contact_point_name',
        'alert_rules.created_at',
        'alert_rules.updated_at',
      ])
      .orderBy('alert_rules.name')
      .execute()
  }

  async rule(id: string): Promise<StoredAlertRule | null> {
    const rows = await this.rules()
    return rows.find((row) => row.id === id) ?? null
  }

  async createRule(values: Insertable<Database['alert_rules']>): Promise<string> {
    const row = await this.db
      .insertInto('alert_rules')
      .values(values)
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  async updateRule(id: string, values: Updateable<Database['alert_rules']>): Promise<void> {
    await this.db
      .updateTable('alert_rules')
      .set({ ...values, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }

  async deleteRule(id: string): Promise<void> {
    await this.db.deleteFrom('alert_rules').where('id', '=', id).execute()
  }

  contactPoints(): Promise<StoredContactPoint[]> {
    return this.db.selectFrom('contact_points').selectAll().orderBy('name').execute()
  }

  async contactPoint(id: string): Promise<StoredContactPoint | null> {
    const row = await this.db
      .selectFrom('contact_points')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return (row as StoredContactPoint | undefined) ?? null
  }

  async contactPointByDeliveryRef(ref: string): Promise<StoredContactPoint | null> {
    const row = await this.db
      .selectFrom('contact_points')
      .selectAll()
      .where('delivery_ref', '=', ref)
      .executeTakeFirst()
    return row ?? null
  }

  async recordDelivery(id: string, ok: boolean, error: string | null): Promise<void> {
    await this.db
      .updateTable('contact_points')
      .set({ last_delivery_at: new Date(), last_delivery_ok: ok, last_delivery_error: error })
      .where('id', '=', id)
      .execute()
  }

  async createContactPoint(values: Insertable<Database['contact_points']>): Promise<string> {
    const row = await this.db
      .insertInto('contact_points')
      .values(values)
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  async updateContactPoint(
    id: string,
    values: Updateable<Database['contact_points']>,
  ): Promise<void> {
    await this.db
      .updateTable('contact_points')
      .set({ ...values, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }

  async deleteContactPoint(id: string): Promise<void> {
    await this.db.deleteFrom('contact_points').where('id', '=', id).execute()
  }

  healthRules(): Promise<StoredHealthAlertRule[]> {
    return this.db
      .selectFrom('health_alert_rules')
      .select(['alert_key', 'enabled', 'threshold', 'for_seconds', 'updated_at'])
      .orderBy('alert_key')
      .execute()
  }

  async healthSettings(): Promise<StoredHealthAlertSettings> {
    const row = await this.db
      .selectFrom('health_alert_settings')
      .leftJoin('contact_points', 'contact_points.id', 'health_alert_settings.contact_point_id')
      .select([
        'health_alert_settings.contact_point_id',
        'contact_points.name as contact_point_name',
        'health_alert_settings.updated_at',
      ])
      .where('settings_key', '=', 'primary')
      .executeTakeFirst()
    // The row is seeded by the migration. If it is gone, something removed it by
    // hand, and reporting no contact point is safer than throwing on a read.
    return (
      (row as StoredHealthAlertSettings | undefined) ?? {
        contact_point_id: null,
        contact_point_name: null,
        updated_at: new Date(0),
      }
    )
  }

  async saveHealthAlerts(
    contactPointId: string | null,
    rules: { key: string; enabled: boolean; threshold: number; forSeconds: number }[],
    actorUserId: string | null,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('health_alert_settings')
        .set({ contact_point_id: contactPointId, updated_by: actorUserId, updated_at: new Date() })
        .where('settings_key', '=', 'primary')
        .execute()
      // Updates only. The rows are the catalogue, seeded by the migration; an
      // insert here would let a request invent a key that provisions nothing.
      for (const rule of rules) {
        await trx
          .updateTable('health_alert_rules')
          .set({
            enabled: rule.enabled,
            threshold: rule.threshold,
            for_seconds: rule.forSeconds,
            updated_at: new Date(),
          })
          .where('alert_key', '=', rule.key)
          .execute()
      }
    })
  }
}
