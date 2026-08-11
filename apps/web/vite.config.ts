import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: false,
      },
      // The trailing slash matters. A bare `/health` key is a prefix match, so it
      // also swallowed `/health-alerts` and handed a browser the API's 404 JSON
      // instead of the application — a deep link or a refresh on that screen was
      // broken, in development only. The production gateway routes `/health/*`,
      // so this now matches what Caddy does rather than being broader than it.
      '/health/': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: false,
      },
      '/grafana': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
})
