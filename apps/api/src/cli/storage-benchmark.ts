import { performance } from 'node:perf_hooks'

import { Pool } from 'pg'

import { loadConfig, loadEnvironmentFile } from '../config.js'

const rowTarget = 1_000_000
const keep = process.argv.includes('--keep')
const tables = [
  '_pricklescope_benchmark',
  '_pricklescope_benchmark_5m',
  '_pricklescope_benchmark_1h',
] as const

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(2))
}

async function run(): Promise<void> {
  loadEnvironmentFile()
  const config = loadConfig()
  if (!config.storage.questdbDatabaseUrl) {
    throw new Error('PRICKLESCOPE_QUESTDB_DATABASE_URL is required')
  }
  const pool = new Pool({
    connectionString: config.storage.questdbDatabaseUrl,
    application_name: 'pricklescope-storage-benchmark',
    max: 1,
    options: '-c statement_timeout=120000',
  })
  const drop = async (): Promise<void> => {
    await pool.query('drop materialized view if exists _pricklescope_benchmark_5m')
    await pool.query('drop materialized view if exists _pricklescope_benchmark_1h')
    await pool.query('drop table if exists _pricklescope_benchmark')
  }

  try {
    await drop()
    await pool.query(`
      create table _pricklescope_benchmark (
        timestamp timestamp, source_id symbol, check_id symbol, if_index symbol,
        inbound double, outbound double
      ) timestamp(timestamp) partition by day ttl 30 days wal
    `)
    await pool.query(`
      create materialized view _pricklescope_benchmark_5m as (
        select timestamp, source_id, check_id, if_index,
          avg(inbound) inbound, avg(outbound) outbound, count() samples
        from _pricklescope_benchmark sample by 5m
      ) partition by day ttl 365 days
    `)
    await pool.query(`
      create materialized view _pricklescope_benchmark_1h as (
        select timestamp, source_id, check_id, if_index,
          avg(inbound) inbound, avg(outbound) outbound, count() samples
        from _pricklescope_benchmark sample by 1h
      ) partition by day ttl 1825 days
    `)

    const firstTimestamp = new Date(Date.now() - rowTarget * 1_000).toISOString()
    const writeStarted = performance.now()
    await pool.query(`
      insert into _pricklescope_benchmark
      select timestamp_sequence('${firstTimestamp}', 1000000L) timestamp,
        'benchmark-source' source_id, 'benchmark-check' check_id,
        cast(x % 64 as string) if_index,
        cast(x % 100000 as double) inbound,
        cast(x % 80000 as double) outbound
      from long_sequence(${rowTarget})
    `)
    const writeAcceptedMs = elapsed(writeStarted)

    const visibleStarted = performance.now()
    let rowCounts: Record<string, number> = {}
    while (performance.now() - visibleStarted < 120_000) {
      const result = await pool.query<{ table_name: string; table_row_count: string }>(`
        select table_name, table_row_count from tables()
        where table_name in ('${tables.join("', '")}')
        limit ${tables.length}
      `)
      rowCounts = Object.fromEntries(
        result.rows.map((row) => [row.table_name, Number(row.table_row_count)]),
      )
      if (
        rowCounts._pricklescope_benchmark === rowTarget &&
        (rowCounts._pricklescope_benchmark_5m ?? 0) > 0 &&
        (rowCounts._pricklescope_benchmark_1h ?? 0) > 0
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (rowCounts._pricklescope_benchmark !== rowTarget) {
      throw new Error(
        `Only ${rowCounts._pricklescope_benchmark ?? 0} benchmark rows became visible`,
      )
    }
    const visibleWithRollupsMs = elapsed(visibleStarted)

    const query = async (table: string): Promise<number> => {
      const started = performance.now()
      await pool.query(
        `
        select avg(inbound), avg(outbound), max(inbound), max(outbound)
        from ${table} where source_id = $1
      `,
        ['benchmark-source'],
      )
      return elapsed(started)
    }
    const rawQueryMs = await query('_pricklescope_benchmark')
    const fiveMinuteQueryMs = await query('_pricklescope_benchmark_5m')
    const hourlyQueryMs = await query('_pricklescope_benchmark_1h')

    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          rowCounts,
          writeAcceptedMs,
          visibleWithRollupsMs,
          acceptedRowsPerSecond: Math.round(rowTarget / (writeAcceptedMs / 1_000)),
          rawQueryMs,
          fiveMinuteQueryMs,
          hourlyQueryMs,
          retainedForInspection: keep,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    if (!keep) await drop()
    await pool.end()
  }
}

await run()
