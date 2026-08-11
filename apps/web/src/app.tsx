import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AuthProvider, useAuth } from './auth.js'
import { AppShell } from './components/app-shell.js'
import { Brand } from './components/brand.js'
import { CredentialsPage } from './pages/credentials.js'
import { CollectorsPage } from './pages/collectors.js'
import { ContactsPage } from './pages/contacts.js'
import { DeviceDetailPage } from './pages/device-detail.js'
import { AlertsPage } from './pages/alerts.js'
import { DashboardsPage } from './pages/dashboards.js'
import { DevicesPage } from './pages/devices.js'
import { LoginPage } from './pages/login.js'
import { OverviewPage } from './pages/overview.js'
import { ProfilesPage } from './pages/profiles.js'
import { HealthAlertsPage } from './pages/health-alerts.js'
import { SettingsPage } from './pages/settings.js'
import { SitesPage } from './pages/sites.js'
import { StoragePage } from './pages/storage.js'
import { UsersPage } from './pages/users.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
})

function ProtectedLayout() {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div className="app-loading">
        <Brand />
        <span className="loading-line" />
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <AppShell />
}

function AdministratorRoute({ children }: { children: React.ReactNode }) {
  const { session } = useAuth()
  return session?.user.role === 'administrator' ? children : <Navigate to="/" replace />
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="devices/:id" element={<DeviceDetailPage />} />
            <Route path="dashboards" element={<DashboardsPage />} />
            <Route path="sites" element={<SitesPage />} />
            <Route path="polling-profiles" element={<ProfilesPage />} />
            <Route path="collectors" element={<CollectorsPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="contacts" element={<ContactsPage />} />
            <Route path="health-alerts" element={<HealthAlertsPage />} />
            <Route path="storage" element={<StoragePage />} />
            <Route
              path="users"
              element={
                <AdministratorRoute>
                  <UsersPage />
                </AdministratorRoute>
              }
            />
            <Route
              path="credentials"
              element={
                <AdministratorRoute>
                  <CredentialsPage />
                </AdministratorRoute>
              }
            />
            <Route
              path="settings"
              element={
                <AdministratorRoute>
                  <SettingsPage />
                </AdministratorRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </QueryClientProvider>
  )
}
