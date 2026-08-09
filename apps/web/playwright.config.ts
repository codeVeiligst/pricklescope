import { defineConfig } from '@playwright/test'

const baseURL = process.env.PRICKLESCOPE_E2E_BASE_URL ?? 'http://localhost:5173'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'corepack pnpm --dir ../.. dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
