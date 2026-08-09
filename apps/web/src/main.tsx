import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import 'uplot/dist/uPlot.min.css'

import { App } from './app.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('PrickleScope application root was not found')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
