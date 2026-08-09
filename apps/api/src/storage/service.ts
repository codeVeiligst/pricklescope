import type {
  StorageCapability,
  StorageOverview,
  StoragePolicy,
  UpdateStoragePolicyRequest,
} from '@pricklescope/contracts'

import type { AuthStore } from '../auth/store.js'
import { HttpError } from '../errors.js'
import type { SyncProbe } from '../sync/probe.js'
import type { QuestDbClient } from './questdb.js'
import type { StorageStore, StoredStorageSettings } from './store.js'

const capabilities: StorageCapability[] = [
  {
    key: 'counter64',
    label: 'Lossless Counter64',
    status: 'passed',
    evidence: 'Full unsigned range preserved in DECIMAL(20,0) through Telegraf conversion.',
  },
  {
    key: 'normalization',
    label: 'Reset-aware rates',
    status: 'passed',
    evidence: 'Reset, reboot, rollover, and discontinuity cases are explicitly classified.',
  },
  {
    key: 'retention',
    label: 'Independent retention',
    status: 'passed',
    evidence: 'Raw, 5-minute, and hourly partitions each carry their own TTL.',
  },
  {
    key: 'bounded-query',
    label: 'Scoped query adapter',
    status: 'operational',
    evidence: 'PGWire statements have timeouts, bind values, and hard result limits.',
  },
  {
    key: 'interruption',
    label: 'Buffered recovery',
    status: 'passed',
    evidence: 'A targeted storage restart retained data and Telegraf resumed buffered writes.',
  },
  {
    key: 'benchmark',
    label: 'Representative load',
    status: 'passed',
    evidence: 'One million raw samples and both rollup tiers completed the reproducible benchmark.',
  },
  {
    key: 'backup',
    label: 'OSS restore drill',
    status: 'passed',
    evidence: 'A checkpoint root copy restored into an isolated volume with exact counters intact.',
  },
]

function policy(settings: StoredStorageSettings): StoragePolicy {
  return {
    rawRetentionDays: settings.raw_retention_days,
    fiveMinuteRetentionDays: settings.five_minute_retention_days,
    hourlyRetentionDays: settings.hourly_retention_days,
  }
}

export class StorageService {
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: StorageStore,
    private readonly questdb: QuestDbClient | null,
    private readonly audit: AuthStore,
  ) {}

  async overview(): Promise<StorageOverview> {
    const settings = await this.store.get()
    let connection: StorageOverview['connection'] = this.questdb ? 'down' : 'disabled'
    let connectionMessage: string | null = this.questdb
      ? 'QuestDB did not answer the last status request'
      : 'QuestDB controller credentials are not configured'
    let tables: StorageOverview['tables'] = []
    if (this.questdb) {
      try {
        const [version, tableState] = await Promise.all([
          this.questdb.check(),
          this.questdb.tables(),
        ])
        connection = 'up'
        connectionMessage = version
        tables = tableState
      } catch {
        // Connection details stay server-side; the status intentionally remains concise.
      }
    }
    return {
      engine: 'questdb',
      decision: 'accepted',
      decisionSummary:
        'Accepted for the initial release with a controller-owned schema and lossless counter conversion.',
      connection,
      connectionMessage,
      policy: policy(settings),
      policyStatus: settings.status,
      policyError: settings.error,
      revision: settings.revision,
      updatedAt: settings.updated_at.toISOString(),
      appliedAt: settings.applied_at?.toISOString() ?? null,
      tables,
      capabilities,
    }
  }

  /**
   * Whether applying would change QuestDB. The policy carries its own applied
   * marker, so this is a direct comparison rather than an inference.
   */
  async pendingChange(): Promise<SyncProbe> {
    const settings = await this.store.get()
    if (!this.questdb) {
      return {
        pending: false,
        detail: 'QuestDB is not configured',
        lastAppliedAt: settings.applied_at,
        blocked: 'QuestDB controller credentials are not configured',
      }
    }
    if (settings.status === 'active' && settings.applied_at) {
      return {
        pending: false,
        detail: `Revision ${settings.revision} is applied`,
        lastAppliedAt: settings.applied_at,
        blocked: null,
      }
    }
    return {
      pending: true,
      detail:
        settings.status === 'failed'
          ? 'The last apply failed'
          : `Retention revision ${settings.revision} has not been applied`,
      lastAppliedAt: settings.applied_at,
      blocked: null,
    }
  }

  async updatePolicy(
    request: UpdateStoragePolicyRequest,
    actorUserId: string,
  ): Promise<StoredStorageSettings> {
    const current = await this.store.get()
    const shortened =
      request.rawRetentionDays < current.raw_retention_days ||
      request.fiveMinuteRetentionDays < current.five_minute_retention_days ||
      request.hourlyRetentionDays < current.hourly_retention_days
    if (shortened && !request.confirmShortening) {
      throw new HttpError(
        409,
        'retention_confirmation_required',
        'Shortening retention can delete expired partitions and requires confirmation',
      )
    }
    const updated = await this.store.update(request, actorUserId)
    await this.audit.writeAudit({
      actorUserId,
      action: 'storage.policy.updated',
      resourceType: 'storage_policy',
      resourceId: 'primary',
      outcome: 'success',
      metadata: { ...policy(updated), shortened, revision: updated.revision },
    })
    return updated
  }

  reconcile(actorUserId: string | null, signal?: AbortSignal): Promise<StoragePolicy> {
    return this.serialized(async () => {
      const settings = await this.store.get()
      try {
        if (!this.questdb) throw new Error('QuestDB controller credentials are not configured')
        signal?.throwIfAborted()
        await this.questdb.reconcile(policy(settings))
        signal?.throwIfAborted()
        await this.store.markApplied()
        await this.audit.writeAudit({
          actorUserId,
          action: 'storage.questdb.reconciled',
          resourceType: 'storage_policy',
          resourceId: 'primary',
          outcome: 'success',
          metadata: { ...policy(settings), revision: settings.revision },
        })
        return policy(settings)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'QuestDB reconciliation failed'
        await this.store.markFailed(message)
        await this.audit.writeAudit({
          actorUserId,
          action: 'storage.questdb.reconciliation_failed',
          resourceType: 'storage_policy',
          resourceId: 'primary',
          outcome: 'failure',
          metadata: { revision: settings.revision },
        })
        throw error
      }
    })
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
