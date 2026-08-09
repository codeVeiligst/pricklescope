import type {
  CreateLocalUserRequest,
  ManagedUser,
  Role,
  UpdateManagedUserRequest,
} from '@pricklescope/contracts'
import { Button, ScreenReaderHeading, StatusPill } from '@pricklescope/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KeyRound,
  LoaderCircle,
  LogOut,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useConfirm } from '../components/confirm.js'
import { FormError, Modal } from '../components/modal.js'
import { formString } from '../form.js'
import { useDocumentTitle } from '../hooks.js'
import { roleLabel } from '../labels.js'

function issuerLabel(issuer: string): string {
  try {
    return new URL(issuer).host
  } catch {
    return issuer
  }
}

export function UsersPage() {
  const { confirm, confirmDialog } = useConfirm()
  useDocumentTitle('Users')
  const { session, csrfToken, providers } = useAuth()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['users'], queryFn: api.users })
  const [search, setSearch] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ManagedUser | null>(null)
  const [passwordUser, setPasswordUser] = useState<ManagedUser | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] })
  const create = useMutation({
    mutationFn: (request: CreateLocalUserRequest) => api.createUser(request, csrfToken!),
    onSuccess: async () => {
      setEditorOpen(false)
      await refresh()
    },
  })
  const update = useMutation({
    mutationFn: (request: { id: string; changes: UpdateManagedUserRequest }) =>
      api.updateUser(request.id, request.changes, csrfToken!),
    onSuccess: async () => {
      setEditorOpen(false)
      setEditing(null)
      await refresh()
    },
  })
  const resetPassword = useMutation({
    mutationFn: (request: { id: string; password: string }) =>
      api.resetUserPassword(request.id, request.password, csrfToken!),
    onSuccess: async () => {
      setPasswordUser(null)
      await refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeUserSessions(id, csrfToken!),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteUser(id, csrfToken!),
    onSuccess: refresh,
  })

  const users = useMemo(() => query.data?.users ?? [], [query.data?.users])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return users
    return users.filter((user) =>
      [user.username, user.displayName, user.email, roleLabel(user.role), ...user.authMethods]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    )
  }, [search, users])

  function openEditor(user: ManagedUser | null) {
    setEditing(user)
    create.reset()
    update.reset()
    setEditorOpen(true)
  }

  function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const email = formString(values, 'email').trim()
    if (editing) {
      update.mutate({
        id: editing.id,
        changes: {
          displayName: formString(values, 'displayName'),
          email: email || null,
          role: formString(values, 'role') as Role,
          active: values.get('active') === 'on',
        },
      })
      return
    }
    create.mutate({
      username: formString(values, 'username'),
      displayName: formString(values, 'displayName'),
      ...(email ? { email } : {}),
      role: formString(values, 'role') as Role,
      password: formString(values, 'password'),
    })
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!passwordUser) return
    resetPassword.mutate({
      id: passwordUser.id,
      password: formString(new FormData(event.currentTarget), 'password'),
    })
  }

  const error = query.error ?? revoke.error ?? remove.error
  return (
    <div className="page-stack">
      <ScreenReaderHeading>Users</ScreenReaderHeading>
      <section className="user-summary-strip" aria-label="User summary">
        <div>
          <UsersRound size={18} />
          <span>
            <strong>{users.filter((user) => user.active).length}</strong> active users
          </span>
        </div>
        <div>
          <ShieldCheck size={18} />
          <span>
            <strong>
              {users.filter((user) => user.active && user.role === 'administrator').length}
            </strong>{' '}
            administrators
          </span>
        </div>
        <div>
          <KeyRound size={18} />
          <span>
            OIDC <strong>{providers?.oidc.enabled ? 'enabled' : 'not configured'}</strong>
          </span>
        </div>
      </section>
      <section className="content-toolbar" aria-label="User tools">
        <div className="toolbar-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search users"
            placeholder="Search username, name, email, or role"
          />
        </div>
        <Button icon={<Plus size={17} />} onClick={() => openEditor(null)}>
          Add local user
        </Button>
      </section>
      <FormError error={error} />
      <section className="panel user-table" role="table" aria-label="Users">
        <div className="user-table__head" role="row">
          <span role="columnheader">Identity</span>
          <span role="columnheader">Access</span>
          <span role="columnheader">Sign-in</span>
          <span role="columnheader">Last active</span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        {query.isLoading ? (
          <div className="resource-empty">
            <LoaderCircle className="spin" size={23} />
          </div>
        ) : (
          filtered.map((user) => {
            const ownAccount = user.id === session?.user.id
            return (
              <article
                className={`user-row${user.active ? '' : ' user-row--inactive'}`}
                role="row"
                key={user.id}
              >
                <div className="user-identity" role="cell">
                  <span className="resource-list-row__icon">
                    <UserRound size={18} />
                  </span>
                  <span>
                    <strong>
                      {user.displayName}
                      {ownAccount ? <em>You</em> : null}
                    </strong>
                    <small>
                      @{user.username}
                      {user.email ? ` · ${user.email}` : ''}
                    </small>
                  </span>
                </div>
                <div role="cell">
                  <StatusPill
                    tone={
                      !user.active
                        ? 'negative'
                        : user.role === 'administrator'
                          ? 'positive'
                          : 'neutral'
                    }
                  >
                    {user.active ? roleLabel(user.role) : 'Disabled'}
                  </StatusPill>
                </div>
                <div className="user-methods" role="cell">
                  {user.authMethods.map((method) => (
                    <span key={method}>
                      {method === 'local'
                        ? 'Local'
                        : user.oidcIssuers.map(issuerLabel).join(', ') || 'OIDC'}
                    </span>
                  ))}
                </div>
                <div className="user-last-seen" role="cell">
                  <span>
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'Never'}
                  </span>
                  <small>
                    {user.sessionCount} active {user.sessionCount === 1 ? 'session' : 'sessions'}
                  </small>
                </div>
                <div className="row-actions" role="cell">
                  {ownAccount ? (
                    <span className="current-user-note">Current account</span>
                  ) : (
                    <>
                      <button
                        className="icon-button"
                        onClick={() => openEditor(user)}
                        aria-label={`Edit ${user.username}`}
                      >
                        <Pencil size={15} />
                      </button>
                      {user.authMethods.includes('local') ? (
                        <button
                          className="icon-button"
                          onClick={() => {
                            resetPassword.reset()
                            setPasswordUser(user)
                          }}
                          aria-label={`Reset password for ${user.username}`}
                        >
                          <KeyRound size={15} />
                        </button>
                      ) : null}
                      <button
                        className="icon-button"
                        disabled={!user.sessionCount}
                        title={user.sessionCount ? 'Revoke all sessions' : 'No active sessions'}
                        onClick={() =>
                          confirm({
                            title: `Sign ${user.displayName} out everywhere?`,
                            body: `Every active session ends immediately. ${user.displayName} can sign in again.`,
                            confirmLabel: 'Revoke sessions',
                            onConfirm: () => revoke.mutate(user.id),
                          })
                        }
                        aria-label={`Revoke sessions for ${user.username}`}
                      >
                        <LogOut size={15} />
                      </button>
                      <button
                        className="icon-button danger-icon"
                        onClick={() =>
                          confirm({
                            title: `Delete ${user.displayName}?`,
                            body: 'The account and its sessions are removed. This cannot be undone.',
                            confirmLabel: 'Delete account',
                            destructive: true,
                            onConfirm: () => remove.mutate(user.id),
                          })
                        }
                        aria-label={`Delete ${user.username}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })
        )}
        {!query.isLoading && !filtered.length ? (
          <div className="resource-empty">
            <UsersRound size={25} />
            <strong>{search ? 'No users match that search' : 'No users found'}</strong>
          </div>
        ) : null}
      </section>

      <Modal
        title={editing ? `Edit ${editing.displayName}` : 'Add a local user'}
        description={
          editing?.authMethods.includes('oidc')
            ? 'OIDC may refresh this user’s name and email at their next sign-in.'
            : 'Local passwords remain write-only after the account is created.'
        }
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
      >
        <form className="resource-form" onSubmit={submitEditor}>
          <div className="form-grid">
            {!editing ? (
              <label className="field">
                <span>Username</span>
                <input
                  name="username"
                  required
                  maxLength={128}
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                  autoComplete="off"
                  placeholder="jane.doe"
                />
              </label>
            ) : (
              <div className="field">
                <span>Username</span>
                <div className="read-only-field">@{editing.username}</div>
              </div>
            )}
            <label className="field">
              <span>Display name</span>
              <input
                name="displayName"
                required
                maxLength={256}
                defaultValue={editing?.displayName}
                placeholder="Jane Doe"
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                name="email"
                type="email"
                maxLength={320}
                defaultValue={editing?.email ?? ''}
                placeholder="jane@example.com"
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select name="role" defaultValue={editing?.role ?? 'viewer'}>
                <option value="viewer">Viewer · read only</option>
                <option value="operator">Operator · manage monitoring</option>
                <option value="administrator">Administrator · full control</option>
              </select>
            </label>
            {!editing ? (
              <label className="field field--wide">
                <span>Initial password</span>
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  maxLength={1024}
                  required
                  autoComplete="new-password"
                />
                <small>At least 12 characters. Share it through a secure channel.</small>
              </label>
            ) : (
              <label className="check-field field--wide">
                <input name="active" type="checkbox" defaultChecked={editing.active} /> Allow this
                user to sign in
              </label>
            )}
          </div>
          <FormError error={create.error ?? update.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {create.isPending || update.isPending
                ? 'Saving…'
                : editing
                  ? 'Save changes'
                  : 'Create user'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        title={`Reset ${passwordUser?.displayName ?? 'user'}’s password`}
        description="All of this user’s existing sessions will be revoked."
        open={Boolean(passwordUser)}
        onClose={() => setPasswordUser(null)}
      >
        <form className="resource-form" onSubmit={submitPassword}>
          <label className="field">
            <span>New password</span>
            <input
              name="password"
              type="password"
              minLength={12}
              maxLength={1024}
              required
              autoComplete="new-password"
            />
          </label>
          <FormError error={resetPassword.error} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setPasswordUser(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={resetPassword.isPending}>
              {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
            </Button>
          </div>
        </form>
      </Modal>
      {confirmDialog}
    </div>
  )
}
