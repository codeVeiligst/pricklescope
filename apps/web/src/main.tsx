import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import 'uplot/dist/uPlot.min.css'

import { App } from './app.js'
import { ErrorBoundary } from './components/error-boundary.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('PrickleScope application root was not found')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
