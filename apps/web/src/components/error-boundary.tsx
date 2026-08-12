import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Contains a rendering failure so one broken screen does not become a blank
 * page (audit F15).
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so
 * a single malformed field — from version skew between a cached bundle and a
 * newer API, or a proxy returning its own JSON — took the entire application
 * down to a white rectangle with the real cause only in the console.
 *
 * Deliberately not a retry loop: the same render will usually throw again.
 * Reloading is the honest offer, and the message says what to do with the
 * detail rather than hiding it.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where a browser error belongs; there is no error-reporting
    // service in this product and inventing one here would be a surprise.
    console.error('PrickleScope failed to render', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="panel resource-empty" role="alert">
        <h2>Something in this screen failed to render</h2>
        <p className="current-user-note">
          The rest of PrickleScope is unaffected — collection, alerting, and the collector
          configuration all run in the controller, not in this browser.
        </p>
        <p className="current-user-note">
          Reload to try again. If it keeps happening, the browser console holds the stack worth
          reporting.
        </p>
        <p className="current-user-note">{error.message}</p>
        <button type="button" onClick={() => globalThis.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
