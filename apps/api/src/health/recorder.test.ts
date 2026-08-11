import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../config.js'
import type { ControllerHealthRow, QuestDbClient } from '../storage/questdb.js'
import { HealthRecorder } from './recorder.js'
import type { HealthService } from './service.js'

const config = loadConfig({
  PRICKLESCOPE_NODE_ENV: 'test',
  PRICKLESCOPE_DATABASE_URL: 'postgresql://localhost:5432/pricklescope_test',
})

const logger = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger

function sweep(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: 'degraded',
    version: '1.2.3',
    uptimeSeconds: 10,
    checkedAt: '2026-08-11T07:00:00.000Z',
    dependencies: [
      {
        name: 'PostgreSQL',
        state: 'up',
        critical: true,
        latencyMs: 3,
        message: null,
        checkedAt: '2026-08-11T07:00:00.000Z',
      },
      {
        name: 'Grafana',
        state: 'down',
        critical: false,
        latencyMs: 40,
        message: 'fetch failed',
        checkedAt: '2026-08-11T07:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

function recorder(options: {
  check?: () => Promise<unknown>
  record?: (rows: ControllerHealthRow[]) => Promise<void>
  questdb?: QuestDbClient | null
}) {
  const written: ControllerHealthRow[][] = []
  const questdb =
    options.questdb === null
      ? null
      : ({
          recordHealth:
            options.record ??
            ((rows: ControllerHealthRow[]) => {
              written.push(rows)
              return Promise.resolve()
            }),
        } as unknown as QuestDbClient)
  const health = {
    check: options.check ?? (() => Promise.resolve(sweep())),
  } as unknown as HealthService
  return { instance: new HealthRecorder(health, questdb, config, logger), written }
}

describe('HealthRecorder', () => {
  it('writes one row per dependency, carrying the state a rule has to read', async () => {
    const { instance, written } = recorder({})
    await instance.record()

    expect(written).toHaveLength(1)
    expect(written[0]?.map((row) => [row.dependency, row.state, row.critical])).toEqual([
      ['PostgreSQL', 'up', true],
      ['Grafana', 'down', false],
    ])
    expect(written[0]?.[0]?.timestamp.toISOString()).toBe('2026-08-11T07:00:00.000Z')
  })

  /**
   * The controller exists to notice things falling over. One that fell over
   * itself because it could not write down that something else had would be a
   * poor trade — and QuestDB being unreachable is exactly when this runs.
   */
  it('never throws when the write fails', async () => {
    const { instance } = recorder({
      record: () => Promise.reject(new Error('QuestDB is unreachable')),
    })
    await expect(instance.record()).resolves.toBeUndefined()
  })

  it('never throws when the sweep itself fails', async () => {
    const { instance } = recorder({ check: () => Promise.reject(new Error('sweep exploded')) })
    await expect(instance.record()).resolves.toBeUndefined()
  })

  it('does nothing at all when QuestDB is not configured', async () => {
    const { instance } = recorder({ questdb: null })
    await expect(instance.record()).resolves.toBeUndefined()
    instance.start()
    instance.stop()
  })

  /**
   * A slow write must not queue behind itself. Left unguarded, a QuestDB that
   * takes longer than the interval to answer would accumulate one outstanding
   * write per tick for as long as it stayed slow.
   */
  it('skips a tick while the previous write is still going', async () => {
    let release: (() => void) | undefined
    let calls = 0
    const { instance } = recorder({
      record: () => {
        calls += 1
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    const first = instance.record()
    // Let the first call get as far as the write before asserting anything about
    // it. Without this the assertion runs while nothing is in flight yet, and
    // the release below has nothing to release.
    for (let i = 0; i < 20 && !release; i += 1) await Promise.resolve()
    expect(calls).toBe(1)

    await instance.record()
    expect(calls).toBe(1)

    release?.()
    await first

    // Started, not awaited: this write hangs too, by construction. Awaiting it
    // is what made the first version of this test time out rather than fail.
    void instance.record()
    for (let i = 0; i < 20 && calls < 2; i += 1) await Promise.resolve()
    expect(calls).toBe(2)
    release?.()
  })

  it('truncates a driver error rather than storing all of it', async () => {
    const { instance, written } = recorder({
      check: () =>
        Promise.resolve(
          sweep({
            dependencies: [
              {
                name: 'QuestDB',
                state: 'down',
                critical: false,
                latencyMs: null,
                message: 'x'.repeat(1000),
                checkedAt: '2026-08-11T07:00:00.000Z',
              },
            ],
          }),
        ),
    })
    await instance.record()
    expect(written[0]?.[0]?.message).toHaveLength(240)
  })
})
