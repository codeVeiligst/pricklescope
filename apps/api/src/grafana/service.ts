import {
  GrafanaApiClient,
  grafanaResourceDefinitions,
  type GrafanaDataSourceInput,
} from '@pricklescope/adapters'
import {
  GRAFANA_DASHBOARDS,
  GRAFANA_DATASOURCE_UID,
  type GrafanaDashboard,
  type GrafanaDashboardKey,
  type GrafanaOverview,
} from '@pricklescope/contracts'

import type { AuthStore } from '../auth/store.js'
import type { AppConfig } from '../config.js'
import type { SyncProbe } from '../sync/probe.js'
import type { GrafanaStore, StoredGrafanaSettings } from './store.js'
import { GrafanaTokenCrypto } from './token-crypto.js'

const serviceAccountName = 'PrickleScope provisioning'
const pluginId = 'questdb-questdb-datasource'

function dashboards(publicPath: string): GrafanaDashboard[] {
  return Object.entries(GRAFANA_DASHBOARDS).map(([key, dashboard]) => ({
    key: key as GrafanaDashboardKey,
    uid: dashboard.uid,
    title: dashboard.title,
    path: `${publicPath}/d/${dashboard.uid}?orgId=1`,
  }))
}

export class GrafanaService {
  private operation: Promise<void> = Promise.resolve()
  private readonly tokenCrypto: GrafanaTokenCrypto

  constructor(
    private readonly store: GrafanaStore,
    private readonly audit: AuthStore,
    private readonly config: AppConfig,
  ) {
    this.tokenCrypto = new GrafanaTokenCrypto(
      config.security.credentialKey,
      config.security.credentialKeyVersion,
    )
  }

  /**
   * Whether applying would change Grafana. Builds the resource definitions the
   * reconciler would write and compares their hashes to what was last written, so
   * a dashboard edited inside Grafana and a dashboard changed here both show up.
   */
  async pendingChange(): Promise<SyncProbe> {
    const settings = await this.store.get()
    const appliedAt = settings.applied_at
    const { internalUrl, questdbUsername, questdbPassword } = this.config.grafana
    if (!internalUrl) {
      return {
        pending: false,
        detail: 'Grafana is not configured',
        lastAppliedAt: appliedAt,
        blocked: 'Grafana is not configured',
      }
    }
    if (!questdbUsername || !questdbPassword) {
      return {
        pending: false,
        detail: 'The Grafana QuestDB credentials are not configured',
        lastAppliedAt: appliedAt,
        blocked: 'The Grafana QuestDB read-only credentials are not configured',
      }
    }
    if (settings.status !== 'active') {
      return {
        pending: true,
        detail:
          settings.status === 'failed'
            ? 'The last apply failed'
            : 'Grafana has never been provisioned',
        lastAppliedAt: appliedAt,
        blocked: null,
      }
    }

    const stored = await this.store.resourceHashes()
    const definitions = grafanaResourceDefinitions({
      server: this.config.grafana.questdbServer,
      port: this.config.grafana.questdbPort,
      username: questdbUsername,
      password: questdbPassword,
    })
    const changed = definitions.filter((item) => stored.get(item.uid) !== item.contentHash)
    return {
      pending: changed.length > 0,
      detail: changed.length
        ? `${changed.length} of ${definitions.length} managed resources differ`
        : `${definitions.length} managed resources are current`,
      lastAppliedAt: appliedAt,
      blocked: null,
    }
  }

  async overview(): Promise<GrafanaOverview> {
    const settings = await this.store.get()
    let connection: GrafanaOverview['connection'] = this.config.grafana.internalUrl
      ? 'down'
      : 'disabled'
    let connectionMessage = this.config.grafana.internalUrl
      ? 'Grafana did not answer the last status request'
      : 'Grafana integration is not configured'
    if (this.config.grafana.internalUrl) {
      try {
        const health = await GrafanaApiClient.anonymous(this.config.grafana.internalUrl).health()
        connection = 'up'
        connectionMessage = `Grafana ${health.version}`
      } catch {
        // Upstream details remain server-side.
      }
    }
    return {
      connection,
      connectionMessage,
      status: settings.status,
      error: settings.error,
      revision: settings.revision,
      grafanaVersion: settings.grafana_version,
      pluginVersion: settings.plugin_version,
      dataSourceUid: GRAFANA_DATASOURCE_UID,
      publicPath: this.config.grafana.publicPath,
      dashboards: dashboards(this.config.grafana.publicPath),
      resources: await this.store.resources(),
      updatedAt: settings.updated_at.toISOString(),
      appliedAt: settings.applied_at?.toISOString() ?? null,
    }
  }

