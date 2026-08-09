import { randomUUID } from 'node:crypto'

import type { Job } from '@pricklescope/contracts'
import type { Database } from '@pricklescope/db'
import type { Kysely, Selectable } from 'kysely'

type JobRow = Selectable<Database['jobs']>

export interface ClaimedJob {
  id: string
  type: string
  payload: Record<string, unknown>
  timeoutMs: number
}

function timestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    result: row.result,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    startedAt: timestamp(row.started_at),
    finishedAt: timestamp(row.finished_at),
  }
}

export class JobStore {
  constructor(private readonly db: Kysely<Database>) {}

  async enqueue(input: {
    type: string
    payload?: Record<string, unknown>
    requestedBy: string | null
    timeoutMs?: number
  }): Promise<Job> {
    const row = await this.db
      .insertInto('jobs')
      .values({
        id: randomUUID(),
        type: input.type,
        status: 'queued',
        payload: input.payload ?? {},
        result: null,
        error: null,
        requested_by: input.requestedBy,
        timeout_ms: input.timeoutMs ?? 30_000,
        started_at: null,
        finished_at: null,
        heartbeat_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toJob(row)
  }

  async list(limit = 25): Promise<Job[]> {
    const rows = await this.db
      .selectFrom('jobs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute()
    return rows.map(toJob)
  }

  async get(id: string): Promise<Job | null> {
    const row = await this.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toJob(row) : null
  }

  async claim(): Promise<ClaimedJob | null> {
    return this.db.transaction().execute(async (transaction) => {
      const next = await transaction
        .selectFrom('jobs')
        .select(['id', 'type', 'payload', 'timeout_ms'])
        .where('status', '=', 'queued')
        .orderBy('created_at', 'asc')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (!next) return null
      const updated = await transaction
        .updateTable('jobs')
        .set({
          status: 'running',
          started_at: new Date(),
          heartbeat_at: new Date(),
          attempts: (expression) => expression('attempts', '+', 1),
          progress: 0,
          error: null,
        })
        .where('id', '=', next.id)
        .where('status', '=', 'queued')
        .executeTakeFirst()
      if (Number(updated.numUpdatedRows) !== 1) return null
      return {
        id: next.id,
        type: next.type,
        payload: next.payload,
        timeoutMs: next.timeout_ms,
      }
    })
  }

  async progress(id: string, progress: number): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({ progress: Math.max(0, Math.min(99, Math.round(progress))), heartbeat_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .execute()
  }

  async succeed(id: string, result: object | null): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({
        status: 'succeeded',
        progress: 100,
        result,
        error: null,
        heartbeat_at: new Date(),
        finished_at: new Date(),
      })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .execute()
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({
        status: 'failed',
        error: error.slice(0, 2_000),
        heartbeat_at: new Date(),
        finished_at: new Date(),
      })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .execute()
  }

  async cancel(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('jobs')
      .set({ status: 'cancelled', error: null, finished_at: new Date() })
      .where('id', '=', id)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async recoverInterrupted(): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({
        status: 'failed',
        error: 'The worker stopped before this job completed',
        finished_at: new Date(),
      })
      .where('status', '=', 'running')
      .execute()
  }
}
