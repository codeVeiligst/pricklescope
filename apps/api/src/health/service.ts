import { performance } from 'node:perf_hooks'

import { checkHttpDependency, checkTcpDependency } from '@pricklescope/adapters'
import type { DependencyHealth, SystemHealth } from '@pricklescope/contracts'
import type { Pool } from 'pg'

import type { AppConfig } from '../config.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : 'Unknown PostgreSQL error'
}

/**
 * How long one dependency sweep is reused. `/health/ready` is unauthenticated by
 * necessity — an orchestrator has no session — and each sweep queries PostgreSQL
 * and opens connections to QuestDB, Grafana, and Telegraf. Without this, anyone
 * who can reach the port can make the controller hammer its own dependencies at
 * whatever rate they like. A readiness probe runs every few seconds anyway, so
 * reusing a result for two of them costs nothing, and `checkedAt` says plainly
 * how old the answer is.
 */
const HEALTH_CACHE_MS = 5_000

export class HealthService {
  private cached: { result: SystemHealth; at: number } | null = null
  private inFlight: Promise<SystemHealth> | null = null

  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private async postgres(): Promise<DependencyHealth> {
    const startedAt = performance.now()
    const checkedAt = new Date().toISOString()
    try {
      await this.pool.query('select 1')
      return {
        name: 'PostgreSQL',
        state: 'up',
        critical: true,
        latencyMs: Math.round(performance.now() - startedAt),
        message: null,
        checkedAt,
      }
    } catch (error) {
      return {
        name: 'PostgreSQL',
        state: 'down',
        critical: true,
        latencyMs: Math.round(performance.now() - startedAt),
        message: errorMessage(error),
        checkedAt,
      }
    }
  }

  async check(): Promise<SystemHealth> {
    const cached = this.cached
    if (cached && this.now() - cached.at < HEALTH_CACHE_MS) return cached.result
    // Concurrent callers share one sweep rather than each starting their own.
    this.inFlight ??= this.sweep().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async sweep(): Promise<SystemHealth> {
    const dependencies = await Promise.all([
      this.postgres(),
      checkHttpDependency(this.config.dependencies.questdbHealthUrl, { name: 'QuestDB' }),
      checkHttpDependency(this.config.dependencies.grafanaHealthUrl, { name: 'Grafana' }),
      checkTcpDependency(
        this.config.dependencies.telegrafHost,
        this.config.dependencies.telegrafPort,
        { name: 'Telegraf' },
      ),
    ])
    const criticalDown = dependencies.some(
      (dependency) => dependency.critical && dependency.state === 'down',
    )
    const anyDown = dependencies.some((dependency) => dependency.state === 'down')
    const result: SystemHealth = {
      status: criticalDown ? 'unavailable' : anyDown ? 'degraded' : 'healthy',
      version: this.config.version,
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      dependencies,
    }
    this.cached = { result, at: this.now() }
    return result
  }
}
