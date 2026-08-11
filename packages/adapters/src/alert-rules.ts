import {
  GRAFANA_DATASOURCE_UID,
  GRAFANA_FOLDER_UID,
  HEALTH_ALERT_CATALOGUE,
} from '@pricklescope/contracts'
import type {
  AlertComparison,
  AlertMetric,
  AlertReducer,
  AlertSeverity,
  ExecErrorState,
  HealthAlertKey,
  NoDataState,
} from '@pricklescope/contracts'

import {
  HEALTH_ALERT_COMPARISON,
  HEALTH_ALERT_LOOKBACK_SECONDS,
  HEALTH_ALERT_REDUCER,
  alertMetricLabel,
  buildAlertQuery,
  buildHealthAlertQuery,
} from './alert-query.js'

export const ALERT_RULE_GROUP = 'pricklescope'

// Stable, derived from the controller's own row id, so a rule keeps its Grafana
// identity across renames and reconciles.
export function alertRuleUid(ruleId: string): string {
  return `ps-alert-${ruleId.replace(/-/g, '').slice(0, 24)}`
}

export function contactPointName(name: string): string {
  return name
}

export interface AlertRuleInput {
  id: string
  name: string
  description: string | null
  sourceId: string | null
  ifIndex: string | null
  metric: AlertMetric
  reducer: AlertReducer
  comparison: AlertComparison
  threshold: number
  recoveryThreshold: number | null
  evaluationIntervalSeconds: number
  pendingSeconds: number
  lookbackSeconds: number
  noDataState: NoDataState
  execErrorState: ExecErrorState
  severity: AlertSeverity
  contactPoint: string | null
}

const QUERY_FORMAT_TIME_SERIES = 0

/**
 * Grafana evaluates a rule as a small pipeline: A fetches the series, B reduces
 * each series to one number, C compares that number to the threshold. C is the
 * condition, so one rule covering many sources produces one alert per source.
 */
export function alertRuleDefinition(rule: AlertRuleInput): Record<string, unknown> {
  return ruleDefinition({
    uid: alertRuleUid(rule.id),
    title: rule.name,
    sql: buildAlertQuery(
      rule.metric,
      { sourceId: rule.sourceId, ifIndex: rule.ifIndex },
      rule.lookbackSeconds,
    ),
    summary: `${rule.name}: ${alertMetricLabel(rule.metric)} ${
      rule.comparison === 'gt' ? 'above' : 'below'
    } ${rule.threshold}`,
    description: rule.description,
    labels: { pricklescope_rule: rule.id, severity: rule.severity },
    seriesReducer: 'last',
    reducer: rule.reducer,
    comparison: rule.comparison,
    threshold: rule.threshold,
    recoveryThreshold: rule.recoveryThreshold,
    evaluationIntervalSeconds: rule.evaluationIntervalSeconds,
    pendingSeconds: rule.pendingSeconds,
    lookbackSeconds: rule.lookbackSeconds,
    noDataState: rule.noDataState,
    execErrorState: rule.execErrorState,
    contactPoint: rule.contactPoint,
  })
}

/**
 * The shape both kinds of rule reduce to. Extracted when the built-in health
 * alerts arrived (D-042) rather than copied, because two hand-maintained copies
 * of a Grafana rule pipeline would diverge and only one of them would be tested.
 */
interface RuleShape {
  uid: string
  title: string
  sql: string
  summary: string
  description: string | null
  labels: Record<string, string>
  /** How the series is collapsed to one number before the threshold applies. */
  seriesReducer: string
  reducer: AlertReducer | 'sum'
  comparison: AlertComparison
  threshold: number
  recoveryThreshold: number | null
  evaluationIntervalSeconds: number
  pendingSeconds: number
  lookbackSeconds: number
  noDataState: NoDataState
  execErrorState: ExecErrorState
  contactPoint: string | null
}

function ruleDefinition(rule: RuleShape): Record<string, unknown> {
  const sql = rule.sql

  const evaluator: Record<string, unknown> = {
    type: rule.comparison,
    params: [rule.threshold],
  }

  // Hysteresis. Grafana keeps a rule firing until the value passes the recovery
  // threshold, so a measurement sitting on the line does not flap between states.
  const thresholdConditions: Record<string, unknown>[] = [
    {
      evaluator,
      operator: { type: 'and' },
      query: { params: ['B'] },
      reducer: { params: [], type: rule.seriesReducer },
      type: 'query',
    },
  ]
  const unloadEvaluator =
    rule.recoveryThreshold === null
      ? undefined
      : { type: rule.comparison === 'gt' ? 'lt' : 'gt', params: [rule.recoveryThreshold] }

  return {
    uid: rule.uid,
    title: rule.title,
    ruleGroup: ALERT_RULE_GROUP,
    folderUID: GRAFANA_FOLDER_UID,
    condition: 'C',
    // Grafana rejects a rule whose `for` is not a multiple of its interval.
    for: `${alignPending(rule.pendingSeconds, rule.evaluationIntervalSeconds)}s`,
    noDataState: rule.noDataState,
    execErrState: rule.execErrorState,
    isPaused: false,
    orgID: 1,
    labels: rule.labels,
    annotations: {
      summary: rule.summary,
      ...(rule.description ? { description: rule.description } : {}),
      __pricklescope_managed__: 'true',
    },
    // Routing lives on the rule rather than in the global notification policy
    // tree, so provisioning never overwrites routes a user added themselves.
    ...(rule.contactPoint ? { notification_settings: { receiver: rule.contactPoint } } : {}),
    data: [
      {
        refId: 'A',
        relativeTimeRange: { from: rule.lookbackSeconds, to: 0 },
        datasourceUid: GRAFANA_DATASOURCE_UID,
        model: {
          refId: 'A',
          rawSql: sql,
          rawQuery: true,
          editorMode: 'code',
          format: QUERY_FORMAT_TIME_SERIES,
        },
      },
      {
        refId: 'B',
        relativeTimeRange: { from: rule.lookbackSeconds, to: 0 },
        datasourceUid: '__expr__',
        model: {
          refId: 'B',
          type: 'reduce',
          expression: 'A',
          reducer: rule.reducer,
          // A stale source returns no rows; dropping non-numeric results keeps
          // that as No Data instead of silently reducing to zero.
          settings: { mode: 'dropNN' },
        },
      },
      {
        refId: 'C',
        relativeTimeRange: { from: rule.lookbackSeconds, to: 0 },
        datasourceUid: '__expr__',
        model: {
          refId: 'C',
          type: 'threshold',
          expression: 'B',
          conditions: thresholdConditions.map((condition) => ({
            ...condition,
            ...(unloadEvaluator ? { unloadEvaluator } : {}),
          })),
        },
      },
    ],
  }
}

