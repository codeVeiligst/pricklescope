import {
  HEALTH_ALERT_CATALOGUE,
  type ContactPoint,
  type HealthAlertKey,
  type HealthAlertRule,
} from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Database, HeartPulse, Network, PlugZap, Radio, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { FormError } from '../components/modal.js'
import { useDocumentTitle } from '../hooks.js'

/**
 * The controller's own health alerts. These are not composed here — they exist
 * on a fresh install and this screen decides where they go and how patient they
 * are, because the failure they cover is that nobody was looking.
 *
 * Built from `settings-card` and its `dl`, like the Settings page, rather than
 * from `resource-list-row`. The first version invented seven class names that the
 * stylesheet does not define, so the browser laid it out with defaults: controls
 * landed in a different column on every row and the unit sat under its input.
 * Every class used here is one the stylesheet already has.
 */

const ORDER: HealthAlertKey[] = [
  'collector_silent',
  'dependency_down',
  'collector_write_errors',
  'collector_buffer',
  'source_silent',
]

const ICONS: Record<HealthAlertKey, typeof Activity> = {
  collector_silent: Radio,
  dependency_down: PlugZap,
  collector_write_errors: Database,
  collector_buffer: Activity,
  source_silent: Network,
}

const PATIENCE = [0, 120, 300, 600, 900, 1800]

function patienceLabel(seconds: number): string {
  return seconds === 0 ? 'Immediately' : `${seconds / 60} minutes`
}

function unitLabel(key: HealthAlertKey): string {
  const unit = HEALTH_ALERT_CATALOGUE[key].unit
  return unit === 'percent' ? 'Above (%)' : unit === 'seconds' ? 'Silent for (s)' : 'Above'
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
      // These reach Grafana on a reconcile, and the sync badge is what says so.
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
        <section className="resource-toolbar" aria-label="Health alert tools">
          <div>
            <HeartPulse size={18} />
            <span>
              What the controller says when it cannot do its job. {enabledCount} of {rules.length}{' '}
              checks enabled
              {draft?.contactPointId
                ? ''
                : ' — with no contact chosen they still evaluate and appear in Grafana, but notify nobody'}
            </span>
          </div>
          {administrator && (
            <Button type="submit" disabled={save.isPending || !draft}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </section>

        {save.error && <FormError error={save.error} />}

        <section className="settings-grid">
          <article className="panel settings-card">
            <div className="settings-card__icon">
              <Send size={20} />
            </div>
            <div>
              <span className="eyebrow">Destination</span>
              <h2>Send these to</h2>
            </div>
            <p>
              One destination for every check. These are the controller reporting on itself, so they
              belong with whoever looks after it — not necessarily whoever looks after the network.
            </p>
            <dl>
              <div>
                <dt>Contact</dt>
                <dd>
                  <select
                    aria-label="Send these to"
                    value={draft?.contactPointId ?? ''}
                    disabled={!administrator}
                    onChange={(event) =>
                      draft && setEdits({ ...draft, contactPointId: event.target.value || null })
                    }
                  >
                    <option value="">Grafana only — notify nobody</option>
                    {contactPoints.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                  </select>
                </dd>
              </div>
            </dl>
          </article>

          {ORDER.map((key) => {
            const rule = rules.find((entry) => entry.key === key)
            if (!rule) return null
            const entry = HEALTH_ALERT_CATALOGUE[key]
            const Icon = ICONS[key]
            return (
              <article className="panel settings-card" key={key}>
                <div className="settings-card__icon">
                  <Icon size={20} />
                </div>
                <div>
                  <span className="eyebrow">
                    <StatusPill tone={entry.severity === 'critical' ? 'negative' : 'warning'}>
                      {entry.severity}
                    </StatusPill>
                  </span>
                  <h2>{entry.label}</h2>
                </div>
                <p>{entry.description}</p>
                <dl>
                  <div>
                    <dt>
                      <label htmlFor={`enabled-${key}`}>Enabled</label>
                    </dt>
                    <dd>
                      <input
                        id={`enabled-${key}`}
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={!administrator}
                        onChange={(event) => update(key, { enabled: event.target.checked })}
                      />
                    </dd>
                  </div>
                  {entry.adjustable && (
                    <div>
                      <dt>
                        <label htmlFor={`threshold-${key}`}>{unitLabel(key)}</label>
                      </dt>
                      <dd>
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
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      <label htmlFor={`for-${key}`}>Wait</label>
                    </dt>
                    <dd>
                      <select
                        id={`for-${key}`}
                        value={rule.forSeconds}
                        disabled={!administrator || !rule.enabled}
                        onChange={(event) =>
                          update(key, { forSeconds: Number(event.target.value) })
                        }
                      >
                        {PATIENCE.map((seconds) => (
                          <option key={seconds} value={seconds}>
                            {patienceLabel(seconds)}
                          </option>
                        ))}
                      </select>
                    </dd>
                  </div>
                </dl>
              </article>
            )
          })}
        </section>

        {!administrator && (
          <p className="current-user-note">
            An administrator changes these. Where the system reports its own failures is not an
            operator&rsquo;s decision.
          </p>
        )}
      </form>
    </>
  )
}
