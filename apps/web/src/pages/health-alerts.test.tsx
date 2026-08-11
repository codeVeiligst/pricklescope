import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above every top-level binding, so the fixtures it closes
// over have to be hoisted with it.
const { settings, role } = vi.hoisted(() => ({
  settings: {
    contactPointId: null,
    contactPointName: null,
    updatedAt: '2026-08-11T09:00:00.000Z',
    rules: [
      { key: 'collector_silent', enabled: true, threshold: 1, forSeconds: 300 },
      { key: 'collector_write_errors', enabled: true, threshold: 0, forSeconds: 600 },
      { key: 'collector_buffer', enabled: false, threshold: 80, forSeconds: 300 },
      { key: 'dependency_down', enabled: true, threshold: 0, forSeconds: 120 },
      { key: 'source_silent', enabled: true, threshold: 900, forSeconds: 300 },
    ],
  },
  role: { current: 'administrator' },
}))

vi.mock('../api.js', () => ({
  api: {
    healthAlerts: vi.fn().mockResolvedValue(settings),
    contactPoints: vi.fn().mockResolvedValue({
      contactPoints: [{ id: 'c1', name: 'Ops webhook', kind: 'webhook' }],
    }),
    updateHealthAlerts: vi.fn(),
  },
}))

vi.mock('../auth.js', () => ({
  useAuth: () => ({ session: { user: { role: role.current } }, csrfToken: 'test-csrf' }),
}))

import { HealthAlertsPage } from './health-alerts.js'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HealthAlertsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Not automatic here: the suite runs without testing-library's global
// cleanup, and the existing page test has a single case so it never noticed.
afterEach(cleanup)

describe('Health alerts page', () => {
  it('lists every built-in check with its state', async () => {
    role.current = 'administrator'
    renderPage()
    expect(await screen.findByText('The collector has stopped writing')).toBeInTheDocument()
    expect(screen.getByText('A dependency is down')).toBeInTheDocument()
    expect(screen.getByText('A source has gone silent')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/4 of\s+5 checks enabled/)).toBeInTheDocument())
  })

  /**
   * A rule with no contact point still evaluates and still shows in Grafana — it
   * just does not notify. Saying "on" without saying that would be the screen
   * claiming cover the operator does not have.
   */
  it('says plainly that nothing is notified until a contact is chosen', async () => {
    role.current = 'administrator'
    renderPage()
    expect(
      await screen.findByText(/they still evaluate and appear in Grafana, but notify nobody/),
    ).toBeVisible()
  })

  it('keeps the accessible page name without a visible title banner', async () => {
    role.current = 'administrator'
    renderPage()
    const heading = await screen.findByRole('heading', { level: 1, name: 'Health alerts' })
    expect(heading).toBeInTheDocument()
  })

  it('offers no save control to an operator, and disables the fields', async () => {
    role.current = 'operator'
    renderPage()
    await screen.findByText('The collector has stopped writing')
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Send these to')).toBeDisabled()
    expect(screen.getByText(/An administrator changes these/)).toBeVisible()
  })
})