// Grafana requires the pending period to be a whole number of evaluation
// intervals; rounding up keeps the operator's intent of "at least this long".
export function alignPending(pendingSeconds: number, intervalSeconds: number): number {
  if (pendingSeconds <= 0) return 0
  return Math.ceil(pendingSeconds / intervalSeconds) * intervalSeconds
}

export interface ContactPointInput {
  name: string
  kind: 'webhook' | 'email'
  url: string | null
  addresses: string | null
  secret: string | null
  /** Where Grafana hands an email notification back to the controller (D-023). */
  deliveryUrl?: string | null
  deliveryToken?: string | null
}

function webhookSettings(url: string, secret: string | null): Record<string, unknown> {
  return {
    url,
    httpMethod: 'POST',
    ...(secret ? { authorization_scheme: 'Bearer', authorization_credentials: secret } : {}),
  }
}

/**
 * Email is a webhook too. PrickleScope supports no SMTP relay, so Grafana's own
 * `email` receiver is never used: the controller registers a webhook aimed at
 * its own notify endpoint and sends the mail through the provider's HTTP API.
 */
export function contactPointDefinition(input: ContactPointInput): Record<string, unknown> {
  if (input.kind === 'email' && !input.deliveryUrl) {
    throw new Error('An email contact point needs a delivery URL Grafana can reach')
  }

  return {
    name: input.name,
    type: 'webhook',
    settings:
      input.kind === 'email'
        ? webhookSettings(input.deliveryUrl!, input.deliveryToken ?? null)
        : webhookSettings(input.url ?? '', input.secret),
    disableResolveMessage: false,
  }
}

/**
 * A built-in health alert (D-042). Distinct uid prefix from user rules so the
 * reconciler's sweep for orphaned `ps-alert-` rules cannot delete one, and so
 * the drift probe can account for the two sets separately.
 */
export function healthAlertRuleUid(key: HealthAlertKey): string {
  return `ps-health-${key.replace(/_/g, '-')}`
}

export interface HealthAlertRuleInput {
  key: HealthAlertKey
  threshold: number
  forSeconds: number
  contactPoint: string | null
}

const HEALTH_EVALUATION_INTERVAL_SECONDS = 60

export function healthAlertRuleDefinition(rule: HealthAlertRuleInput): Record<string, unknown> {
  const entry = HEALTH_ALERT_CATALOGUE[rule.key]
  const comparison = HEALTH_ALERT_COMPARISON[rule.key]
  const lookback = HEALTH_ALERT_LOOKBACK_SECONDS[rule.key]
  const unit = entry.unit === 'percent' ? '%' : entry.unit === 'seconds' ? 's' : ''

  return ruleDefinition({
    uid: healthAlertRuleUid(rule.key),
    title: entry.label,
    sql: buildHealthAlertQuery(rule.key, lookback),
    summary: `${entry.label} (${comparison === 'gt' ? 'above' : 'below'} ${rule.threshold}${unit})`,
    description: entry.description,
    // `pricklescope_health` rather than `pricklescope_rule`: the reconciler
    // deletes remote rules carrying the latter that it no longer owns, and these
    // are not in that set.
    labels: { pricklescope_health: rule.key, severity: entry.severity },
    seriesReducer: HEALTH_ALERT_REDUCER[rule.key],
    reducer: 'last',
    comparison,
    threshold: rule.threshold,
    // No hysteresis. These are not measurements sitting near a line — a
    // dependency is down or it is not — and a recovery threshold would only
    // delay the all-clear.
    recoveryThreshold: null,
    evaluationIntervalSeconds: HEALTH_EVALUATION_INTERVAL_SECONDS,
    pendingSeconds: rule.forSeconds,
    lookbackSeconds: lookback,
    // Both Alerting, and this is the load-bearing part. The controller cannot
    // record that QuestDB is down or that it is dead itself, because both stop
    // the write (D-041). A rule with nothing to read, or one whose datasource
    // errors, therefore has to fire rather than go quiet — silence is the
    // symptom, not the all-clear.
    noDataState: 'Alerting',
    execErrorState: 'Alerting',
    contactPoint: rule.contactPoint,
  })
}
