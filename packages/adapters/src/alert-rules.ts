import { GRAFANA_DATASOURCE_UID, GRAFANA_FOLDER_UID } from '@pricklescope/contracts'
import type {
  AlertComparison,
  AlertMetric,
  AlertReducer,
  AlertSeverity,
  ExecErrorState,
  NoDataState,
} from '@pricklescope/contracts'

import { alertMetricLabel, buildAlertQuery } from './alert-query.js'

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
  const sql = buildAlertQuery(
    rule.metric,
    { sourceId: rule.sourceId, ifIndex: rule.ifIndex },
    rule.lookbackSeconds,
  )

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
      reducer: { params: [], type: 'last' },
      type: 'query',
    },
  ]
  const unloadEvaluator =
    rule.recoveryThreshold === null
      ? undefined
      : { type: rule.comparison === 'gt' ? 'lt' : 'gt', params: [rule.recoveryThreshold] }

  return {
    uid: alertRuleUid(rule.id),
    title: rule.name,
    ruleGroup: ALERT_RULE_GROUP,
    folderUID: GRAFANA_FOLDER_UID,
    condition: 'C',
    // Grafana rejects a rule whose `for` is not a multiple of its interval.
    for: `${alignPending(rule.pendingSeconds, rule.evaluationIntervalSeconds)}s`,
    noDataState: rule.noDataState,
    execErrState: rule.execErrorState,
    isPaused: false,
    orgID: 1,
    labels: {
      pricklescope_rule: rule.id,
      severity: rule.severity,
    },
    annotations: {
      summary: `${rule.name}: ${alertMetricLabel(rule.metric)} ${
        rule.comparison === 'gt' ? 'above' : 'below'
      } ${rule.threshold}`,
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
