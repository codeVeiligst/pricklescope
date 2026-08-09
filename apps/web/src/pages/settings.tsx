import type { UpdateOidcProviderSettingsRequest } from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Fingerprint,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { useRef, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useConfirm } from '../components/confirm.js'
import { FormError } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'

function nullable(value: string): string | null {
  return value.trim() || null
}

function formRequest(form: HTMLFormElement): UpdateOidcProviderSettingsRequest {
  const values = new FormData(form)
  const clientSecret = formString(values, 'clientSecret')
  return {
    enabled: values.get('enabled') === 'on',
    name: formString(values, 'name'),
    issuerUrl: nullable(formString(values, 'issuerUrl')),
    clientId: nullable(formString(values, 'clientId')),
    ...(clientSecret ? { clientSecret } : {}),
    clearClientSecret: clientSecret ? false : values.get('clearClientSecret') === 'on',
    redirectUri: formString(values, 'redirectUri'),
    scopes: formString(values, 'scopes'),
    jitProvisioning: values.get('jitProvisioning') === 'on',
    adminGroup: nullable(formString(values, 'adminGroup')),
    operatorGroup: nullable(formString(values, 'operatorGroup')),
  }
}

export function SettingsPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('Settings')
  const { session, providers, csrfToken, refreshProviders } = useAuth()
  const queryClient = useQueryClient()
  const formRef = useRef<HTMLFormElement>(null)
  const query = useQuery({ queryKey: ['oidc-settings'], queryFn: api.oidcSettings })
  const save = useMutation({
    mutationFn: (request: UpdateOidcProviderSettingsRequest) =>
      api.updateOidcSettings(request, csrfToken!),
    onSuccess: async (settings) => {
      queryClient.setQueryData(['oidc-settings'], settings)
      test.reset()
      await refreshProviders()
    },
  })
  const test = useMutation({
    mutationFn: (request: UpdateOidcProviderSettingsRequest) =>
      api.testOidcSettings(request, csrfToken!),
  })
  const reset = useMutation({
    mutationFn: () => api.resetOidcSettings(csrfToken!),
    onSuccess: async (settings) => {
      queryClient.setQueryData(['oidc-settings'], settings)
      test.reset()
      await refreshProviders()
    },
  })
  const settings = query.data

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    save.mutate(formRequest(event.currentTarget))
  }

  function testConnection() {
    const form = formRef.current
    if (!form?.reportValidity()) return
    test.mutate(formRequest(form))
  }

  return (
    <div className="page-stack">
      <ScreenReaderHeading>Settings</ScreenReaderHeading>
      <section className="settings-grid">
        <article className="panel settings-card">
          <div className="settings-card__icon">
            <UserRound size={20} />
          </div>
          <div>
            <span className="eyebrow">Current identity</span>
            <h2>{session?.user.displayName}</h2>
          </div>
          <dl>
            <div>
              <dt>Username</dt>
              <dd>{session?.user.username}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                <StatusPill tone="positive">{session?.user.role}</StatusPill>
              </dd>
            </div>
            <div>
              <dt>Methods</dt>
              <dd>{session?.user.authMethods.join(', ')}</dd>
            </div>
          </dl>
        </article>
        <article className="panel settings-card">
          <div className="settings-card__icon">
            <KeyRound size={20} />
          </div>
          <div>
            <span className="eyebrow">Authentication</span>
            <h2>Sign-in providers</h2>
          </div>
          <dl>
            <div>
              <dt>Local accounts</dt>
              <dd>
                <StatusPill tone="positive">Enabled</StatusPill>
              </dd>
            </div>
            <div>
              <dt>{providers?.oidc.name ?? 'OpenID Connect'}</dt>
              <dd>
                <StatusPill tone={providers?.oidc.enabled ? 'positive' : 'neutral'}>
                  {providers?.oidc.enabled ? 'Enabled' : 'Not configured'}
                </StatusPill>
              </dd>
            </div>
          </dl>
        </article>

        <article className="panel settings-card settings-card--wide oidc-settings-card">
          <div className="settings-card__icon">
            <Fingerprint size={20} />
          </div>
          <div className="oidc-settings-card__heading">
            <div>
              <span className="eyebrow">OpenID Connect</span>
              <h2>Identity provider</h2>
            </div>
            {settings ? (
              <div className="oidc-settings-card__status">
                <StatusPill tone={settings.enabled ? 'positive' : 'neutral'}>
                  {settings.enabled ? 'Enabled' : 'Disabled'}
                </StatusPill>
                <span>{settings.source === 'database' ? 'Managed here' : 'Not configured'}</span>
              </div>
            ) : null}
          </div>

          <FormError error={query.error} />
          {settings ? (
            <form
              className="resource-form oidc-settings-form"
              key={`${settings.source}-${settings.updatedAt ?? 'defaults'}`}
              ref={formRef}
              onSubmit={submit}
            >
              <label className="check-field oidc-enable-field">
                <input name="enabled" type="checkbox" defaultChecked={settings.enabled} />
                <span>
                  <strong>Allow OIDC sign-in</strong>
                  <small>Enabling requires successful provider discovery.</small>
                </span>
              </label>

              <div className="form-grid">
                <label className="field">
                  <span>Provider name</span>
                  <input
                    name="name"
                    required
                    maxLength={128}
                    defaultValue={settings.name}
                    placeholder="Company single sign-on"
                  />
                </label>
                <label className="field">
                  <span>Client ID</span>
                  <input
                    name="clientId"
                    maxLength={512}
                    defaultValue={settings.clientId ?? ''}
                    placeholder="pricklescope"
                  />
                </label>
                <label className="field field--wide">
                  <span>Issuer URL</span>
                  <input
                    name="issuerUrl"
                    type="url"
                    maxLength={2048}
                    defaultValue={settings.issuerUrl ?? ''}
                    placeholder="https://id.example.com/realms/networking"
                  />
                  <small>PrickleScope reads the provider’s standard discovery document.</small>
                </label>
                <label className="field field--wide">
                  <span>Client secret</span>
                  <input
                    name="clientSecret"
                    type="password"
                    aria-label="Client secret"
                    maxLength={4096}
                    autoComplete="new-password"
                    placeholder={
                      settings.clientSecretConfigured
                        ? 'Stored secret · leave blank to keep it'
                        : 'Optional for public clients'
                    }
                  />
                  <small>
                    The secret is write-only and encrypted before it reaches PostgreSQL.
                  </small>
                </label>
                {settings.clientSecretConfigured ? (
                  <label className="check-field field--wide oidc-clear-secret">
                    <input name="clearClientSecret" type="checkbox" />
                    Remove the stored client secret
                  </label>
                ) : null}
                <label className="field field--wide">
                  <span>Redirect URI</span>
                  <input
                    name="redirectUri"
                    type="url"
                    required
                    maxLength={2048}
                    defaultValue={settings.redirectUri}
                  />
                  <small>Register this exact value with the identity provider.</small>
                </label>
                <label className="field field--wide">
                  <span>Scopes</span>
                  <input name="scopes" required maxLength={2048} defaultValue={settings.scopes} />
                  <small>Space-separated. The openid scope is required.</small>
                </label>
                <label className="field">
                  <span>Administrator group</span>
                  <input
                    name="adminGroup"
                    maxLength={512}
                    defaultValue={settings.adminGroup ?? ''}
                    placeholder="pricklescope-admins"
                  />
                </label>
                <label className="field">
                  <span>Operator group</span>
                  <input
                    name="operatorGroup"
                    maxLength={512}
                    defaultValue={settings.operatorGroup ?? ''}
                    placeholder="pricklescope-operators"
                  />
                </label>
              </div>

              <label className="check-field oidc-jit-field">
                <input
                  name="jitProvisioning"
                  type="checkbox"
                  defaultChecked={settings.jitProvisioning}
                />
                <span>
                  <strong>Create users on first sign-in</strong>
                  <small>Unmapped users start as Viewer unless a group grants another role.</small>
                </span>
              </label>

              <div className="oidc-safety-note">
                <ShieldCheck size={17} />
                <span>
                  An active local administrator is required before changes are accepted, preserving
                  a recovery sign-in path.
                </span>
              </div>

              {test.data ? (
                <div className="oidc-test-result" role="status">
                  <CheckCircle2 size={18} />
                  <span>
                    <strong>Discovery succeeded</strong>
                    <small>{test.data.issuer}</small>
                  </span>
                </div>
              ) : null}
              <FormError error={save.error ?? test.error ?? reset.error} />

              <div className="form-actions oidc-settings-actions">
                {settings.source === 'database' ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      confirm({
                        title: 'Clear OIDC settings?',
                        body: 'Single sign-on is disabled and the stored client secret is destroyed. Local accounts keep working.',
                        confirmLabel: 'Clear settings',
                        destructive: true,
                        onConfirm: () => reset.mutate(),
                      })
                    }}
                    disabled={reset.isPending || save.isPending || test.isPending}
                    icon={<RefreshCw size={16} />}
                  >
                    Clear configuration
                  </Button>
                ) : null}
                <span className="oidc-settings-actions__spacer" />
                <Button
                  variant="secondary"
                  onClick={testConnection}
                  disabled={test.isPending || save.isPending || reset.isPending}
                >
                  {test.isPending ? 'Testing…' : 'Test connection'}
                </Button>
                <Button
                  type="submit"
                  disabled={save.isPending || test.isPending || reset.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save OIDC settings'}
                </Button>
              </div>
            </form>
          ) : null}
        </article>

        <article className="panel settings-card settings-card--wide">
          <div className="settings-card__icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <span className="eyebrow">Security posture</span>
            <h2>Server-owned sessions</h2>
          </div>
          <p>
            Session state lives in PostgreSQL. Infrastructure credentials, client secrets, and OIDC
            tokens are never exposed to browser code.
          </p>
        </article>
      </section>
      {confirmDialog}
    </div>
  )
}
