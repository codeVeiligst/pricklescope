import { Button, cn } from '@pricklescope/ui'
import {
  Activity,
  Bell,
  Clock3,
  Database,
  Gauge,
  LayoutDashboard,
  KeyRound,
  LogOut,
  MapPin,
  Menu,
  Moon,
  Network,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

import { api } from '../api.js'
import { useAuth } from '../auth.js'
import { useTheme } from '../hooks.js'
import { Brand } from './brand.js'
import { SyncButton } from './sync-button.js'
import { roleLabel } from '../labels.js'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  adminOnly?: boolean
}

// Three groups: what you look at, what you configure, and who may do it.
const navigationGroups: { caption: string; items: NavItem[]; adminOnly?: boolean }[] = [
  {
    caption: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: Gauge, end: true },
      { to: '/dashboards', label: 'Dashboards', icon: LayoutDashboard },
      { to: '/devices', label: 'Devices', icon: Network },
      { to: '/alerts', label: 'Alerts', icon: Bell },
    ],
  },
  {
    caption: 'Settings',
    items: [
      { to: '/sites', label: 'Sites', icon: MapPin },
      { to: '/polling-profiles', label: 'Polling', icon: Clock3 },
      { to: '/collectors', label: 'Collectors', icon: Activity },
      { to: '/contacts', label: 'Contacts', icon: Send },
      { to: '/storage', label: 'Storage', icon: Database },
      { to: '/credentials', label: 'Credentials', icon: KeyRound, adminOnly: true },
    ],
  },
  {
    caption: 'System',
    adminOnly: true,
    items: [
      { to: '/users', label: 'Users', icon: UsersRound },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

export function AppShell() {
  const { session, logout } = useAuth()
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: api.alerts,
    refetchInterval: 30_000,
    enabled: Boolean(session),
  })
  const { theme, toggleTheme } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  if (!session) return null
  const isAdministrator = session.user.role === 'administrator'
  const firing = (alerts.data?.states ?? []).filter((state) =>
    ['firing', 'alerting'].includes(state.state.toLowerCase()),
  ).length

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={cn('sidebar', menuOpen && 'sidebar--open')}>
        <div className="sidebar__brand-row">
          <Brand />
          <button
            className="icon-button sidebar__close"
            onClick={() => setMenuOpen(false)}
            aria-label="Close navigation"
          >
            <X size={19} />
          </button>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigationGroups.map((group, index) => {
            if (group.adminOnly && !isAdministrator) return null
            const items = group.items.filter((item) => !item.adminOnly || isAdministrator)
            if (!items.length) return null
            return (
              <Fragment key={group.caption}>
                <span className={cn('nav-caption', index > 0 && 'nav-caption--second')}>
                  {group.caption}
                </span>
                {items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end ?? false}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) => cn('nav-item', isActive && 'nav-item--active')}
                  >
                    <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                    <span>{label}</span>
                  </NavLink>
                ))}
              </Fragment>
            )
          })}
        </nav>
        <div className="sidebar__footer">
          <div className="security-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <span>Secure session</span>
              <small>{roleLabel(session.user.role)}</small>
            </div>
          </div>
        </div>
      </aside>

      {menuOpen ? (
        <button
          className="sidebar-scrim"
          onClick={() => setMenuOpen(false)}
          aria-label="Close menu"
        />
      ) : null}

      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMenuOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>
          <div className="topbar__actions">
            <SyncButton />
            <button
              className="icon-button"
              onClick={toggleTheme}
              aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <NavLink
              className="icon-button notification-button"
              to="/alerts"
              aria-label={firing ? `Open alerts: ${firing} firing` : 'Open alerts'}
            >
              <Bell size={19} />
              {/* Only when something is actually firing — a dot that is always on
                  tells the operator nothing. */}
              {firing ? <span className="notification-dot" /> : null}
            </NavLink>
            <div className="profile-menu">
              <button
                className="profile-trigger"
                onClick={() => setProfileOpen((open) => !open)}
                aria-expanded={profileOpen}
              >
                <span className="avatar">{session.user.displayName.slice(0, 2).toUpperCase()}</span>
                <span className="profile-trigger__copy">
                  <strong>{session.user.displayName}</strong>
                  <small>{roleLabel(session.user.role)}</small>
                </span>
              </button>
              {profileOpen ? (
                <div className="profile-popover">
                  <div>
                    <strong>{session.user.username}</strong>
                    <span>{session.user.email ?? 'Local account'}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    icon={<LogOut size={16} />}
                    onClick={() => void logout()}
                  >
                    Sign out
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
