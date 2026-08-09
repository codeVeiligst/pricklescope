import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../config.js'
import { HealthService } from './service.js'

/**
 * `/health/ready` has no session to check — an orchestrator has none — and every
 * sweep queries PostgreSQL and reaches out to QuestDB, Grafana, and Telegraf. The
 * cache is what stops anyone who can reach the port from using the controller to
 * hammer its own dependencies.
 */
function service(clock: { now: number }): { health: HealthService; queries: () => number } {
  let queries = 0
  const pool = {
    query: () => {
      queries += 1
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Pool
  const config = loadConfig({
    PRICKLESCOPE_NODE_ENV: 'test',
    PRICKLESCOPE_DATABASE_URL: 'postgresql://localhost:5432/pricklescope_test',
  })
  return { health: new HealthService(pool, config, () => clock.now), queries: () => queries }
}

describe('dependency health is measured, not re-measured on demand', () => {
  it('reuses one sweep for repeated calls inside the window', async () => {
    const clock = { now: 1_000 }
    const { health, queries } = service(clock)

    await health.check()
    await health.check()
    await health.check()

    expect(queries()).toBe(1)
  })

  it('sweeps again once the window has passed', async () => {
    const clock = { now: 1_000 }
    const { health, queries } = service(clock)

    await health.check()
    clock.now += 5_001
    await health.check()

    expect(queries()).toBe(2)
  })

  it('coalesces callers that arrive while a sweep is running', async () => {
    const clock = { now: 1_000 }
    const { health, queries } = service(clock)

    await Promise.all([health.check(), health.check(), health.check()])

    expect(queries()).toBe(1)
  })
})
