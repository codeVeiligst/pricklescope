import { Button } from '@pricklescope/ui'
import { ArrowRight, KeyRound, LockKeyhole } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

import { ApiClientError } from '../api.js'
import { useAuth } from '../auth.js'
import { Brand } from '../components/brand.js'
import { useDocumentTitle } from '../hooks.js'

export function LoginPage() {
  useDocumentTitle('Sign in')
  const { session, providers, login } = useAuth()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/'

  if (session) return <Navigate to={returnTo} replace />

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login({ username, password })
    } catch (reason) {
      setError(
        reason instanceof ApiClientError ? reason.message : 'Sign-in is temporarily unavailable',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="PrickleScope introduction">
        <Brand />
        <div className="login-story__copy">
          <span className="eyebrow">Infrastructure, in focus</span>
          <h1>
            See the signal.
            <br />
            Skip the noise.
          </h1>
          <p>
            Inventory, collection, retention, graphs, and alerting in one calm operational
            workspace.
          </p>
        </div>
        <div className="signal-art" aria-hidden="true">
          <span className="signal-art__grid" />
          <span className="signal-art__line signal-art__line--one" />
          <span className="signal-art__line signal-art__line--two" />
          <span className="signal-art__glow" />
        </div>
        <small className="login-story__foot">PrickleScope · control plane 0.1</small>
      </section>

      <section className="login-panel" aria-label="Sign in">
        <div className="login-card">
          <div className="login-card__icon">
            <LockKeyhole size={21} />
          </div>
          <span className="eyebrow">Welcome back</span>
          <h2>Sign in to your workspace</h2>
          <p className="login-card__intro">
            Use a local administrator account or your organization’s identity provider.
          </p>

          <form onSubmit={(event) => void submit(event)}>
            <label>
              <span>Username</span>
              <input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                autoFocus
              />
            </label>
            <label>
              <span>Password</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? (
              <div className="form-error" role="alert">
                {error}
              </div>
            ) : null}
            <Button type="submit" disabled={busy} icon={<ArrowRight size={17} />}>
              {busy ? 'Signing in…' : 'Continue'}
            </Button>
          </form>

          {providers?.oidc.enabled ? (
            <>
              <div className="login-divider">
                <span>or</span>
              </div>
              <a
                className="sso-button"
                href={`/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`}
              >
                <KeyRound size={17} />
                Continue with {providers.oidc.name}
              </a>
            </>
          ) : null}
        </div>
      </section>
    </main>
  )
}
