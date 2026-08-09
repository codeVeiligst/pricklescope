import type { SyncStatus, SyncTarget, SyncTargetKey } from '@pricklescope/contracts'

import type { JobStore } from '../jobs/store.js'
import type { SyncProbe } from './probe.js'

/** One reconciled engine: how to ask it about drift, and how to apply it. */
interface TargetDefinition {
  key: SyncTargetKey
  label: string
  jobType: string
  timeoutMs: number
  probe: () => Promise<SyncProbe>
}

export interface SyncDependencies {
  collectors: { pendingChange: () => Promise<SyncProbe> }
  grafana: { pendingChange: () => Promise<SyncProbe> }
  alerts: { pendingChange: () => Promise<SyncProbe> }
  storage: { pendingChange: () => Promise<SyncProbe> }
  jobs: JobStore
}

/**
 * Aggregates what every reconciled engine says about its own drift, and applies
 * the ones that have any.
 *
 * The controller owns desired state and the engines hold applied state, so the
 * two can diverge the moment anything is edited. This makes that divergence
 * visible in one place instead of leaving it to be discovered when an alert does
 * not fire or a device stops being polled.
 */
export class SyncService {
  private readonly targets: TargetDefinition[]

  constructor(private readonly dependencies: SyncDependencies) {
    this.targets = [
      {
        key: 'collectors',
        label: 'Collectors',
        jobType: 'collector.telegraf.reconcile',
        timeoutMs: 30_000,
        probe: () => dependencies.collectors.pendingChange(),
      },
      {
        key: 'storage',
        label: 'Storage',
        jobType: 'storage.questdb.reconcile',
        timeoutMs: 60_000,
        probe: () => dependencies.storage.pendingChange(),
      },
      {
        key: 'grafana',
        label: 'Grafana',
        jobType: 'grafana.reconcile',
        timeoutMs: 120_000,
        probe: () => dependencies.grafana.pendingChange(),
      },
      {
        key: 'alerts',
        label: 'Alerts',
        jobType: 'alerts.reconcile',
        timeoutMs: 120_000,
        probe: () => dependencies.alerts.pendingChange(),
      },
    ]
  }

  async status(): Promise<SyncStatus> {
    // One slow or broken engine must not hide the others, so a probe that throws
    // becomes a blocked target rather than a failed request.
    const results = await Promise.all(
      this.targets.map(async (target): Promise<SyncTarget> => {
        try {
          const probe = await target.probe()
          return {
            key: target.key,
            label: target.label,
            pending: probe.pending,
            detail: probe.detail,
            lastAppliedAt: probe.lastAppliedAt?.toISOString() ?? null,
            blocked: probe.blocked,
          }
        } catch (error) {
          return {
            key: target.key,
            label: target.label,
            pending: false,
            detail: 'The pending state could not be read',
            lastAppliedAt: null,
            blocked: error instanceof Error ? error.message : 'Unknown error',
          }
        }
      }),
    )
    return {
      pendingCount: results.filter((target) => target.pending).length,
      targets: results,
    }
  }

  /** Enqueues a reconcile for every target that has pending changes. */
  async apply(actorUserId: string) {
    const status = await this.status()
    const pending = new Set(
      status.targets.filter((target) => target.pending && !target.blocked).map((item) => item.key),
    )
    const jobs = []
    for (const target of this.targets) {
      if (!pending.has(target.key)) continue
      jobs.push(
        await this.dependencies.jobs.enqueue({
          type: target.jobType,
          payload: { actorUserId },
          requestedBy: actorUserId,
          timeoutMs: target.timeoutMs,
        }),
      )
    }
    return { jobs }
  }
}
