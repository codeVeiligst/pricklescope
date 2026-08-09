import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

export const baseURL = process.env.PRICKLESCOPE_E2E_BASE_URL ?? 'http://localhost:5173'

export const administratorPassword = 'pricklescope-admin-dev-only'

/**
 * Signs in over the API once and hands back the session token, so a suite can
 * seed the cookie rather than driving the login form before every test.
 */
export async function administratorSession(request: APIRequestContext): Promise<string> {
  await expect.poll(async () => (await request.get('/api/v1/auth/providers')).status()).toBe(200)
  const response = await request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: administratorPassword },
  })
  expect(response.ok()).toBe(true)
  const setCookie = response.headers()['set-cookie']
  return setCookie.split(';', 1)[0]!.split('=', 2)[1]!
}

export async function useSession(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([{ name: 'pricklescope_session', value: token, url: baseURL }])
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(administratorPassword)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL('/')
}
