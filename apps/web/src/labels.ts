import type { JobStatus, Role, SourceStatus } from '@pricklescope/contracts'

/**
 * Shared presentation helpers.
 *
 * Each of these was written separately on two screens and had begun to differ,
 * so a device could read as reachable on one page and neutral on another.
 */

export function roleLabel(role: Role): string {
  return role === 'administrator' ? 'Administrator' : role === 'operator' ? 'Operator' : 'Viewer'
}

export function statusTone(status: SourceStatus) {
  if (status === 'ready' || status === 'reachable') return 'positive' as const
  if (status === 'unreachable') return 'negative' as const
  if (status === 'testing' || status === 'inventory_pending') return 'warning' as const
  return 'neutral' as const
}

export function jobIsActive(status: JobStatus | undefined): boolean {
  return status === 'queued' || status === 'running'
}
