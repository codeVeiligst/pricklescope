import {
  alertRuleDefinition,
  sendEmail,
  type EmailCredentials,
  alertRuleUid,
  buildAlertQuery,
  contactPointDefinition,
  GrafanaApiClient,
  ALERT_RULE_GROUP,
  healthAlertRuleDefinition,
  healthAlertRuleUid,
  type AlertRuleInput,
  type HealthAlertRuleInput,
} from '@pricklescope/adapters'
import {
  EMAIL_PROVIDER_CONFIG_KEYS,
  HEALTH_ALERT_CATALOGUE,
  type AlertOverview,
  type AlertPreview,
  type AlertRule,
  type ContactPoint,
  type UpsertAlertRuleRequest,
  type HealthAlertKey,
  type HealthAlertSettings,
  type UpdateHealthAlertsRequest,
  type UpsertContactPointRequest,
} from '@pricklescope/contracts'

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import type { AuthStore } from '../auth/store.js'
import type { AppConfig } from '../config.js'
import { GrafanaTokenCrypto } from '../grafana/token-crypto.js'
import type { GrafanaStore } from '../grafana/store.js'
import type { QuestDbClient } from '../storage/questdb.js'
import { HttpError } from '../errors.js'
import type { SyncProbe } from '../sync/probe.js'
import type { AlertStore, StoredAlertRule, StoredContactPoint } from './store.js'

function toRule(row: StoredAlertRule): AlertRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    sourceId: row.source_id,
    sourceName: row.source_name,
    ifIndex: row.if_index,
    metric: row.metric,
    reducer: row.reducer,
    comparison: row.comparison,
    threshold: Number(row.threshold),
    recoveryThreshold: row.recovery_threshold === null ? null : Number(row.recovery_threshold),
    evaluationIntervalSeconds: row.evaluation_interval_seconds,
    pendingSeconds: row.pending_seconds,
    lookbackSeconds: row.lookback_seconds,
    noDataState: row.no_data_state,
    execErrorState: row.exec_error_state,
    severity: row.severity,
    contactPointId: row.contact_point_id,
    contactPointName: row.contact_point_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/**
 * Copies only the provider settings the product defines. The email adapter honours
 * `apiBaseUrl` and `tokenBaseUrl` so its tests can point a provider at a local
 * server; persisting a caller's key verbatim would turn that test seam into a way
 * to send the provider's credential somewhere else.
 */
function allowedProviderConfig(
  input: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {}
  if (!input) return values
  for (const key of EMAIL_PROVIDER_CONFIG_KEYS) {
    const value = input[key]
    if (typeof value === 'string') values[key] = value
  }
  return values
}

