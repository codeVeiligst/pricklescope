import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from './error-boundary.js'

function Explodes(): never {
  throw new Error('a field was not the shape this screen expected')
}

// This suite has no global cleanup, so renders otherwise accumulate.
afterEach(cleanup)

describe('ErrorBoundary', () => {
  it('shows the failure instead of a blank page', () => {
    // React logs the caught error itself; silencing it keeps the run readable.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <ErrorBoundary>
          <Explodes />
        </ErrorBoundary>,
      )
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/failed to render/i)).toBeVisible()
      // The message is shown, because it is the only detail worth reporting.
      expect(screen.getByText(/not the shape this screen expected/)).toBeVisible()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the screen</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('the screen')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
