import {
  HEALTH_ALERT_CATALOGUE,
  type ContactPoint,
  type HealthAlertKey,
  type HealthAlertRule,
} from '@pricklescope/contracts'
import { Button, ScreenReaderHeading } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HeartPulse } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { FormError } from '../components/modal.js'
import { useDocumentTitle } from '../hooks.js'

/**
 * The controller's own health alerts. These are not composed here — they exist
 * on a fresh install and this screen decides where they go and how patient they
 * are, because the failure they cover is that nobody was looking.
 */

const ORDER: HealthAlertKey[] = [
  'collector_silent',
  'dependency_down',
  'collector_write_errors',
  'collector_buffer',
  'source_silent',
]

function minutes(seconds: number): string {
  if (seconds === 0) return 'immediately'
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds}s`
}

function unitSuffix(key: HealthAlertKey): string {
  const unit = HEALTH_ALERT_CATALOGUE[key].unit
  return unit === 'percent' ? '%' : unit === 'seconds' ? 'seconds' : ''
}

export function HealthAlertsPage() {
  useDocumentTitle('Health alerts')
  const { session, csrfToken } = useAuth()
  const administrator = session?.user.role === 'administrator'
  const queryClient = useQueryClient()
  // Edits overlay the server's answer rather than being copied out of it by an
  // effect: copying means a render that immediately schedules another, and it
  // silently discards a change that arrives while the form is open.
  const [edits, setEdits] = useState<{
    contactPointId: string | null
    rules: HealthAlertRule[]
  } | null>(null)

  const settings = useQuery({ queryKey: ['health-alerts'], queryFn: api.healthAlerts })
  const contacts = useQuery({ queryKey: ['contact-points'], queryFn: api.contactPoints })

  const draft =
    edits ??
    (settings.data
      ? { contactPointId: settings.data.contactPointId, rules: settings.data.rules }
      : null)

  const save = useMutation({
    mutationFn: (body: { contactPointId: string | null; rules: HealthAlertRule[] }) =>
      api.updateHealthAlerts(body, csrfToken!),
    onSuccess: async () => {
      // Drop the overlay so the form re-derives from what the server stored,
      // rather than from what this browser hoped it would store.
      setEdits(null)
      await queryClient.invalidateQueries({ queryKey: ['health-alerts'] })
      // The rules change in Grafana only on a reconcile, and the sync badge is
      // what tells the operator that. Refresh it rather than leaving a stale
      // "everything is current" beside a change they just made.
      await queryClient.invalidateQueries({ queryKey: ['sync'] })
    },
  })

  const update = (key: HealthAlertKey, patch: Partial<HealthAlertRule>): void => {
    if (!draft) return
    setEdits({
      ...draft,
      rules: draft.rules.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
    })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (draft) save.mutate(draft)
  }

  const rules = draft?.rules ?? []
  const contactPoints: ContactPoint[] = contacts.data?.contactPoints ?? []
  const enabledCount = rules.filter((rule) => rule.enabled).length

  return (
    <>
      <ScreenReaderHeading>Health alerts</ScreenReaderHeading>
      <form onSubmit={submit}>
        <div className="resource-toolbar">
          <p className="resource-toolbar__summary">
            {enabledCount} of {rules.length} checks on
            {draft?.contactPointId
              ? ''
              : ' — nothing is notified until a contact is chosen, though the alerts still show in Grafana'}
          </p>
          {administrator && (
            <Button type="submit" disabled={save.isPending || !draft}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>

        {save.error && <FormError error={save.error} />}

        <article className="panel settings-card">
          <div className="settings-card__icon">
            <HeartPulse aria-hidden />
          </div>
          <div className="field">
            <label htmlFor="health-contact">Send these to</label>
            <select
              id="health-contact"
              value={draft?.contactPointId ?? ''}
              disabled={!administrator}
              onChange={(event) =>
                draft && setEdits({ ...draft, contactPointId: event.target.value || null })
              }
            >
              <option value="">No contact — visible in Grafana only</option>
              {contactPoints.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
            <p className="field__hint">
              One destination for every check below. These are the controller telling you it cannot
              do its job, so they go to whoever is responsible for the controller.
            </p>
          </div>
        </article>

        <ul className="resource-list">
          {ORDER.map((key) => {
            const rule = rules.find((entry) => entry.key === key)
            if (!rule) return null
            const entry = HEALTH_ALERT_CATALOGUE[key]
            return (
              <li key={key} className="resource-list-row">
                <div className="resource-list-row__main">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={!administrator}
                      onChange={(event) => update(key, { enabled: event.target.checked })}
                    />
                    <span>{entry.label}</span>
                  </label>
                  <p className="resource-list-row__detail">{entry.description}</p>
                </div>
                <div className="resource-list-row__controls">
                  {entry.adjustable && (
                    <div className="field field--inline">
                      <label htmlFor={`threshold-${key}`}>Above</label>
                      <input
                        id={`threshold-${key}`}
                        type="number"
                        min={0}
                        max={86400}
                        value={rule.threshold}
                        disabled={!administrator || !rule.enabled}
                        onChange={(event) =>
                          update(key, { threshold: Number(event.target.value) || 0 })
                        }
                      />
                      <span className="field__suffix">{unitSuffix(key)}</span>
                    </div>
                  )}
                  <div className="field field--inline">
                    <label htmlFor={`for-${key}`}>For</label>
                    <select
                      id={`for-${key}`}
                      value={rule.forSeconds}
                      disabled={!administrator || !rule.enabled}
                      onChange={(event) => update(key, { forSeconds: Number(event.target.value) })}
                    >
                      {[0, 120, 300, 600, 900, 1800].map((seconds) => (
                        <option key={seconds} value={seconds}>
                          {minutes(seconds)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        {!administrator && (
          <p className="resource-empty__hint">
            An administrator changes these. Where the system reports its own failures is not an
            operator&rsquo;s decision.
          </p>
        )}
      </form>
    </>
  )
}
