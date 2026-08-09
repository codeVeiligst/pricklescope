import {
  EMAIL_CREDENTIAL_FIELDS,
  EMAIL_PROVIDER_FIELDS,
  type ContactPoint,
  type EmailProvider,
  type UpsertContactPointRequest,
} from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Pencil, Send, Trash2, Webhook } from 'lucide-react'
import { Fragment, useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'

/**
 * Says in one line whether the last notification actually went out. Plain text
 * rather than a second pill: the row already carries one, and delivery is
 * quiet metadata until it fails.
 */
function deliveryStatus(contact: ContactPoint) {
  if (contact.kind !== 'email') return '—'
  if (!contact.lastDeliveryAt) return 'Not sent yet'
  const when = new Date(contact.lastDeliveryAt).toLocaleString()
  if (contact.lastDeliveryOk) return `Sent ${when}`
  return (
    <span className="delivery-failed" title={contact.lastDeliveryError ?? undefined}>
      Failed {when}
    </span>
  )
}

export function ContactsPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('Contacts')
  const { session, csrfToken } = useAuth()
  const canOperate = session?.user.role !== 'viewer'
  const queryClient = useQueryClient()
  const [contactDialog, setContactDialog] = useState(false)
  const [editingContact, setEditingContact] = useState<ContactPoint | null>(null)
  const [kind, setKind] = useState('webhook')
  const [provider, setProvider] = useState<EmailProvider>('graph')

  const contacts = useQuery({ queryKey: ['contact-points'], queryFn: api.contactPoints })

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['contact-points'] }),
      // A contact belongs to Grafana's desired state, so the sync badge moves too.
      queryClient.invalidateQueries({ queryKey: ['sync'] }),
      queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    ])
  }

  const saveContact = useMutation({
    mutationFn: (request: UpsertContactPointRequest) =>
      editingContact
        ? api.updateContactPoint(editingContact.id, request, csrfToken!)
        : api.createContactPoint(request, csrfToken!),
    onSuccess: async () => {
      setContactDialog(false)
      setEditingContact(null)
      await invalidate()
    },
  })
  const removeContact = useMutation({
    mutationFn: (id: string) => api.deleteContactPoint(id, csrfToken!),
    onSuccess: invalidate,
  })
  const testContact = useMutation({
    mutationFn: (id: string) => api.testContactPoint(id, csrfToken!),
    onSuccess: invalidate,
  })

  // An existing email contact already holds encrypted credentials for its provider.
  const storedCredentials =
    editingContact?.kind === 'email' &&
    editingContact.provider === provider &&
    editingContact.secretConfigured

  function openContact(contact: ContactPoint | null) {
    setEditingContact(contact)
    setKind(contact?.kind ?? 'webhook')
    setProvider(contact?.provider ?? 'graph')
    saveContact.reset()
    setContactDialog(true)
  }

  function closeContact() {
    setContactDialog(false)
    setEditingContact(null)
  }

  function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    if (kind === 'webhook') {
      const secret = formString(values, 'secret').trim()
      saveContact.mutate({
        name: formString(values, 'name'),
        kind: 'webhook',
        url: formString(values, 'url'),
        addresses: null,
        ...(secret ? { secret } : {}),
      })
      return
    }

    // The provider's own field list decides what is asked and where each answer
    // belongs: encrypted credentials, or plain settings.
    const credentials: Record<string, string> = {}
    const providerConfig: Record<string, string> = {}
    for (const field of EMAIL_PROVIDER_FIELDS[provider].fields) {
      const value = formString(values, field.name).trim()
      if (!value) continue
      if (EMAIL_CREDENTIAL_FIELDS.has(field.name)) credentials[field.name] = value
      else providerConfig[field.name] = value
    }

    saveContact.mutate({
      name: formString(values, 'name'),
      kind: 'email',
      url: null,
      addresses: formString(values, 'addresses'),
      provider,
      providerConfig: providerConfig,
      credentials: credentials,
    })
  }

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Contacts</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Contact tools">
        <div>
          <Send size={18} />
          <span>
            Where a firing rule goes: a webhook you host, or email PrickleScope sends through your
            mail provider
          </span>
        </div>
        {canOperate ? (
          <Button icon={<Send size={17} />} onClick={() => openContact(null)}>
            Add contact
          </Button>
        ) : null}
      </section>

      <FormError error={contacts.error ?? removeContact.error ?? testContact.error} />

      {contacts.data?.contactPoints.length ? (
        <section className="resource-list" aria-label="Contacts">
          {contacts.data.contactPoints.map((contact) => (
            <article className="resource-list-row" key={contact.id}>
              <span className="resource-list-row__icon">
                {contact.kind === 'email' ? <Mail size={19} /> : <Webhook size={19} />}
              </span>
              <div>
                <strong>{contact.name}</strong>
                <small>
                  {contact.url ?? contact.addresses ?? 'No target set'}
                  {contact.kind === 'webhook' && contact.secretConfigured
                    ? ' · bearer token set'
                    : ''}
                </small>
              </div>
              <StatusPill tone="neutral">
                {contact.kind === 'email' && contact.provider
                  ? EMAIL_PROVIDER_FIELDS[contact.provider].label
                  : 'Webhook'}
              </StatusPill>
              <span className="resource-count">{deliveryStatus(contact)}</span>
              <div className="row-actions">
                {canOperate ? (
                  <>
                    <button
                      className="icon-button"
                      aria-label={`Send test notification to ${contact.name}`}
                      disabled={testContact.isPending}
                      onClick={() => testContact.mutate(contact.id)}
                    >
                      <Send size={15} />
                    </button>
                    <Button
                      variant="secondary"
                      size="small"
                      icon={<Pencil size={14} />}
                      onClick={() => openContact(contact)}
                    >
                      Edit
                    </Button>
                    <button
                      className="icon-button danger-icon"
                      aria-label={`Delete ${contact.name}`}
                      onClick={() =>
                        confirm({
                          title: `Delete ${contact.name}?`,
                          body: 'Rules pointing at it stop notifying until another is chosen.',
                          confirmLabel: 'Delete contact',
                          destructive: true,
                          onConfirm: () => removeContact.mutate(contact.id),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      ) : !contacts.isLoading ? (
        <div className="panel resource-empty">
          <Send size={25} />
          <strong>No contacts yet</strong>
          <span>Add a webhook you host, or email sent through your mail provider.</span>
        </div>
      ) : null}

      <Modal
        title={editingContact ? `Edit ${editingContact.name}` : 'Add a contact'}
        description="Where a firing rule goes: your own webhook endpoint, or email sent through your mail provider."
        open={contactDialog}
        onClose={closeContact}
      >
        {/* Keyed on the contact alone: keying on kind or provider too would remount
            the whole form and wipe the name already typed. */}
        <form className="resource-form" key={editingContact?.id ?? 'new'} onSubmit={submitContact}>
          <label className="field">
            <span>Name</span>
            <input name="name" required maxLength={128} defaultValue={editingContact?.name ?? ''} />
          </label>
          <label className="field">
            <span>Send by</span>
            <select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="webhook">Webhook</option>
              <option value="email">Email</option>
            </select>
          </label>

          {kind === 'webhook' ? (
            <>
              <label className="field">
                <span>Webhook URL</span>
                <input
                  name="url"
                  required
                  maxLength={2048}
                  placeholder="https://example.test/hooks/alerts"
                  defaultValue={editingContact?.url ?? ''}
                />
              </label>
              <label className="field">
                <span>Bearer token</span>
                <input name="secret" type="password" maxLength={1024} autoComplete="new-password" />
                <small>
                  {editingContact?.secretConfigured
                    ? 'A token is stored. Leave blank to keep it, or enter a new one to replace it.'
                    : 'Optional. Sent as an Authorization header on every notification.'}
                </small>
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>Send to</span>
                <input
                  name="addresses"
                  required
                  maxLength={1024}
                  placeholder="ops@example.test, oncall@example.test"
                  defaultValue={editingContact?.addresses ?? ''}
                />
                <small>Separate several recipients with commas.</small>
              </label>
              <label className="field">
                <span>Mail service</span>
                <select
                  name="provider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as EmailProvider)}
                >
                  {(Object.keys(EMAIL_PROVIDER_FIELDS) as EmailProvider[]).map((id) => (
                    <option key={id} value={id}>
                      {EMAIL_PROVIDER_FIELDS[id].label}
                    </option>
                  ))}
                </select>
                <small>{EMAIL_PROVIDER_FIELDS[provider].help}</small>
              </label>
              {/* Keyed on the provider so switching it clears the previous provider's
                  credentials rather than carrying them across. */}
              <Fragment key={provider}>
                {EMAIL_PROVIDER_FIELDS[provider].fields.map((field) => {
                  const isCredential = EMAIL_CREDENTIAL_FIELDS.has(field.name)
                  // Credentials are write-only, so editing cannot show them back;
                  // blank means keep what is stored rather than clear it.
                  const keepsStored = Boolean(storedCredentials && isCredential)
                  const stored = (editingContact?.providerConfig ?? {}) as Record<string, string>
                  if (field.name === 'region') {
                    return (
                      <label className="field" key={field.name}>
                        <span>{field.label}</span>
                        <select name="region" defaultValue={stored.region ?? 'us'}>
                          <option value="us">United States</option>
                          <option value="eu">Europe</option>
                        </select>
                      </label>
                    )
                  }
                  return (
                    <label className="field" key={field.name}>
                      <span>{field.label}</span>
                      <input
                        name={field.name}
                        required={!keepsStored}
                        maxLength={4096}
                        {...(isCredential
                          ? {}
                          : { defaultValue: stored[field.name as keyof typeof stored] ?? '' })}
                        {...(field.secret
                          ? { type: 'password', autoComplete: 'new-password' as const }
                          : {})}
                        {...(field.hint && !keepsStored ? { placeholder: field.hint } : {})}
                        {...(keepsStored ? { placeholder: 'Stored — leave blank to keep' } : {})}
                      />
                    </label>
                  )
                })}
              </Fragment>
              <p className="form-note">
                PrickleScope sends the mail itself through {EMAIL_PROVIDER_FIELDS[provider].label};
                no mail relay is involved. Use <strong>Send test</strong> after saving to confirm a
                message arrives.
              </p>
            </>
          )}

          <FormError error={saveContact.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={closeContact}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveContact.isPending}>
              {saveContact.isPending ? 'Saving…' : 'Save contact'}
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  )
}
