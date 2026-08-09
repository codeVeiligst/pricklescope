import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { createHarness, databaseUrl, type Harness } from './harness.js'

/**
 * The ceilings that keep one caller from consuming the installation.
 *
 * A monitoring controller answers requests that are expensive on purpose — SNMP
 * walks, QuestDB scans, reconciles against three engines. Every one of those has
 * to be bounded by something other than good manners.
 */

const suite = databaseUrl ? describe : describe.skip

suite('resource ceilings', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await createHarness()
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  describe('rate limiting', () => {
    it('meters the QuestDB-backed graph routes below the global ceiling', async () => {
      // Its own session, because exhausting a quota is the point and every later
      // test in this file would otherwise be measuring the throttle.
      const burner = await harness.disposableSession(harness.viewer)
      const statuses: number[] = []
      for (let index = 0; index < 130; index += 1) {
        const response = await harness.as(burner, {
          method: 'GET',
          url: '/api/v1/graphs/fleet',
        })
        statuses.push(response.statusCode)
        if (response.statusCode === 429) break
      }
      expect(
        statuses.at(-1),
        `the graph route never throttled in ${statuses.length} calls`,
      ).toBe(429)
      // 120 a minute: a dashboard redrawing cannot reach it, a script can.
      expect(statuses.length).toBeLessThanOrEqual(125)
      expect(statuses.length).toBeGreaterThan(100)
    }, 60_000)

    it('counts each session separately', async () => {
      // Otherwise one busy user throttles everyone, which turns a protection
      // into an outage.
      const other = await harness.as(harness.administrator, {
        method: 'GET',
        url: '/api/v1/graphs/fleet',
      })
      expect(other.statusCode, 'one session exhausting its quota throttled another').not.toBe(429)
    })

    it('publishes what the limit is', async () => {
      const response = await harness.as(harness.administrator, {
        method: 'GET',
        url: '/api/v1/sites',
      })
      expect(response.headers['x-ratelimit-limit']).toBeDefined()
      expect(response.headers['x-ratelimit-remaining']).toBeDefined()
    })
  })

  describe('bounded responses', () => {
    it('never returns an unbounded job list', async () => {
      // Jobs accumulate forever; the list must not grow with them.
      for (let index = 0; index < 40; index += 1) {
        await harness.metadata.db
          .insertInto('jobs')
          .values({
            id: randomUUID(),
            type: 'system.dependencies.check',
            status: 'succeeded',
            payload: {},
            result: null,
            progress: 100,
            attempts: 1,
            timeout_ms: 1000,
            requested_by: null,
            error: null,
          })
          .execute()
      }

      const response = await harness.as(harness.viewer, { method: 'GET', url: '/api/v1/jobs' })
      expect(response.statusCode).toBe(200)
      const { jobs } = response.json() as { jobs: unknown[] }
      expect(jobs.length).toBeLessThanOrEqual(25)
    }, 30_000)

    it('refuses a graph range wide enough to scan the whole store', async () => {
      const response = await harness.as(harness.viewer, {
        method: 'GET',
        url: '/api/v1/graphs/fleet?from=2000-01-01T00:00:00Z&to=2030-01-01T00:00:00Z',
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: 'range_invalid' })
    })

    it('refuses a range that is inverted or unparseable', async () => {
      for (const query of [
        'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
        'from=not-a-date&to=2026-01-01T00:00:00Z',
        'from=2026-01-01T00:00:00Z&to=not-a-date',
      ]) {
        const response = await harness.as(harness.viewer, {
          method: 'GET',
          url: `/api/v1/graphs/fleet?${query}`,
        })
        expect(response.statusCode, query).toBe(400)
      }
    })
  })

  describe('bounded work', () => {
    it('every QuestDB query carries a statement timeout and a row cap', () => {
      // The browser never reaches QuestDB, so these are the only limits on what
      // one request can ask the store to do.
      const config = loadConfig({
        PRICKLESCOPE_NODE_ENV: 'test',
        PRICKLESCOPE_DATABASE_URL: databaseUrl!,
      })
      expect(config.storage.statementTimeoutMs).toBeGreaterThan(0)
      expect(config.storage.statementTimeoutMs).toBeLessThanOrEqual(60_000)
      expect(config.storage.queryLimit).toBeGreaterThan(0)
      expect(config.storage.queryLimit).toBeLessThanOrEqual(10_000)
    })

    it('runs a bounded number of jobs at once', () => {
      const config = loadConfig({
        PRICKLESCOPE_NODE_ENV: 'test',
        PRICKLESCOPE_DATABASE_URL: databaseUrl!,
      })
      expect(config.jobs.concurrency).toBeGreaterThan(0)
      expect(config.jobs.concurrency).toBeLessThanOrEqual(16)
    })

    it('refuses configuration that would remove a ceiling', () => {
      // The bounds are enforced where they are read, not merely documented.
      for (const [key, value] of [
        ['PRICKLESCOPE_JOB_CONCURRENCY', '1000'],
        ['PRICKLESCOPE_QUESTDB_QUERY_LIMIT', '10000000'],
        ['PRICKLESCOPE_QUESTDB_STATEMENT_TIMEOUT_MS', '0'],
        ['PRICKLESCOPE_SESSION_TTL_SECONDS', '31536000'],
      ] as const) {
        expect(
          () =>
            loadConfig({
              PRICKLESCOPE_NODE_ENV: 'test',
              PRICKLESCOPE_DATABASE_URL: databaseUrl!,
              [key]: value,
            }),
          `${key}=${value} was accepted`,
        ).toThrow()
      }
    })
  })
})
