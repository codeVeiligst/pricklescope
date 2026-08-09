import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api.js', () => ({
  api: {
    sources: vi.fn().mockResolvedValue({ sources: [] }),
    sites: vi.fn().mockResolvedValue({ sites: [] }),
    snmpCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
    pollingProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
    collectorCapabilities: vi.fn().mockResolvedValue({ recommended: 'telegraf', capabilities: [] }),
  },
}))

vi.mock('../auth.js', () => ({
  useAuth: () => ({
    session: { user: { role: 'administrator' } },
    csrfToken: 'test-csrf',
  }),
}))

import { DevicesPage } from './devices.js'

describe('Devices page hierarchy', () => {
  it('keeps the accessible page name without a redundant visible title banner', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DevicesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const heading = screen.getByRole('heading', { level: 1, name: 'Devices' })
    expect(heading).toHaveClass('sr-only')
    expect(document.querySelector('.page-title')).not.toBeInTheDocument()
    expect(document.title).toBe('Devices · PrickleScope')
    expect(screen.getByRole('searchbox', { name: 'Search devices' })).toBeInTheDocument()
  })
})
