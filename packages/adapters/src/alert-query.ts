import { ALERT_METRICS, type AlertMetric } from '@pricklescope/contracts'

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
