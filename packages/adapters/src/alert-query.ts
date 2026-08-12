import { ALERT_METRICS, type AlertMetric, type HealthAlertKey } from '@pricklescope/contracts'

// Grafana evaluates alert rules standalone, with no dashboard variables, so a
// rule cannot reuse a panel query. The controller therefore builds concrete SQL
// per rule. Everything interpolated here is either a fixed identifier chosen by
// this module or a value passed through `quote`, never raw user text.
export interface AlertQueryScope {
  sourceId: string | null
  ifIndex: string | null
}

/** Where each measurement lives in QuestDB. Naming and scope come from contracts. */
const METRICS: Record<AlertMetric, { table: string; expression: string }> = {
  availability: {
    table: 'network_availability',
    expression: '100.0 - percent_packet_loss',
  },
  latency: {
    table: 'network_availability',
    expression: 'average_response_ms',
  },
  inbound_bps: {
    table: 'network_interface_rate',
    expression: 'if_in_octets_per_second * 8',
  },
  outbound_bps: {
    table: 'network_interface_rate',
    expression: 'if_out_octets_per_second * 8',
  },
  interface_errors: {
    table: 'network_interface_rate',
    expression: 'if_in_errors_per_second + if_out_errors_per_second',
  },
}

export function alertMetricLabel(metric: AlertMetric): string {
  return ALERT_METRICS[metric].label
}

// QuestDB has no bound parameters inside a Grafana rule, so identifiers reach the
// statement as literals. Reject anything that is not a plain identifier rather
// than trying to escape it.
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/

function quote(value: string, field: string): string {
  if (!SAFE_VALUE.test(value)) {
    throw new Error(`The ${field} scope contains characters that cannot be used in a rule query`)
  }
  return `'${value}'`
}

/**
 * A time series the rule evaluates. Grafana reduces it and applies the threshold,
 * so this returns raw samples over the lookback window rather than an aggregate.
 */
export function buildAlertQuery(
  metric: AlertMetric,
  scope: AlertQueryScope,
  lookbackSeconds: number,
): string {
  const definition = METRICS[metric]
  const filters: string[] = [`timestamp >= dateadd('s', -${Math.trunc(lookbackSeconds)}, now())`]

  if (scope.sourceId) filters.push(`source_id = ${quote(scope.sourceId, 'source')}`)
  if (scope.ifIndex) {
    if (!ALERT_METRICS[metric].supportsInterface) {
      throw new Error('This metric is not measured per interface')
    }
    filters.push(`if_index = ${quote(scope.ifIndex, 'interface')}`)
  }

  // source_name keeps each source a separate series, so one rule covering the
  // whole fleet raises a distinct alert per source rather than one blended value.
  // The alias is a constant from the metric catalogue, never caller input.
  return [
    `select timestamp as time, ${definition.expression} as "${ALERT_METRICS[metric].label}", source_name`,
    `from ${definition.table}`,
    `where ${filters.join(' and ')}`,
    `order by timestamp`,
  ].join('\n')
}

/**
 * The built-in health rules (D-042). Nothing here is caller text — the key
 * selects a fixed statement and the only interpolated values are numbers this
 * module truncates — so these do not go through `quote`.
 *
 * Every query was run against a live QuestDB before it was written down. Two of
 * them are not what they first look like:
 *
 *   collector_silent  counts the agent heartbeat, which is the row carrying
 *                     `go_version`. "Neither input nor output" also matches the
 *                     processor and parser rows, which have no error counts.
 *   source_silent     reports the age of each source's last sample rather than
 *                     counting samples. A source that has stopped produces no
 *                     rows at all, so a count cannot see it: the absent series
 *                     is the thing being detected.
 */
export function buildHealthAlertQuery(key: HealthAlertKey, lookbackSeconds: number): string {
  const window = Math.trunc(lookbackSeconds)
  const since = `timestamp >= dateadd('s', -${window}, now())`

  switch (key) {
    case 'collector_silent':
      return [
        `select timestamp as time, count() as "Heartbeats"`,
        `from collector_health`,
        `where go_version is not null and ${since}`,
        `sample by 1m align to calendar`,
      ].join('\n')

    // Cumulative counters since the collector started, so the delta over the
    // window is the question, not the value.
    case 'collector_write_errors':
      return [
        `select timestamp as time, max(write_errors) - min(write_errors) as "Write errors"`,
        `from collector_health`,
        `where go_version is not null and ${since}`,
        `sample by 1m align to calendar`,
      ].join('\n')

    case 'collector_buffer':
      return [
        `select timestamp as time, max(buffer_size) * 100.0 / max(buffer_limit) as "Buffer used %", output`,
        `from collector_health`,
        `where output is not null and buffer_limit > 0 and ${since}`,
        `sample by 1m align to calendar`,
      ].join('\n')

    // Counted with a CASE rather than filtered in the WHERE clause, so a healthy
    // minute produces a bucket holding zero instead of no bucket at all. Filtered,
    // the series simply stopped when everything recovered, and the reducer went on
    // reading the last failing bucket — a blip stayed "true" for the whole window
    // and fired minutes after the dependency came back (audit F4).
    case 'dependency_down':
      return [
        `select timestamp as time, sum(case when state != 'up' then 1 else 0 end) as "Failing dependencies"`,
        `from controller_health`,
        `where ${since}`,
        `sample by 1m align to calendar`,
      ].join('\n')

    // The window is deliberately not the lookback: a source silent for longer
    // than the lookback would drop out of the query entirely and stop alerting
    // at exactly the point the problem got worse.
    case 'source_silent':
      return [
        `select max(timestamp) as time, source_id, datediff('s', max(timestamp), now()) as "Seconds since last sample"`,
        `from network_availability`,
        `where timestamp >= dateadd('h', -24, now())`,
        `group by source_id`,
      ].join('\n')
  }
}

/** How each built-in rule compares its value to the threshold. */
export const HEALTH_ALERT_COMPARISON: Record<HealthAlertKey, 'gt' | 'lt'> = {
  collector_silent: 'lt',
  collector_write_errors: 'gt',
  collector_buffer: 'gt',
  dependency_down: 'gt',
  source_silent: 'gt',
}

/**
 * How far back each rule looks. Not one shared window: `collector_silent`
 * cannot detect silence until its window has emptied, so a ten-minute lookback
 * would mean ten minutes of blindness before the pending duration even starts.
 * `collector_write_errors` needs the opposite — enough window to see a counter
 * move at all.
 *
 * `source_silent` asks for a fixed 24 hours inside its own SQL and ignores this,
 * but Grafana still needs a relative range wide enough not to look absurd beside
 * the query it is running.
 */
export const HEALTH_ALERT_LOOKBACK_SECONDS: Record<HealthAlertKey, number> = {
  collector_silent: 300,
  collector_write_errors: 900,
  collector_buffer: 300,
  dependency_down: 300,
  source_silent: 86_400,
}

/** How the series is reduced before the threshold is applied. */
export const HEALTH_ALERT_REDUCER: Record<HealthAlertKey, 'last' | 'sum' | 'max'> = {
  // Sum, not last: one heartbeat anywhere in the window means it is alive.
  collector_silent: 'sum',
  // Cumulative counters, so the window's span is the number of errors in it.
  // Deliberately not current-state: errors that have stopped still happened, and
  // the alert clears once they leave the window.
  collector_write_errors: 'max',
  // Current state, not the window's worst moment. `max` meant one brief spike
  // held the condition true for the whole lookback and fired after recovery.
  collector_buffer: 'last',
  dependency_down: 'last',
  source_silent: 'last',
}
