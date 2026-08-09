import { defineConfig } from '@playwright/test'

const baseURL = process.env.PRICKLESCOPE_E2E_BASE_URL ?? 'http://localhost:5173'

export default defineConfig({
  testDir: './tests/e2e',
  // Seeds the world the suite assumes: QuestDB tables, Grafana dashboards, a
  // device, and metrics for it. Five tests used to pass only on a machine that
  // already had those, which CI exposed. Idempotent and additive.
  globalSetup: './tests/e2e/global-setup.ts',
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