  reconcile(actorUserId: string | null, signal?: AbortSignal): Promise<GrafanaOverview> {
    return this.serialized(async () => {
      await this.store.markPending(actorUserId)
      try {
        const { internalUrl, questdbUsername, questdbPassword } = this.config.grafana
        if (!internalUrl) throw new Error('Grafana internal URL is not configured')
        if (!questdbUsername || !questdbPassword) {
          throw new Error('Grafana QuestDB read-only credentials are not configured')
        }
        signal?.throwIfAborted()
        const anonymous = GrafanaApiClient.anonymous(internalUrl)
        const { version } = await anonymous.health()
        const client = await this.managementClient(internalUrl, await this.store.get())
        signal?.throwIfAborted()
        const pluginVersion = await client.pluginVersion(pluginId)
        const dataSourceInput: GrafanaDataSourceInput = {
          server: this.config.grafana.questdbServer,
          port: this.config.grafana.questdbPort,
          username: questdbUsername,
          password: questdbPassword,
        }
        const definitions = grafanaResourceDefinitions(dataSourceInput)
        await client.upsertDataSource(dataSourceInput)
        const dataSourceHealth = await client.dataSourceHealth()
        if (dataSourceHealth.status.toLowerCase() !== 'ok') {
          throw new Error(dataSourceHealth.message || 'The Grafana QuestDB datasource is unhealthy')
        }
        await this.store.saveResource(definitions[0]!)
        await client.ensureFolder()
        await this.store.saveResource(definitions[1]!)
        for (const definition of definitions.slice(2)) {
          signal?.throwIfAborted()
          await client.saveDashboard(definition)
          if (!(await client.dashboard(definition.uid))) {
            throw new Error(`Grafana did not retain dashboard ${definition.uid}`)
          }
          await this.store.saveResource(definition)
        }
        await this.store.markApplied(version, pluginVersion)
        await this.audit.writeAudit({
          actorUserId,
          action: 'grafana.reconciled',
          resourceType: 'grafana_workspace',
          resourceId: 'primary',
          outcome: 'success',
          metadata: {
            grafanaVersion: version,
            pluginVersion,
            dataSourceUid: GRAFANA_DATASOURCE_UID,
            dashboards: Object.values(GRAFANA_DASHBOARDS).map((item) => item.uid),
          },
        })
        return this.overview()
      } catch (error) {
        const failure = this.safeError(error)
        await this.store.markFailed(failure)
        await this.audit.writeAudit({
          actorUserId,
          action: 'grafana.reconciliation_failed',
          resourceType: 'grafana_workspace',
          resourceId: 'primary',
          outcome: 'failure',
          metadata: {},
        })
        throw new Error(failure, { cause: error })
      }
    })
  }

  private async managementClient(
    internalUrl: string,
    settings: StoredGrafanaSettings,
  ): Promise<GrafanaApiClient> {
    if (
      settings.token_key_version !== null &&
      settings.token_nonce &&
      settings.token_ciphertext &&
      settings.token_auth_tag
    ) {
      try {
        const token = this.tokenCrypto.decrypt('primary', {
          keyVersion: settings.token_key_version,
          nonce: settings.token_nonce,
          ciphertext: settings.token_ciphertext,
          authTag: settings.token_auth_tag,
        })
        const client = GrafanaApiClient.bearer(internalUrl, token)
        await client.verifyOrganizationAccess()
        return client
      } catch {
        // Create a replacement token with bootstrap access below.
      }
    }

    const { adminUsername, adminPassword } = this.config.grafana
    if (!adminUsername || !adminPassword) {
      throw new Error('Grafana bootstrap access is required to create a scoped service account')
    }
    const bootstrap = GrafanaApiClient.basic(internalUrl, adminUsername, adminPassword)
    let account = await bootstrap.findServiceAccount(serviceAccountName)
    account = account
      ? await bootstrap.updateServiceAccount(account.id, serviceAccountName)
      : await bootstrap.createServiceAccount(serviceAccountName)
    const token = await bootstrap.createServiceAccountToken(
      account.id,
      `pricklescope-controller-${Date.now()}`,
    )
    await this.store.saveServiceToken(
      account.id,
      token.id,
      this.tokenCrypto.encrypt('primary', token.key),
    )
    return GrafanaApiClient.bearer(internalUrl, token.key)
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private safeError(error: unknown): string {
    let result = error instanceof Error ? error.message : 'Grafana reconciliation failed'
    for (const secret of [this.config.grafana.adminPassword, this.config.grafana.questdbPassword]) {
      if (secret) result = result.replaceAll(secret, '[REDACTED]')
    }
    return result.slice(0, 2_000)
  }
}
