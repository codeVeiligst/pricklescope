import type { PollingProfile } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock3, Gauge, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'

export function ProfilesPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('Polling profiles')
  const { session, csrfToken } = useAuth()
  const canOperate = session?.user.role !== 'viewer'
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['polling-profiles'], queryFn: api.pollingProfiles })
  const [editing, setEditing] = useState<PollingProfile | null>(null)
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (request: Parameters<typeof api.createPollingProfile>[0]) =>
      editing
        ? api.updatePollingProfile(editing.id, request, csrfToken!)
        : api.createPollingProfile(request, csrfToken!),
    onSuccess: async () => {
      setOpen(false)
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['polling-profiles'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deletePollingProfile(id, csrfToken!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['polling-profiles'] }),
  })

  function show(profile: PollingProfile | null) {
    setEditing(profile)
    save.reset()
    setOpen(true)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const description = formString(values, 'description').trim()
    save.mutate({
      name: formString(values, 'name'),
      ...(description ? { description } : {}),
      intervalSeconds: Number(values.get('intervalSeconds')),
      timeoutMs: Number(values.get('timeoutMs')),
      retries: Number(values.get('retries')),
      collectSystem: values.get('collectSystem') === 'on',
      collectInterfaces: values.get('collectInterfaces') === 'on',
    })
  }

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Polling profiles</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Polling profile tools">
        <div>
          <Clock3 size={18} />
          <span>Reusable timeouts, retries, and inventory scope</span>
        </div>
        {canOperate ? (
          <Button icon={<Plus size={17} />} onClick={() => show(null)}>
            Add profile
          </Button>
        ) : null}
      </section>
      <FormError error={query.error ?? remove.error} />
      <section className="resource-list" aria-label="Polling profiles">
        {query.data?.profiles.map((profile) => (
          <article className="resource-list-row" key={profile.id}>
            <span className="resource-list-row__icon">
              <Gauge size={19} />
            </span>
            <div>
              <strong>{profile.name}</strong>
              <small>{profile.description ?? 'Reusable polling policy'}</small>
            </div>
            {profile.systemDefined ? (
              <StatusPill tone="neutral">Built in</StatusPill>
            ) : (
              <StatusPill tone="positive">Custom</StatusPill>
            )}
            <span className="resource-count">
              Every {profile.intervalSeconds}s · {profile.timeoutMs}ms · {profile.retries} retries
            </span>
            {canOperate && !profile.systemDefined ? (
              <div className="row-actions">
                <button
                  className="icon-button"
                  onClick={() => show(profile)}
                  aria-label={`Edit ${profile.name}`}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-button danger-icon"
                  disabled={profile.sourceCount > 0}
                  title={profile.sourceCount ? 'Profile is assigned to devices' : 'Remove profile'}
                  onClick={() => {
                    confirm({
                      title: `Remove ${profile.name}?`,
                      body: 'Devices using this polling profile must be reassigned.',
                      confirmLabel: 'Remove profile',
                      destructive: true,
                      onConfirm: () => remove.mutate(profile.id),
                    })
                  }}
                  aria-label={`Remove ${profile.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ) : (
              <span className="resource-count">{profile.sourceCount} devices</span>
            )}
          </article>
        ))}
      </section>

      <Modal
        title={editing ? 'Edit polling profile' : 'Add a polling profile'}
        description="The profile controls discovery now and scheduled polling in the next milestone."
        open={open}
        onClose={() => setOpen(false)}
      >
        <form className="resource-form" onSubmit={submit}>
          <div className="form-grid">
            <label className="field field--wide">
              <span>Name</span>
              <input name="name" required defaultValue={editing?.name} />
            </label>
            <label className="field field--wide">
              <span>Description</span>
              <input name="description" defaultValue={editing?.description ?? ''} />
            </label>
            <label className="field">
              <span>Interval (seconds)</span>
              <input
                name="intervalSeconds"
                type="number"
                min={10}
                max={86400}
                required
                defaultValue={editing?.intervalSeconds ?? 60}
              />
            </label>
            <label className="field">
              <span>Timeout (milliseconds)</span>
              <input
                name="timeoutMs"
                type="number"
                min={250}
                max={60000}
                required
                defaultValue={editing?.timeoutMs ?? 3000}
              />
            </label>
            <label className="field">
              <span>Retries</span>
              <input
                name="retries"
                type="number"
                min={0}
                max={10}
                required
                defaultValue={editing?.retries ?? 1}
              />
            </label>
            <div className="field">
              <span>Inventory scope</span>
              <label className="check-field">
                <input
                  name="collectSystem"
                  type="checkbox"
                  defaultChecked={editing?.collectSystem ?? true}
                />{' '}
                System identity
              </label>
              <label className="check-field">
                <input
                  name="collectInterfaces"
                  type="checkbox"
                  defaultChecked={editing?.collectInterfaces ?? true}
                />{' '}
                IF-MIB interfaces
              </label>
            </div>
          </div>
          <FormError error={save.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  )
}
