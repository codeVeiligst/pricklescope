import type { StoragePolicy, StorageTable } from '@pricklescope/contracts'
import { Pool, types as pgTypes, type PoolConfig, type QueryResultRow } from 'pg'

// QuestDB stores UTC and returns TIMESTAMP without a zone marker. node-postgres
// would read that in the API process's local zone, shifting every sample by the
// host offset, so a chart drawn in Brussels claimed data two hours older than it
// was. Parse it as UTC explicitly. Scoped to this pool: the PostgreSQL metadata
// connection keeps the driver's own parsers.
export function parseUtcTimestamp(value: string): Date {
  const isoLike = value.includes('T') ? value : value.replace(' ', 'T')
  return new Date(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`)
}

// The driver's own parser table is untyped, so the cast is confined here.
const TIMESTAMP_OID: number = pgTypes.builtins.TIMESTAMP

const questdbTypeParsers: NonNullable<PoolConfig['types']> = {
  getTypeParser: ((oid: number, format?: string) =>
    oid === TIMESTAMP_OID
      ? parseUtcTimestamp
      : (pgTypes.getTypeParser as (id: number, encoding?: string) => (value: string) => unknown)(
          oid,
          format,
        )) as NonNullable<PoolConfig['types']>['getTypeParser'],
}

const rawTables = [
  'network_system',
  'network_interface',
  'network_interface_rate',
  'network_availability',
  'collector_health',
] as const
const fiveMinuteViews = ['network_interface_rate_5m', 'network_availability_5m'] as const
const hourlyViews = ['network_interface_rate_1h', 'network_availability_1h'] as const
const managedTables = [...rawTables, ...fiveMinuteViews, ...hourlyViews] as const

const identityColumns = `
  environment symbol,
  collector symbol,
  host symbol,
  source symbol,
  source_id symbol,
  check_id symbol,
  source_name symbol,
  site_id symbol,
  source_tags symbol`

const rawDefinitions = [
  `create table if not exists network_system (
    timestamp timestamp,
    ${identityColumns},
    sys_name symbol,
    sys_description string,
    sys_object_id string,
    sys_uptime long
  ) timestamp(timestamp) partition by day ttl {raw} days wal`,
  `create table if not exists network_interface (
    timestamp timestamp,
    ${identityColumns},
    if_index symbol,
    if_description symbol,
    if_type long,
    if_mtu long,
    if_speed long,
    if_admin_status long,
    if_oper_status long,
    if_counter_discontinuity_time long,
    if_in_octets decimal(20,0),
    if_out_octets decimal(20,0),
    if_in_errors decimal(20,0),
    if_out_errors decimal(20,0)
  ) timestamp(timestamp) partition by day ttl {raw} days wal`,
  `create table if not exists network_interface_rate (
    timestamp timestamp,
    ${identityColumns},
    if_index symbol,
    if_description symbol,
    if_in_octets_per_second double,
    if_out_octets_per_second double,
    if_in_errors_per_second double,
    if_out_errors_per_second double
  ) timestamp(timestamp) partition by day ttl {raw} days wal`,
  `create table if not exists network_availability (
    timestamp timestamp,
    ${identityColumns},
    url symbol,
    packets_transmitted long,
    packets_received long,
    percent_packet_loss double,
    minimum_response_ms double,
    average_response_ms double,
    maximum_response_ms double,
    standard_deviation_ms double,
    ttl long,
    result_code long
  ) timestamp(timestamp) partition by day ttl {raw} days wal`,
  // Written by the `internal` input in the managed collector configuration, and
  // by nothing else. These columns are what Telegraf 1.39 actually emits, read
  // off a running collector rather than taken from its documentation: the
  // previous declaration invented `component`, `state`, `buffered_metrics`, and
  // `dropped_metrics`, none of which any version of Telegraf produces. Nothing
  // wrote this table at all, so nothing noticed.
  //
  // Five row shapes share it, told apart by which tag is set:
  //   input      — one gathering plugin
  //   output     — one writing plugin
  //   processor  — one processor
  //   type       — one parser
  //   go_version — the agent total, and the only row carrying both error counts
  //
  // `go_version` is the discriminator for that last one because it is the only
  // tag unique to it. "neither input nor output" looks like it should work and
  // does not: the processor and parser rows have neither either.
  `create table if not exists collector_health (
    timestamp timestamp,
    environment symbol,
    collector symbol,
    host symbol,
    version symbol,
    go_version symbol,
    input symbol,
    output symbol,
    processor symbol,
    type symbol,
    startup_errors long,
    errors long,
    gather_errors long,
    write_errors long,
    metrics_gathered long,
    metrics_written long,
    metrics_dropped long,
    metrics_rejected long,
    metrics_filtered long,
    metrics_added long,
    metrics_parsed long,
    gather_time_ns long,
    gather_timeouts long,
    write_time_ns long,
    parse_time_ns long,
    buffer_size long,
    buffer_limit long
  ) timestamp(timestamp) partition by day ttl {raw} days wal`,
] as const

const viewDefinitions = [
  `create materialized view if not exists network_interface_rate_5m as (
    select timestamp, source_id, check_id, if_index,
      avg(if_in_octets_per_second) if_in_octets_per_second,
      avg(if_out_octets_per_second) if_out_octets_per_second,
      max(if_in_octets_per_second) if_in_octets_peak_per_second,
      max(if_out_octets_per_second) if_out_octets_peak_per_second,
      avg(if_in_errors_per_second) if_in_errors_per_second,
      avg(if_out_errors_per_second) if_out_errors_per_second,
      count() samples
    from network_interface_rate sample by 5m
  ) partition by day ttl {five} days`,
  `create materialized view if not exists network_interface_rate_1h as (
    select timestamp, source_id, check_id, if_index,
      avg(if_in_octets_per_second) if_in_octets_per_second,
      avg(if_out_octets_per_second) if_out_octets_per_second,
      max(if_in_octets_per_second) if_in_octets_peak_per_second,
      max(if_out_octets_per_second) if_out_octets_peak_per_second,
      avg(if_in_errors_per_second) if_in_errors_per_second,
      avg(if_out_errors_per_second) if_out_errors_per_second,
      count() samples
    from network_interface_rate sample by 1h
  ) partition by day ttl {hourly} days`,
  `create materialized view if not exists network_availability_5m as (
    select timestamp, source_id, check_id,
      avg(100.0 - percent_packet_loss) availability_percent,
      avg(average_response_ms) average_response_ms,
      max(maximum_response_ms) maximum_response_ms,
      count() samples
    from network_availability sample by 5m
  ) partition by day ttl {five} days`,
  `create materialized view if not exists network_availability_1h as (
    select timestamp, source_id, check_id,
      avg(100.0 - percent_packet_loss) availability_percent,
      avg(average_response_ms) average_response_ms,
      max(maximum_response_ms) maximum_response_ms,
      count() samples
    from network_availability sample by 1h
  ) partition by day ttl {hourly} days`,
] as const

interface TableMetadataRow extends QueryResultRow {
  table_name: string
  partitionBy: string | null
  walEnabled: boolean
  ttlValue: number
  ttlUnit: string
  matView: boolean
  table_row_count: string
}

export interface GraphRangeQuery {
  from: Date
  to: Date
  sourceId?: string
}

// Roughly 200 buckets across the requested range, snapped to a readable step.
// The literal is built here, never interpolated from user input.
const BUCKET_STEPS = [
  [60, '1m'],
  [300, '5m'],
  [900, '15m'],
  [1_800, '30m'],
  [3_600, '1h'],
  [21_600, '6h'],
  [86_400, '1d'],
] as const

// A row-height chart is narrow, so it needs fewer points than a full panel. The
// row cap bounds the response for a device with many interfaces.
const ROW_CHART_BUCKETS = 48
const ROW_CHART_ROW_CAP = 6000

export function bucket(range: { from: Date; to: Date }, targetBuckets = 200): string {
  const seconds = Math.max(1, (range.to.getTime() - range.from.getTime()) / 1000 / targetBuckets)
  for (const [step, label] of BUCKET_STEPS) {
    if (seconds <= step) return label
  }
  return BUCKET_STEPS[BUCKET_STEPS.length - 1]![1]
}

export interface AvailabilityRow extends QueryResultRow {
  timestamp: Date
  source_name: string
  availability: number | null
}

export interface LatencyRow extends QueryResultRow {
  timestamp: Date
  average_response_ms: number | null
  maximum_response_ms: number | null
}

export interface TrafficRow extends QueryResultRow {
  timestamp: Date
  if_description: string | null
  if_index: string
  inbound_bps: number | null
  outbound_bps: number | null
}

export interface LatestSourceRow extends QueryResultRow {
  source_name: string
  source_id: string
  site_id: string | null
  last_seen: Date
}

function days(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 36_500) {
    throw new Error('QuestDB TTL is outside the supported range')
  }
  return value
}

function definition(template: string, policy: StoragePolicy): string {
  return template
    .replace('{raw}', String(days(policy.rawRetentionDays)))
    .replace('{five}', String(days(policy.fiveMinuteRetentionDays)))
    .replace('{hourly}', String(days(policy.hourlyRetentionDays)))
}

export class QuestDbClient {
  private readonly pool: Pool

  constructor(
    databaseUrl: string,
    statementTimeoutMs: number,
    private readonly queryLimit: number,
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      types: questdbTypeParsers,
      application_name: 'pricklescope-storage-controller',
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      options: `-c statement_timeout=${statementTimeoutMs}`,
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async check(): Promise<string> {
    const result = await this.pool.query<{ 'version()': string }>('select version()')
    return result.rows[0]?.['version()'] ?? 'QuestDB'
  }

  async reconcile(policy: StoragePolicy): Promise<void> {
    for (const template of rawDefinitions) await this.pool.query(definition(template, policy))
    for (const template of viewDefinitions) await this.pool.query(definition(template, policy))
    for (const table of rawTables) {
      await this.pool.query(`alter table ${table} set ttl ${days(policy.rawRetentionDays)} days`)
    }
    for (const view of fiveMinuteViews) {
      await this.pool.query(
        `alter materialized view ${view} set ttl ${days(policy.fiveMinuteRetentionDays)} days`,
      )
    }
    for (const view of hourlyViews) {
      await this.pool.query(
        `alter materialized view ${view} set ttl ${days(policy.hourlyRetentionDays)} days`,
      )
    }
  }

  async tables(): Promise<StorageTable[]> {
    const names = managedTables.map((name) => `'${name}'`).join(', ')
    const result = await this.pool.query<TableMetadataRow>(`
      select table_name, "partitionBy", "walEnabled", "ttlValue", "ttlUnit",
        "matView", table_row_count
      from tables()
      where table_name in (${names})
      limit ${managedTables.length}
    `)
    const found = new Map(result.rows.map((row) => [row.table_name, row]))
    return managedTables.map((name) => {
      const row = found.get(name)
      const tier = rawTables.includes(name as (typeof rawTables)[number])
        ? 'raw'
        : fiveMinuteViews.includes(name as (typeof fiveMinuteViews)[number])
          ? '5m'
          : '1h'
      return {
        name,
        tier,
        exists: Boolean(row),
        materializedView: row?.matView ?? false,
        walEnabled: row?.walEnabled ?? false,
        partitionBy: row?.partitionBy ?? null,
        ttlValue: row ? Number(row.ttlValue) : null,
        ttlUnit: row?.ttlUnit ?? null,
        rowCount: row ? Number(row.table_row_count) : null,
      }
    })
  }

  // These mirror the panels the controller provisions in Grafana, so the two
  // views of the same measurement cannot drift apart. Each one downsamples in
  // QuestDB the way Grafana's $__interval does, so a wide range returns a bounded
  // number of buckets instead of every raw sample.
  async availabilitySeries(input: GraphRangeQuery): Promise<AvailabilityRow[]> {
    const scoped = input.sourceId ? 'and source_id = $3' : ''
    const parameters: unknown[] = [input.from, input.to]
    if (input.sourceId) parameters.push(input.sourceId)
    const result = await this.pool.query<AvailabilityRow>(
      `select timestamp, source_name, avg(100.0 - percent_packet_loss) as availability
       from network_availability
       where timestamp >= $1 and timestamp < $2 ${scoped}
       sample by ${bucket(input)} align to calendar
       order by timestamp
       limit ${this.queryLimit}`,
      parameters,
    )
    return result.rows
  }

  async latencySeries(input: GraphRangeQuery & { sourceId: string }): Promise<LatencyRow[]> {
    const result = await this.pool.query<LatencyRow>(
      `select timestamp, avg(average_response_ms) as average_response_ms,
        max(maximum_response_ms) as maximum_response_ms
       from network_availability
       where source_id = $1 and timestamp >= $2 and timestamp < $3
       sample by ${bucket(input)} align to calendar
       order by timestamp
       limit ${this.queryLimit}`,
      [input.sourceId, input.from, input.to],
    )
    return result.rows
  }

  // Busy devices have far more interfaces than a chart can carry, so the panel
  // shows the busiest few and Grafana keeps the rest behind its interface variable.
  async busiestInterfaces(
    input: GraphRangeQuery & { sourceId: string },
    count: number,
  ): Promise<string[]> {
    const result = await this.pool.query<{ if_index: string }>(
      `select if_index, max(if_in_octets_per_second + if_out_octets_per_second) as busy
       from network_interface_rate
       where source_id = $1 and timestamp >= $2 and timestamp < $3
       order by busy desc
       limit ${Math.max(1, Math.min(count, 12))}`,
      [input.sourceId, input.from, input.to],
    )
    return result.rows.map((row) => row.if_index)
  }

  async trafficSeries(
    input: GraphRangeQuery & { sourceId: string },
    ifIndexes: string[],
  ): Promise<TrafficRow[]> {
    if (!ifIndexes.length) return []
    const slots = ifIndexes.map((_value, index) => `$${index + 4}`).join(', ')
    const result = await this.pool.query<TrafficRow>(
      `select timestamp, if_index, first(if_description) as if_description,
        avg(if_in_octets_per_second) * 8 as inbound_bps,
        avg(if_out_octets_per_second) * 8 as outbound_bps
       from network_interface_rate
       where source_id = $1 and timestamp >= $2 and timestamp < $3
         and if_index in (${slots})
       sample by ${bucket(input)} align to calendar
       order by timestamp
       limit ${this.queryLimit}`,
      [input.sourceId, input.from, input.to, ...ifIndexes],
    )
    return result.rows
  }

  // Inbound and outbound for every interface on a source, in one bounded query,
  // so the inventory table can draw a graph per row without a request each.
  async interfaceSeries(input: GraphRangeQuery & { sourceId: string }): Promise<TrafficRow[]> {
    const result = await this.pool.query<TrafficRow>(
      `select timestamp, if_index, first(if_description) as if_description,
        avg(if_in_octets_per_second) * 8 as inbound_bps,
        avg(if_out_octets_per_second) * 8 as outbound_bps
       from network_interface_rate
       where source_id = $1 and timestamp >= $2 and timestamp < $3
       sample by ${bucket(input, ROW_CHART_BUCKETS)} align to calendar
       order by timestamp
       limit ${ROW_CHART_ROW_CAP}`,
      [input.sourceId, input.from, input.to],
    )
    return result.rows
  }

  /**
   * Runs a rule query the controller generated so an operator can preview the
   * condition. Not a SQL pass-through: the statement comes from the alert query
   * builder, never from the request body.
   */
  async alertPreview(sql: string): Promise<Array<{ value: number | null; series: string | null }>> {
    const result = await this.pool.query(`${sql} limit ${this.queryLimit}`)
    const columns = result.fields.map((field) => field.name)
    const valueColumn = columns[1]
    const seriesColumn = columns[2]
    return result.rows.map((row) => {
      const record = row as Record<string, unknown>
      const raw = valueColumn === undefined ? null : record[valueColumn]
      const series = seriesColumn === undefined ? null : record[seriesColumn]
      return {
        value: typeof raw === 'number' ? raw : raw === null ? null : Number(raw),
        series: typeof series === 'string' ? series : null,
      }
    })
  }

  async sourcesReporting(input: GraphRangeQuery): Promise<number> {
    const result = await this.pool.query<{ sources: string | number }>(
      `select count_distinct(source_id) as sources
       from network_system
       where timestamp >= $1 and timestamp < $2`,
      [input.from, input.to],
    )
    return Number(result.rows[0]?.sources ?? 0)
  }

  async latestSources(input: GraphRangeQuery): Promise<LatestSourceRow[]> {
    const result = await this.pool.query<LatestSourceRow>(
      `select source_name, source_id, site_id, max(timestamp) as last_seen
       from network_system
       where timestamp >= $1 and timestamp < $2
       group by source_name, source_id, site_id
       order by last_seen desc
       limit 25`,
      [input.from, input.to],
    )
    return result.rows
  }
}
