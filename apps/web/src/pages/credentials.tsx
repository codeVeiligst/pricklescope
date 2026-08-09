import type {
  CreateSnmpCredentialRequest,
  SnmpCredential,
  SnmpSecurityLevel,
  SnmpVersion,
} from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LockKeyhole, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'

export function CredentialsPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('SNMP credentials')
  const { csrfToken } = useAuth()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['snmp-credentials'], queryFn: api.snmpCredentials })
  const [editing, setEditing] = useState<SnmpCredential | null>(null)
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState<SnmpVersion>('3')
  const [level, setLevel] = useState<SnmpSecurityLevel>('authPriv')
  const save = useMutation({
    mutationFn: async (request: Record<string, unknown>) => {
      if (editing) return api.updateSnmpCredential(editing.id, request, csrfToken!)
      return api.createSnmpCredential(request as CreateSnmpCredentialRequest, csrfToken!)
    },
    onSuccess: async () => {
      setOpen(false)
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['snmp-credentials'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSnmpCredential(id, csrfToken!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['snmp-credentials'] }),
  })

  function show(credential: SnmpCredential | null) {
    setEditing(credential)
    setVersion(credential?.version ?? '3')
    setLevel(credential?.securityLevel ?? 'authPriv')
    save.reset()
    setOpen(true)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const request: Record<string, unknown> = { name: formString(values, 'name') }
    if (!editing) request.version = version
    if (version === '2c') {
      const community = formString(values, 'community')
      if (community) request.community = community
    } else {
      request.username = formString(values, 'username')
      request.securityLevel = level
      if (level !== 'noAuthNoPriv') {
        request.authProtocol = formString(values, 'authProtocol')
        const authPassword = formString(values, 'authPassword')
        if (authPassword) request.authPassword = authPassword
      }
      if (level === 'authPriv') {
        request.privacyProtocol = formString(values, 'privacyProtocol')
        const privacyPassword = formString(values, 'privacyPassword')
        if (privacyPassword) request.privacyPassword = privacyPassword
      }
    }
    save.mutate(request)
  }

  return (
    <div className="page-stack">
      <ScreenReaderHeading>SNMP credentials</ScreenReaderHeading>
      <section className="resource-toolbar" aria-label="Credential tools">
        <div>
          <ShieldCheck size={18} />
          <span>Secrets are encrypted and stay write-only after saving</span>
        </div>
        <Button icon={<Plus size={17} />} onClick={() => show(null)}>
          Add credential
        </Button>
      </section>
      <FormError error={query.error ?? remove.error} />
      <section className="resource-list" aria-label="SNMP credentials">
        {query.data?.credentials.map((credential) => (
          <article className="resource-list-row" key={credential.id}>
            <span className="resource-list-row__icon">
              <KeyRound size={19} />
            </span>
            <div>
              <strong>{credential.name}</strong>
              <small>
                {credential.version === '3'
                  ? `SNMPv3 · ${credential.username} · ${credential.securityLevel}`
                  : 'SNMPv2c · community protected at rest'}
              </small>
            </div>
            <StatusPill tone={credential.version === '3' ? 'positive' : 'warning'}>
              {credential.version === '3' ? 'Encrypted on wire' : 'Plaintext on wire'}
            </StatusPill>
            <span className="resource-count">{credential.sourceCount} devices</span>
            <div className="row-actions">
              <Button
                variant="secondary"
                size="small"
                icon={<Pencil size={14} />}
                onClick={() => show(credential)}
              >
                {credential.version === '3' ? 'Edit / rotate' : 'Rotate'}
              </Button>
              <button
                className="icon-button danger-icon"
                disabled={credential.sourceCount > 0}
                title={
                  credential.sourceCount ? 'Credential is assigned to devices' : 'Remove credential'
                }
                onClick={() =>
                  confirm({
                    title: `Remove ${credential.name}?`,
                    body: 'The stored secret is destroyed and cannot be recovered.',
                    confirmLabel: 'Remove credential',
                    destructive: true,
                    onConfirm: () => remove.mutate(credential.id),
                  })
                }
                aria-label={`Remove ${credential.name}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </article>
        ))}
        {!query.isLoading && !query.data?.credentials.length ? (
          <div className="panel resource-empty">
            <LockKeyhole size={25} />
            <strong>No SNMP credentials</strong>
            <span>Add a write-only secret to begin onboarding devices.</span>
          </div>
        ) : null}
      </section>

      <Modal
        title={editing ? `Edit ${editing.name}` : 'Add an SNMP credential'}
        description="Saved secrets can be replaced, but never read back."
        open={open}
        onClose={() => setOpen(false)}
      >
        <form className="resource-form" onSubmit={submit}>
          <div className="form-grid">
            <label className="field field--wide">
              <span>Name</span>
              <input
                name="name"
                required
                maxLength={128}
                defaultValue={editing?.name}
                placeholder="Network read-only"
              />
            </label>
            {!editing ? (
              <label className="field field--wide">
                <span>SNMP version</span>
                <select
                  value={version}
                  onChange={(event) => setVersion(event.target.value as SnmpVersion)}
                >
                  <option value="3">SNMPv3 · recommended</option>
                  <option value="2c">SNMPv2c · legacy</option>
                </select>
              </label>
            ) : null}
            {version === '2c' ? (
              <label className="field field--wide">
                <span>Community {editing ? '(leave blank to keep current)' : ''}</span>
                <input
                  name="community"
                  type="password"
                  required={!editing}
                  autoComplete="new-password"
                />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>Username</span>
                  <input name="username" required defaultValue={editing?.username ?? ''} />
                </label>
                <label className="field">
                  <span>Security level</span>
                  <select
                    value={level}
                    onChange={(event) => setLevel(event.target.value as SnmpSecurityLevel)}
                  >
                    <option value="authPriv">Authentication + privacy</option>
                    <option value="authNoPriv">Authentication only</option>
                    <option value="noAuthNoPriv">No authentication</option>
                  </select>
                </label>
                {level !== 'noAuthNoPriv' ? (
                  <>
                    <label className="field">
                      <span>Authentication</span>
                      <select name="authProtocol" defaultValue={editing?.authProtocol ?? 'sha256'}>
                        <option value="sha256">SHA-256</option>
                        <option value="sha384">SHA-384</option>
                        <option value="sha512">SHA-512</option>
                        <option value="sha">SHA-1 · legacy</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Auth passphrase {editing ? '(optional)' : ''}</span>
                      <input
                        name="authPassword"
                        type="password"
                        minLength={8}
                        required={!editing}
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                ) : null}
                {level === 'authPriv' ? (
                  <>
                    <label className="field">
                      <span>Privacy</span>
                      <select
                        name="privacyProtocol"
                        defaultValue={editing?.privacyProtocol ?? 'aes'}
                      >
                        <option value="aes">AES-128</option>
                        <option value="aes256r">AES-256 · RFC</option>
                        <option value="aes256b">AES-256 · Blumenthal</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Privacy passphrase {editing ? '(optional)' : ''}</span>
                      <input
                        name="privacyPassword"
                        type="password"
                        minLength={8}
                        required={!editing}
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                ) : null}
              </>
            )}
          </div>
          {version === '2c' ? (
            <div className="security-warning">
              SNMPv2c traffic is not encrypted. Prefer SNMPv3 authPriv where the device supports it.
            </div>
          ) : null}
          <FormError error={save.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save credential'}
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  )
}