function toContactPoint(row: StoredContactPoint): ContactPoint {
  const config = (row.provider_config ?? {}) as Record<string, string | undefined>
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    addresses: row.addresses,
    secretConfigured: row.secret_ciphertext !== null,
    provider: row.provider,
    providerConfig: {
      ...(config.from ? { from: config.from } : {}),
      ...(config.tenantId ? { tenantId: config.tenantId } : {}),
      ...(config.domain ? { domain: config.domain } : {}),
      ...(config.region === 'eu' || config.region === 'us' ? { region: config.region } : {}),
      ...(config.grantId ? { grantId: config.grantId } : {}),
    },
    lastDeliveryAt: row.last_delivery_at?.toISOString() ?? null,
    lastDeliveryOk: row.last_delivery_ok,
    lastDeliveryError: row.last_delivery_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

// One encrypted blob per contact point holds both the provider credentials and
// the bearer token Grafana presents when it calls the controller back.
interface ContactSecretBundle {
  credentials?: EmailCredentials
  webhookSecret?: string
  deliveryToken?: string
}

export interface GrafanaNotification {
  status?: string
  alerts?: Array<{
    status?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }>
}

function notificationSubject(payload: GrafanaNotification): string {
  const first = payload.alerts?.[0]
  const name = first?.labels?.alertname ?? 'PrickleScope alert'
  const state = (payload.status ?? first?.status ?? 'firing').toUpperCase()
  const extra =
    (payload.alerts?.length ?? 0) > 1 ? ` (+${(payload.alerts?.length ?? 1) - 1} more)` : ''
  return `[${state}] ${name}${extra}`
}

function notificationBody(payload: GrafanaNotification): string {
  const lines: string[] = []
  for (const alert of payload.alerts ?? []) {
    const labels = alert.labels ?? {}
    lines.push(`${(alert.status ?? 'firing').toUpperCase()}: ${labels.alertname ?? 'alert'}`)
    if (labels.source_name) lines.push(`  Source: ${labels.source_name}`)
    if (labels.severity) lines.push(`  Severity: ${labels.severity}`)
    if (alert.annotations?.summary) lines.push(`  ${alert.annotations.summary}`)
    lines.push('')
  }
  lines.push('Sent by PrickleScope.')
  return lines.join('\n')
}

export class AlertService {
  private operation: Promise<void> = Promise.resolve()
  private readonly crypto: GrafanaTokenCrypto

  constructor(
    private readonly store: AlertStore,
    private readonly grafanaStore: GrafanaStore,
    private readonly questdb: QuestDbClient | null,
    private readonly audit: AuthStore,
    private readonly config: AppConfig,
  ) {
    this.crypto = new GrafanaTokenCrypto(
      config.security.credentialKey,
      config.security.credentialKeyVersion,
    )
  }

  async rules(): Promise<AlertRule[]> {
    return (await this.store.rules()).map(toRule)
  }

  async contactPoints(): Promise<ContactPoint[]> {
    return (await this.store.contactPoints()).map(toContactPoint)
  }

  async createRule(request: UpsertAlertRuleRequest): Promise<AlertRule> {
    this.validate(request)
    const id = await this.store.createRule(this.ruleValues(request))
    const created = await this.store.rule(id)
    if (!created) throw new Error('The alert rule could not be read back after creation')
    return toRule(created)
  }

  async updateRule(id: string, request: UpsertAlertRuleRequest): Promise<AlertRule> {
    this.validate(request)
    await this.store.updateRule(id, this.ruleValues(request))
    const updated = await this.store.rule(id)
    if (!updated) throw new Error('The alert rule no longer exists')
    return toRule(updated)
  }

  async deleteRule(id: string): Promise<void> {
    await this.store.deleteRule(id)
    // Grafana keeps its copy until the next reconcile, so remove it eagerly.
    const client = await this.client()
    if (client) await client.deleteAlertRule(alertRuleUid(id))
  }

  private validate(request: UpsertAlertRuleRequest): void {
    if (request.recoveryThreshold !== undefined && request.recoveryThreshold !== null) {
      const firesAbove = request.comparison === 'gt'
      const sane = firesAbove
        ? request.recoveryThreshold < request.threshold
        : request.recoveryThreshold > request.threshold
      if (!sane) {
        throw new Error(
          firesAbove
            ? 'The recovery threshold must be below the firing threshold'
            : 'The recovery threshold must be above the firing threshold',
        )
      }
    }
    // Fails fast on an unusable scope rather than at reconcile time.
    buildAlertQuery(
      request.metric,
      { sourceId: request.sourceId, ifIndex: request.ifIndex ?? null },
      request.lookbackSeconds,
    )
  }

  private ruleValues(request: UpsertAlertRuleRequest) {
    return {
      name: request.name,
      description: request.description ?? null,
      enabled: request.enabled ?? true,
      source_id: request.sourceId,
      if_index: request.ifIndex ?? null,
      metric: request.metric,
      reducer: request.reducer,
      comparison: request.comparison,
      threshold: request.threshold,
      recovery_threshold: request.recoveryThreshold ?? null,
      evaluation_interval_seconds: request.evaluationIntervalSeconds,
      pending_seconds: request.pendingSeconds,
      lookback_seconds: request.lookbackSeconds,
      no_data_state: request.noDataState,
      exec_error_state: request.execErrorState,
      severity: request.severity,
      contact_point_id: request.contactPointId,
    }
  }

  async upsertContactPoint(request: UpsertContactPointRequest, id?: string): Promise<ContactPoint> {
    if (request.kind === 'webhook' && !request.url) {
      throw new Error('A webhook contact point needs a URL')
    }
    if (request.kind === 'email') {
      if (!request.provider) throw new Error('Choose which service sends the mail')
      if (!request.addresses) throw new Error('An email contact point needs at least one recipient')
      if (!request.providerConfig?.from) throw new Error('A send-from address is required')
    }

    const existing = id ? await this.store.contactPoint(id) : null
    const previous = existing ? this.secretBundle(existing) : {}
    const contactId = id ?? randomUUID()

    // Credentials are write-only: an omitted field keeps whatever is stored.
    const credentials: EmailCredentials = {
      ...(previous.credentials ?? {}),
      ...(request.credentials ?? {}),
    }
    const bundle: ContactSecretBundle = {
      ...(request.kind === 'email' ? { credentials } : {}),
      ...(request.secret ? { webhookSecret: request.secret } : {}),
      ...(!request.secret && previous.webhookSecret && !request.clearSecret
        ? { webhookSecret: previous.webhookSecret }
        : {}),
      // Generated here, never asked of the operator.
      deliveryToken: previous.deliveryToken ?? randomBytes(32).toString('base64url'),
    }
    const sealed = this.crypto.encrypt(`contact:${contactId}`, JSON.stringify(bundle))
    const values = {
      id: contactId,
      name: request.name,
      kind: request.kind,
      url: request.kind === 'webhook' ? (request.url ?? null) : null,
      addresses: request.addresses ?? null,
      provider: request.kind === 'email' ? (request.provider ?? null) : null,
      provider_config: allowedProviderConfig(request.providerConfig),
      secret_key_version: sealed.keyVersion,
      secret_nonce: Buffer.from(sealed.nonce),
      secret_ciphertext: Buffer.from(sealed.ciphertext),
      secret_auth_tag: Buffer.from(sealed.authTag),
    }

    if (id) await this.store.updateContactPoint(id, values)
    else await this.store.createContactPoint(values)

    const saved = await this.store.contactPoint(contactId)
    if (!saved) throw new Error('The contact point could not be read back')
    return toContactPoint(saved)
  }

  async deleteContactPoint(id: string): Promise<void> {
    const existing = await this.store.contactPoint(id)
    await this.store.deleteContactPoint(id)
    const client = await this.client()
    if (!client || !existing) return
    await this.grafanaStore.deleteResource(`contact-${id}`)
    const remote = (await client.contactPoints()).find((item) => item.name === existing.name)
    if (typeof remote?.uid === 'string') await client.deleteContactPoint(remote.uid)
  }

  /**
   * Runs the rule's own query and applies its reducer and comparison, so an
   * operator sees what the condition would do before saving it.
   */
  async preview(request: UpsertAlertRuleRequest): Promise<AlertPreview> {
    if (!this.questdb) throw new Error('QuestDB is not configured')
    this.validate(request)
    const sql = buildAlertQuery(
      request.metric,
      { sourceId: request.sourceId, ifIndex: request.ifIndex ?? null },
      request.lookbackSeconds,
    )
    const rows = await this.questdb.alertPreview(sql)

    const bySeries = new Map<string, number[]>()
    for (const row of rows) {
      if (row.value === null || !Number.isFinite(row.value)) continue
      const key = row.series ?? 'series'
      const values = bySeries.get(key) ?? []
      values.push(row.value)
      bySeries.set(key, values)
    }

    const reduce = (values: number[]): number | null => {
      if (!values.length) return null
      switch (request.reducer) {
        case 'last':
          return values[values.length - 1]!
        case 'min':
          return Math.min(...values)
        case 'max':
          return Math.max(...values)
        case 'avg':
          return values.reduce((total, value) => total + value, 0) / values.length
      }
    }
    const fires = (value: number | null): boolean =>
      value !== null &&
      (request.comparison === 'gt' ? value > request.threshold : value < request.threshold)

    const series = [...bySeries.entries()].map(([name, values]) => {
      const value = reduce(values)
      return { name, value, wouldFire: fires(value) }
    })

    const reducedValue = series.length === 1 ? (series[0]?.value ?? null) : null
    return {
      sql,
      reducedValue,
      wouldFire: series.some((entry) => entry.wouldFire),
      sampleCount: rows.length,
      series,
    }
  }

  async overview(): Promise<AlertOverview> {
    const [rules, contacts, settings] = await Promise.all([
      this.store.rules(),
      this.store.contactPoints(),
      this.grafanaStore.get(),
    ])

    let states: AlertOverview['states'] = []
    const client = await this.client()
    if (client) {
      try {
        const groups = await client.alertState()
        states = groups.flatMap((group) => {
          const entries = Array.isArray(group.rules) ? group.rules : []
          return entries.flatMap((entry) => {
            const rule = entry as Record<string, unknown>
            const labels = (rule.labels ?? {}) as Record<string, string>
            if (!labels.pricklescope_rule) return []
            return [
              {
                ruleId: labels.pricklescope_rule,
                ruleUid: typeof rule.uid === 'string' ? rule.uid : '',
                name: typeof rule.name === 'string' ? rule.name : '',
                state: typeof rule.state === 'string' ? rule.state : 'unknown',
                since: typeof rule.lastEvaluation === 'string' ? rule.lastEvaluation : null,
              },
            ]
          })
        })
      } catch {
        // State is advisory; the desired state below is still worth showing.
      }
    }

    return {
      status: settings.status === 'active' ? 'active' : settings.status,
      error: settings.error,
      ruleCount: rules.length,
      contactPointCount: contacts.length,
      appliedAt: settings.applied_at?.toISOString() ?? null,
      states,
    }
  }

  /**
   * Whether applying would change the rules or contact points in Grafana. The
   * reconciler records each one's `updated_at` as its content hash, so comparing
   * against that is exact: an edited rule, a new contact point, and a rule
   * disabled or deleted since the last apply all register.
   */
  async healthAlerts(): Promise<HealthAlertSettings> {
    const [settings, rules] = await Promise.all([
      this.store.healthSettings(),
      this.store.healthRules(),
    ])
    return {
      contactPointId: settings.contact_point_id,
      contactPointName: settings.contact_point_name,
      updatedAt: settings.updated_at.toISOString(),
      rules: rules.map((rule) => ({
        key: rule.alert_key as HealthAlertKey,
        enabled: rule.enabled,
        threshold: Number(rule.threshold),
        forSeconds: rule.for_seconds,
      })),
    }
  }

  async updateHealthAlerts(
    request: UpdateHealthAlertsRequest,
    actorUserId: string | null,
  ): Promise<HealthAlertSettings> {
    for (const rule of request.rules) {
      if (!(rule.key in HEALTH_ALERT_CATALOGUE)) {
        throw new HttpError(400, 'request_refused', `Unknown health alert: ${rule.key}`)
      }
    }
    if (request.contactPointId) {
      const contact = await this.store.contactPoint(request.contactPointId)
      if (!contact) {
        throw new HttpError(400, 'request_refused', 'That contact point no longer exists')
      }
    }
    await this.store.saveHealthAlerts(request.contactPointId, request.rules, actorUserId)
    await this.audit.writeAudit({
      actorUserId,
      action: 'alerts.health.updated',
      resourceType: 'health_alerts',
      resourceId: 'primary',
      outcome: 'success',
      metadata: { enabled: request.rules.filter((rule) => rule.enabled).length },
    })
    return this.healthAlerts()
  }

  /**
   * What the controller would write for each enabled health rule, keyed by uid.
   *
   * The hash is of the rendered rule, not of a timestamp. The contact point is a
   * shared setting that changes the rule body without touching any rule's own
   * `updated_at`, so a timestamp hash would report clean while Grafana still
   * routed to the old destination — which is D-040 exactly: a probe must measure
   * the thing, not something adjacent to it. Hashing the body also means a change
   * to the generated SQL in a new version shows as drift, which is correct,
   * because it is.
   */
  private async healthRuleDefinitions(): Promise<Map<string, Record<string, unknown>>> {
    const [settings, rules] = await Promise.all([
      this.store.healthSettings(),
      this.store.healthRules(),
    ])
    const wanted = new Map<string, Record<string, unknown>>()
    for (const rule of rules) {
      if (!rule.enabled) continue
      const input: HealthAlertRuleInput = {
        key: rule.alert_key as HealthAlertKey,
        threshold: Number(rule.threshold),
        forSeconds: rule.for_seconds,
        contactPoint: settings.contact_point_name,
      }
      wanted.set(healthAlertRuleUid(input.key), healthAlertRuleDefinition(input))
    }
    return wanted
  }

  private static definitionHash(definition: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
  }

  async pendingChange(): Promise<SyncProbe> {
    const settings = await this.grafanaStore.get()
    if (!this.config.grafana.internalUrl) {
      return {
        pending: false,
        detail: 'Grafana is not configured',
        lastAppliedAt: settings.applied_at,
        blocked: 'Grafana is not configured',
      }
    }

    const [rules, contacts, stored] = await Promise.all([
      this.store.rules(),
      this.store.contactPoints(),
      this.grafanaStore.resourceHashes(),
    ])

    const wanted = new Map<string, string>()
    for (const contact of contacts) {
      wanted.set(`contact-${contact.id}`, contact.updated_at.toISOString())
    }
    for (const rule of rules) {
      if (rule.enabled) wanted.set(alertRuleUid(rule.id), rule.updated_at.toISOString())
    }
    // The built-in health rules, hashed the same way the reconciler stores them.
    // These two loops have to agree exactly; D-025 is the rule and D-040 is what
    // happens when they do not.
    const healthWanted = await this.healthRuleDefinitions()
    for (const [uid, definition] of healthWanted) {
      wanted.set(uid, AlertService.definitionHash(definition))
    }

    let changed = 0
    for (const [uid, hash] of wanted) if (stored.get(uid) !== hash) changed += 1
    // Rules deleted or disabled since the last apply still sit in Grafana.
    let stale = 0
    for (const uid of stored.keys()) {
      if (
        (uid.startsWith('ps-alert-') ||
          uid.startsWith('ps-health-') ||
          uid.startsWith('contact-')) &&
        !wanted.has(uid)
      )
        stale += 1
    }

    const parts: string[] = []
    if (changed) parts.push(`${changed} added or changed`)
    if (stale) parts.push(`${stale} to remove`)
    return {
      pending: changed + stale > 0,
      detail: parts.length
        ? parts.join(', ')
        : `${rules.length} rules, ${healthWanted.size} health checks, and ${contacts.length} contact points are current`,
      lastAppliedAt: settings.applied_at,
      blocked: null,
    }
  }

  /** Reconciles every rule and contact point into Grafana. */
  reconcile(actorUserId: string | null, signal?: AbortSignal): Promise<AlertOverview> {
    return this.serialized(async () => {
      const client = await this.client()
      if (!client) throw new Error('Grafana is not configured')

      const [rules, contacts] = await Promise.all([this.store.rules(), this.store.contactPoints()])
      if (contacts.some((contact) => contact.kind === 'email')) this.assertDeliveryReachable()

      for (const contact of contacts) {
        signal?.throwIfAborted()
        const bundle = this.secretBundle(contact)
        await client.upsertContactPoint(
          contactPointDefinition({
            name: contact.name,
            kind: contact.kind,
            url: contact.url,
            addresses: contact.addresses,
            secret: bundle.webhookSecret ?? null,
            deliveryUrl: this.deliveryUrl(contact.delivery_ref),
            deliveryToken: bundle.deliveryToken ?? null,
          }),
        )
        await this.grafanaStore.saveResource({
          uid: `contact-${contact.id}`,
          type: 'contact_point',
          title: contact.name,
          folderUid: null,
          contentHash: contact.updated_at.toISOString(),
          body: {},
        })
      }

      // A shared group interval keeps evaluation predictable; the finest rule wins.
      const interval = rules.length
        ? Math.min(...rules.map((rule) => rule.evaluation_interval_seconds))
        : 60

      const wanted = new Set<string>()
      for (const rule of rules) {
        signal?.throwIfAborted()
        const uid = alertRuleUid(rule.id)
        if (!rule.enabled) {
          await client.deleteAlertRule(uid)
          await this.grafanaStore.deleteResource(uid)
          continue
        }
        wanted.add(uid)
        await client.upsertAlertRule(uid, alertRuleDefinition(this.ruleInput(rule)))
        await this.grafanaStore.saveResource({
          uid,
          type: 'alert_rule',
          title: rule.name,
          folderUid: 'pricklescope',
          contentHash: rule.updated_at.toISOString(),
          body: {},
        })
      }

      // The built-in health rules. Provisioned on every reconcile, so a fresh
      // installation is watching itself without anyone opening a settings screen.
      const healthWanted = await this.healthRuleDefinitions()
      const healthUids = new Set(healthWanted.keys())
      for (const key of Object.keys(HEALTH_ALERT_CATALOGUE) as HealthAlertKey[]) {
        signal?.throwIfAborted()
        const uid = healthAlertRuleUid(key)
        const definition = healthWanted.get(uid)
        if (!definition) {
          // Disabled, so remove it rather than leaving a rule nobody can see in
          // the interface still firing at three in the morning.
          await client.deleteAlertRule(uid)
          await this.grafanaStore.deleteResource(uid)
          continue
        }
        await client.upsertAlertRule(uid, definition)
        await this.grafanaStore.saveResource({
          uid,
          type: 'alert_rule',
          title: HEALTH_ALERT_CATALOGUE[key].label,
          folderUid: 'pricklescope',
          // The rendered body, matching the probe exactly.
          contentHash: AlertService.definitionHash(definition),
          body: {},
        })
      }

      // Remove rules Grafana still holds that the controller no longer owns.
      const remote = await client.alertRules()
      for (const entry of remote) {
        const uid = typeof entry.uid === 'string' ? entry.uid : ''
        const labels = (entry.labels ?? {}) as Record<string, string>
        if (uid.startsWith('ps-alert-') && labels.pricklescope_rule && !wanted.has(uid)) {
          await client.deleteAlertRule(uid)
        }
        if (uid.startsWith('ps-health-') && labels.pricklescope_health && !healthUids.has(uid)) {
          await client.deleteAlertRule(uid)
        }
      }

      // Forget registry rows for rules and contact points that are gone. Without
      // this the registry keeps claiming resources nobody owns, which reads as
      // drift that applying can never clear.
      const owned = new Set([
        ...wanted,
        ...healthUids,
        ...contacts.map((contact) => `contact-${contact.id}`),
      ])
      for (const uid of (await this.grafanaStore.resourceHashes()).keys()) {
        if (
          (uid.startsWith('ps-alert-') ||
            uid.startsWith('ps-health-') ||
            uid.startsWith('contact-')) &&
          !owned.has(uid)
        ) {
          await this.grafanaStore.deleteResource(uid)
        }
      }

      // The health rules evaluate every 60s, so the shared group interval has to
      // divide that as well as the user rules'. Without health rules in the
      // minimum, a user rule at 300s would slow the health checks to 300s too.
      if (wanted.size || healthUids.size) {
        await client.setRuleGroupInterval(
          ALERT_RULE_GROUP,
          healthUids.size ? Math.min(interval, 60) : interval,
        )
      }

      await this.audit.writeAudit({
        actorUserId,
        action: 'alerts.reconciled',
        resourceType: 'alert_rules',
        resourceId: 'all',
        outcome: 'success',
        metadata: {
          rules: wanted.size,
          healthChecks: healthUids.size,
          contactPoints: contacts.length,
        },
      })

      return this.overview()
    })
  }

  /**
   * Delivers a sample notification so an operator can confirm the endpoint is
   * reachable and accepts the payload shape Grafana will send.
   *
   * The controller sends it rather than asking Grafana to. Grafana 13 removed the
   * receiver test endpoint the provisioning API used, and its replacement is an
   * unstable resource API — the churn docs/architecture.md warns about. Sending from
   * here keeps the button working across Grafana versions. The limitation is that
   * it proves reachability from the controller, not from Grafana; a real firing
   * rule is the end-to-end proof.
   */
  async testContactPoint(id: string): Promise<void> {
    const contact = await this.store.contactPoint(id)
    if (!contact) throw new Error('The contact point no longer exists')

    // Email is sent from here in production too, so the test is the real path
    // minus Grafana: a genuine message through the operator's provider.
    if (contact.kind === 'email') {
      await this.sendEmailNotification(contact, {
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'PrickleScope test notification', severity: 'info' },
            annotations: { summary: 'Test notification from PrickleScope' },
          },
        ],
      })
      return
    }

    if (!contact.url) throw new Error('This webhook contact point has no URL')

    const secret = this.secretBundle(contact).webhookSecret ?? null
    let response: Response
    try {
      response = await this.deliverTest(contact.url, secret, contact.name)
    } catch (error) {
      // The URL is written for Grafana to resolve. A container-internal or
      // cluster-internal name may be unreachable from here while Grafana reaches
      // it perfectly well, so say so rather than calling the endpoint broken.
      throw new Error(
        `PrickleScope could not reach ${contact.url} (${
          error instanceof Error ? error.message : 'unknown error'
        }). If that address only resolves inside Grafana's network, the contact point may still work; a firing rule is the definitive check.`,
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new Error(`The contact point returned HTTP ${response.status}`)
    }
  }

  private deliverTest(url: string, secret: string | null, receiver: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      // Shaped like Grafana's webhook payload so a receiver that parses the real
      // thing also parses this.
      body: JSON.stringify({
        receiver,
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'PrickleScope test notification', severity: 'info' },
            annotations: { summary: 'Test notification from PrickleScope' },
            startsAt: new Date().toISOString(),
          },
        ],
        title: 'PrickleScope test notification',
        message: 'If you can read this, the contact point is reachable.',
      }),
      signal: AbortSignal.timeout(10_000),
    })
  }

  private ruleInput(rule: StoredAlertRule): AlertRuleInput {
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      sourceId: rule.source_id,
      ifIndex: rule.if_index,
      metric: rule.metric,
      reducer: rule.reducer,
      comparison: rule.comparison,
      threshold: Number(rule.threshold),
      recoveryThreshold: rule.recovery_threshold === null ? null : Number(rule.recovery_threshold),
      evaluationIntervalSeconds: rule.evaluation_interval_seconds,
      pendingSeconds: rule.pending_seconds,
      lookbackSeconds: rule.lookback_seconds,
      noDataState: rule.no_data_state,
      execErrorState: rule.exec_error_state,
      severity: rule.severity,
      contactPoint: rule.contact_point_name,
    }
  }

  /**
   * The bundle is bound to the row id, not the name, so renaming a contact point
   * keeps its credentials and its delivery token — a rename that silently broke
   * delivery would surface only as a 401 in Grafana's log.
   */
  private secretBundle(contact: StoredContactPoint): ContactSecretBundle {
    if (
      contact.secret_key_version === null ||
      !contact.secret_nonce ||
      !contact.secret_ciphertext ||
      !contact.secret_auth_tag
    ) {
      return {}
    }
    const sealed = {
      keyVersion: contact.secret_key_version,
      nonce: contact.secret_nonce,
      ciphertext: contact.secret_ciphertext,
      authTag: contact.secret_auth_tag,
    }
    // Contact points written before the id binding used the name; they are
    // re-sealed on the next save.
    for (const aad of [`contact:${contact.id}`, `contact:${contact.name}`]) {
      try {
        return JSON.parse(this.crypto.decrypt(aad, sealed)) as ContactSecretBundle
      } catch {
        continue
      }
    }
    // A rotated key makes the blob unreadable; treat it as absent so the
    // operator can simply re-enter the settings.
    return {}
  }

  /**
   * Handles the callback Grafana makes for an email contact point. Grafana
   * evaluates and routes; the controller renders and sends, because the
   * providers people use cannot all be driven from a generic JSON webhook
   * (D-023).
   */
  async deliverNotification(
    deliveryRef: string,
    bearer: string | null,
    payload: GrafanaNotification,
  ): Promise<void> {
    const contact = await this.store.contactPointByDeliveryRef(deliveryRef)
    if (!contact) throw new HttpError(404, 'not_found', 'Unknown delivery reference')

    const bundle = this.secretBundle(contact)
    const expected = bundle.deliveryToken ?? ''
    const provided = bearer ?? ''
    const matches =
      expected.length === provided.length &&
      expected.length > 0 &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    if (!matches) throw new HttpError(401, 'unauthorized', 'Invalid delivery token')

    await this.sendEmailNotification(contact, payload)
  }

  /**
   * Renders one notification and hands it to the operator's provider, recording
   * the outcome so the Alerts screen can say plainly whether the last message
   * went out.
   */
  private async sendEmailNotification(
    contact: StoredContactPoint,
    payload: GrafanaNotification,
  ): Promise<void> {
    if (contact.kind !== 'email' || !contact.provider) {
      throw new HttpError(400, 'not_email', 'This contact point does not deliver email')
    }

    // Filtered on the way out as well as on the way in, so a row written before
    // the write path was narrowed cannot redirect the provider call either.
    const config = allowedProviderConfig(contact.provider_config ?? {})
    const recipients = (contact.addresses ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean)

    try {
      await sendEmail(
        {
          from: config.from ?? '',
          to: recipients,
          subject: notificationSubject(payload),
          text: notificationBody(payload),
        },
        { ...config, provider: contact.provider, from: config.from ?? '' },
        this.secretBundle(contact).credentials ?? {},
      )
      await this.store.recordDelivery(contact.id, true, null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Delivery failed'
      await this.store.recordDelivery(contact.id, false, message.slice(0, 500))
      throw new HttpError(502, 'delivery_failed', message)
    }
  }

  /** The callback address Grafana uses; generated, never asked of the operator. */
  private deliveryUrl(deliveryRef: string): string {
    return `${this.config.grafana.notifyBaseUrl.replace(/\/+$/, '')}/api/v1/alerts/notify/${deliveryRef}`
  }

  /**
   * Grafana runs in a container and the API usually does not, so a callback to a
   * loopback-only listener silently never arrives. Say so at reconcile time
   * rather than leaving an alert that fires and mails nobody.
   */
  private assertDeliveryReachable(): void {
    const loopback = new Set(['localhost', '127.0.0.1', '::1'])
    const host = this.config.host
    let target: URL
    try {
      target = new URL(this.deliveryUrl('probe'))
    } catch {
      throw new Error(
        `PRICKLESCOPE_NOTIFY_BASE_URL is not a valid URL (${this.config.grafana.notifyBaseUrl}). Grafana needs it to hand email notifications back for delivery.`,
      )
    }
    if (loopback.has(host) && !loopback.has(target.hostname)) {
      throw new Error(
        `Grafana cannot deliver email while the API listens on ${host} only: it would have to reach ${target.origin} from its container. Set PRICKLESCOPE_HOST to an address Grafana can connect to.`,
      )
    }
  }

  private async client(): Promise<GrafanaApiClient | null> {
    const { internalUrl } = this.config.grafana
    if (!internalUrl) return null
    const settings = await this.grafanaStore.get()
    if (
      settings.token_key_version !== null &&
      settings.token_nonce &&
      settings.token_ciphertext &&
      settings.token_auth_tag
    ) {
      try {
        const token = this.crypto.decrypt('primary', {
          keyVersion: settings.token_key_version,
          nonce: settings.token_nonce,
          ciphertext: settings.token_ciphertext,
          authTag: settings.token_auth_tag,
        })
        return GrafanaApiClient.bearer(internalUrl, token)
      } catch {
        // Fall through to bootstrap access below.
      }
    }
    const { adminUsername, adminPassword } = this.config.grafana
    if (!adminUsername || !adminPassword) return null
    return GrafanaApiClient.basic(internalUrl, adminUsername, adminPassword)
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
