/**
 * What one reconciled engine reports about its own drift.
 *
 * Each domain answers this itself, because only it knows what it would write:
 * the collector renders its candidate configuration and compares hashes, Grafana
 * compares resource hashes, alerts compare per-rule revisions, and storage
 * compares its applied marker. Nothing here infers drift from timestamps alone.
 */
export interface SyncProbe {
  pending: boolean
  detail: string
  lastAppliedAt: Date | null
  /** Set when the target cannot be applied at all, with the reason. */
  blocked: string | null
}
