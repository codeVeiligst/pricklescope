import { hostname } from 'node:os'

import type { FastifyBaseLogger } from 'fastify'

import type { AppConfig } from '../config.js'
import type { ControllerHealthRow, QuestDbClient } from '../storage/questdb.js'
import type { HealthService } from './service.js'

/**
 * Records the controller's own dependency sweep into QuestDB so that Grafana can
 * alert on it (D-041).
 *
 * Grafana evaluates every rule as SQL against QuestDB (D-021), so anything it is
 * to alert on has to be a row in QuestDB. The sweep was only ever a response body
 * and a screen, which is why nothing watched the controller: a dependency could
 * drop and the only way to find out was to look.
 *
 * Two failures this deliberately does not try to record, because it cannot:
 *
 *   QuestDB down       the write fails, so there is no row to say so. Grafana's
 *                      own datasource error covers it — the health rules set
 *                      execErrorState to Alerting, so a rule that cannot query
 *                      fires instead of going quiet.
 *   controller down    nothing writes at all. The rules set noDataState to
 *                      Alerting for the same reason: silence is the symptom.
 *
 * Both are the point rather than an oversight. A monitor that can only report
 * failures it survives is not much of a monitor.
 */

/**
 * Chosen against the alert window rather than for its own sake: the built-in
 * rules look back five minutes, so a missed write or two must not read as a
 * gap. The sweep behind it is cached, so this costs one cached read.
 */
const RECORD_INTERVAL_MS = 30_000

export class HealthRecorder {
  private timer: NodeJS.Timeout | null = null
  private writing = false

  constructor(
    private readonly health: HealthService,
    private readonly questdb: QuestDbClient | null,
    private readonly config: AppConfig,
    private readonly logger: FastifyBaseLogger,
    private readonly intervalMs: number = RECORD_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer || !this.questdb) return
    // Once immediately, so a restart does not leave a gap the length of the
    // interval — which the alert rules would read as the controller being gone.
    void this.record()
    this.timer = setInterval(() => void this.record(), this.intervalMs)
    // Nothing here should hold the process open at shutdown.
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Exposed for tests and for the first write at startup. */
  async record(): Promise<void> {
    if (!this.questdb || this.writing) return
    this.writing = true
    try {
      const sweep = await this.health.check()
      const at = new Date(sweep.checkedAt)
      const rows: ControllerHealthRow[] = sweep.dependencies.map((dependency) => ({
        timestamp: at,
        environment: this.config.environment,
        host: hostname(),
        version: sweep.version,
        dependency: dependency.name,
        state: dependency.state,
        critical: dependency.critical,
        latencyMs: dependency.latencyMs,
        // Truncated because a driver error can be very long and this column is
        // read by people, not parsed.
        message: dependency.message === null ? null : dependency.message.slice(0, 240),
      }))
      await this.questdb.recordHealth(rows)
    } catch (error) {
      // Never throws. A controller that fell over because it could not write
      // down that something else had fallen over would be a poor trade.
      this.logger.warn({ err: error }, 'could not record controller health')
    } finally {
      this.writing = false
    }
  }
}
