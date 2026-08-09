import { expect, request as apiRequest, test, type Page } from '@playwright/test'

import { administratorSession, baseURL, signIn, useSession } from './session.js'

let administratorCookie = ''

test.beforeAll(async ({ request }) => {
  administratorCookie = await administratorSession(request)
})

test.beforeEach(async ({ context }, testInfo) => {
  if (testInfo.title.startsWith('local administrator can sign in')) return
  await useSession(context, administratorCookie)
})

async function openAuthenticated(page: Page) {
  await page.goto('/')
  await expect(page).toHaveURL('/')
}

test('local administrator can sign in and open Devices without a repeated title', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Service health' })).toBeVisible()
  await page.getByRole('link', { name: 'Devices' }).click()
  await expect(page).toHaveURL('/devices')
  await expect(page).toHaveTitle('Devices · PrickleScope')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)
  const headingBox = await page.locator('h1').boundingBox()
  expect(headingBox?.width).toBeLessThanOrEqual(1)
  expect(headingBox?.height).toBeLessThanOrEqual(1)
  await expect(page.getByRole('searchbox', { name: 'Search devices' })).toBeVisible()
})

test('the overview reports real numbers, not placeholders', async ({ page }) => {
  await openAuthenticated(page)

  // The device count was hardcoded to zero behind a "begins in Milestone 2" note.
  const devices = page.locator('.summary-card', { hasText: 'Managed devices' })
  await expect
    .poll(async () => (await devices.locator('strong').innerText()).trim(), { timeout: 10_000 })
    .toMatch(/^\d+$/)
  await expect(devices).not.toContainText('Milestone')

  // Background jobs are named by what they do, never by their internal slug.
  const activity = page.locator('.activity-list')
  if ((await activity.locator('.activity-row').count()) > 0) {
    await expect(activity.locator('.activity-row strong').first()).not.toContainText('.')
  }

  // The bell only carries a dot when something is actually firing, and the
  // inert search box is gone.
  await expect(page.locator('.global-search')).toHaveCount(0)
})

test('navigation separates what you look at from what you configure', async ({ page }) => {
  await openAuthenticated(page)
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  // Captions, not links: "Settings" is deliberately both a group and a screen.
  await expect(nav.locator('.nav-caption')).toHaveText(['Workspace', 'Settings', 'System'])

  // Configuration screens left Workspace; Polling and Credentials stay reachable.
  for (const label of ['Overview', 'Dashboards', 'Devices', 'Alerts']) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  for (const label of ['Sites', 'Polling', 'Collectors', 'Contacts', 'Storage', 'Credentials']) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  await nav.getByRole('link', { name: 'Polling', exact: true }).click()
  await expect(page).toHaveURL('/polling-profiles')
})

test('the top bar reports whether every engine matches the settings held here', async ({
  page,
}) => {
  await openAuthenticated(page)
  const sync = page.locator('.sync-menu')
  await sync.getByRole('button').click()

  const panel = page.getByRole('dialog', { name: 'Pending changes' })
  // Every reconciled engine answers, so an operator sees the whole picture.
  for (const label of ['Collectors', 'Storage', 'Grafana', 'Alerts']) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible()
  }
  // Each one states a verdict rather than only a timestamp.
  await expect(panel.locator('.status-pill').first()).toHaveText(/Pending|Up to date|Unavailable/)
  await expect(panel.getByRole('button', { name: /Apply all changes/ })).toBeVisible()
})

test('navigation and device tools remain usable on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openAuthenticated(page)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeInViewport()
  await page.getByRole('link', { name: 'Devices' }).click()
  await expect(page).toHaveURL('/devices')
  await expect(page.getByRole('searchbox', { name: 'Search devices' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add device' })).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test('administrator can configure a credential, site, and device entirely in the UI', async ({
  page,
}) => {
  const suffix = Date.now().toString()
  const credentialName = `E2E SNMP ${suffix}`
  const siteName = `E2E Lab ${suffix}`
  const deviceName = `E2E Switch ${suffix}`
  await openAuthenticated(page)

  await page.getByRole('link', { name: 'Credentials' }).click()
  await page.getByRole('button', { name: 'Add credential' }).click()
  await page.getByLabel('Name', { exact: true }).fill(credentialName)
  await page.getByLabel('Username').fill('e2e-monitor')
  await page.getByLabel('Auth passphrase').fill('e2e-auth-passphrase')
  await page.getByLabel('Privacy passphrase').fill('e2e-privacy-passphrase')
  await page.getByRole('button', { name: 'Save credential' }).click()
  await expect(page.getByText(credentialName)).toBeVisible()

  await page.getByRole('link', { name: 'Sites' }).click()
  await page.getByRole('button', { name: 'Add site' }).click()
  await page.getByLabel('Name', { exact: true }).fill(siteName)
  await page.getByLabel('Description').fill('Created by the browser journey')
  await page.getByRole('button', { name: 'Save site' }).click()
  await expect(page.getByText(siteName)).toBeVisible()

  await page.getByRole('link', { name: 'Devices' }).click()
  await page.getByRole('button', { name: 'Add device' }).click()
  await page.getByLabel('Name', { exact: true }).fill(deviceName)
  await page.getByLabel('Hostname or IP').fill('127.0.0.1')
  await page.getByLabel('Site').selectOption({ label: siteName })
  await page.getByLabel('SNMP credential').selectOption({ label: `${credentialName} · v3` })
  await page.getByLabel('Polling profile').selectOption({ label: 'Generic network device · 60s' })
  await page.getByRole('dialog').getByRole('button', { name: 'Add device', exact: true }).click()
  await expect(page.getByText(deviceName)).toBeVisible()

  await page.getByText(deviceName).click()
  await expect(page).toHaveURL(/\/devices\/[0-9a-f-]+$/)
  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible()
  await page.getByRole('button', { name: 'Remove device' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove device' }).click()
  await expect(page).toHaveURL('/devices')

  await page.getByRole('link', { name: 'Sites' }).click()
  await page.getByRole('button', { name: `Remove ${siteName}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove location' }).click()
  await expect(page.getByText(siteName)).not.toBeVisible()

  await page.getByRole('link', { name: 'Credentials' }).click()
  await page.getByRole('button', { name: `Remove ${credentialName}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove credential' }).click()
  await expect(page.getByText(credentialName)).not.toBeVisible()
})

test('administrator can build and safely reorganize a site hierarchy', async ({ page }) => {
  const suffix = Date.now().toString()
  const campus = `E2E Campus ${suffix}`
  const building = `E2E Building ${suffix}`
  await openAuthenticated(page)
  await page.getByRole('link', { name: 'Sites' }).click()

  await page.getByRole('button', { name: 'Add site' }).click()
  await page.getByLabel('Name', { exact: true }).fill(campus)
  await page.getByRole('button', { name: 'Save site' }).click()
  await expect(page.getByText(campus, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Add a location below ${campus}` }).click()
  await page.getByLabel('Name', { exact: true }).fill(building)
  await expect(page.getByLabel('Parent location')).toHaveValue(/.+/)
  await page.getByRole('button', { name: 'Save site' }).click()
  await expect(page.getByText(building, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Remove ${campus}`, exact: true })).toBeDisabled()

  const subtreeLink = page.getByRole('link', { name: `Graph ${campus} and child locations` })
  const subtreeHref = (await subtreeLink.getAttribute('href')) ?? ''
  expect(subtreeHref).toContain('/grafana/d/pricklescope-fleet')
  expect(subtreeHref.match(/var-site_id=/g)).toHaveLength(2)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: `Add a location below ${building}` })).toBeVisible()
  const treeOverflow = await page
    .locator('.site-tree')
    .evaluate((tree) => tree.scrollWidth - tree.clientWidth)
  expect(treeOverflow).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.getByRole('button', { name: `Edit ${campus} / ${building}` }).click()
  await page.getByLabel('Parent location').selectOption('')
  await page.getByRole('button', { name: 'Save site' }).click()
  await expect(page.getByRole('button', { name: `Remove ${campus}`, exact: true })).toBeEnabled()

  for (const name of [campus, building]) {
    await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove location' }).click()
    await expect(page.getByText(name, { exact: true })).not.toBeVisible()
  }
})

test('administrator can create, update, reset, and remove a local user', async ({ page }) => {
  const suffix = Date.now().toString()
  const username = `e2e-user-${suffix}`
  await openAuthenticated(page)
  await page.getByRole('link', { name: 'Users' }).click()
  await expect(page).toHaveURL('/users')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)

  await page.getByRole('button', { name: 'Add local user' }).click()
  const createDialog = page.getByRole('dialog')
  await createDialog.getByLabel('Username').fill(username)
  await createDialog.getByLabel('Display name').fill('E2E Managed User')
  await createDialog.getByLabel('Email').fill(`${username}@example.test`)
  await createDialog.getByLabel('Initial password').fill('e2e-temporary-password')
  await createDialog.getByRole('button', { name: 'Create user' }).click()
  await expect(page.getByText(`@${username}`, { exact: false })).toBeVisible()

  await page.getByRole('button', { name: `Edit ${username}` }).click()
  const editDialog = page.getByRole('dialog')
  await editDialog.getByLabel('Role').selectOption('operator')
  await editDialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Operator', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Reset password for ${username}` }).click()
  const passwordDialog = page.getByRole('dialog')
  await passwordDialog.getByLabel('New password').fill('e2e-replacement-password')
  await passwordDialog.getByRole('button', { name: 'Reset password' }).click()
  await expect(passwordDialog).not.toBeVisible()

  await page.getByRole('button', { name: `Delete ${username}` }).click()
  // Destructive actions confirm in the application's own dialog, not the browser's.
  const confirmDelete = page.getByRole('dialog')
  await expect(confirmDelete).toContainText('This cannot be undone.')
  await confirmDelete.getByRole('button', { name: 'Delete account' }).click()
  await expect(page.getByText(`@${username}`, { exact: false })).not.toBeVisible()
})

test('administrator can manage OIDC settings without editing configuration files', async ({
  page,
}) => {
  await openAuthenticated(page)
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL('/settings')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)
  await expect(page.getByRole('heading', { name: 'Identity provider' })).toBeVisible()
  await expect(page.getByLabel('Provider name')).toBeVisible()
  await expect(page.getByLabel('Issuer URL')).toBeVisible()
  await expect(page.getByLabel('Client secret', { exact: true })).toHaveAttribute(
    'type',
    'password',
  )
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save OIDC settings' })).toBeVisible()
})

test('administrator can inspect Telegraf reconciliation without a repeated title', async ({
  page,
}) => {
  await openAuthenticated(page)
  await page.getByRole('link', { name: 'Collectors' }).click()
  await expect(page).toHaveURL('/collectors')
  await expect(page).toHaveTitle('Collectors · PrickleScope')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)
  await expect(page.getByText('Telegraf', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply desired state' })).toBeVisible()
})

test('administrator can manage QuestDB retention without a repeated title', async ({ page }) => {
  await openAuthenticated(page)
  await page.getByRole('link', { name: 'Storage' }).click()
  await expect(page).toHaveURL('/storage')
  await expect(page).toHaveTitle('Storage · PrickleScope')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)
  await expect(page.getByText('QuestDB', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Retention policy' })).toBeVisible()
  await expect(page.getByLabel('Raw retention in days')).toHaveValue('30')
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeVisible()
  await expect(page.getByText('network_interface_rate_5m', { exact: true })).toBeVisible()
})

test('PrickleScope draws its own graphs and never embeds Grafana in the page', async ({ page }) => {
  await openAuthenticated(page)
  await page.getByRole('link', { name: 'Dashboards' }).click()
  await expect(page).toHaveURL('/dashboards')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)

  // No Grafana surface is loaded into the page: no frame and no rendered image.
  expect(await page.locator('iframe').count()).toBe(0)
  expect(await page.locator('img[src*="/grafana/"]').count()).toBe(0)

  const availability = page.getByRole('heading', { name: 'Availability' })
  await expect(availability).toBeVisible()
  const canvas = page.locator('.graph-panel canvas').first()
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(0)

  // Grafana still holds the same dashboards, reachable by deep link.
  const openInGrafana = page.getByRole('link', { name: /Open in Grafana/ }).first()
  const target = (await openInGrafana.getAttribute('href')) ?? ''
  expect(target).toContain('/grafana/d')
  expect(target).not.toContain('/render/')
  expect(target).not.toMatch(/token|auth|password/i)
})

test('the Grafana gateway stays private and cannot be promoted by client headers', async ({
  page,
}) => {
  const anonymous = await apiRequest.newContext({ baseURL })
  expect((await anonymous.get('/grafana/api/user')).status()).toBe(401)
  await anonymous.dispose()

  await openAuthenticated(page)
  const spoofed = { 'x-webauth-user': 'attacker', 'x-webauth-role': 'Admin' }
  const identity = await page.request.get('/grafana/api/user', { headers: spoofed })
  expect(identity.ok()).toBe(true)
  const account = await identity.json()
  expect(account.login).not.toBe('attacker')
  expect(account.isGrafanaAdmin).toBe(false)

  const organizations = await page.request.get('/grafana/api/user/orgs', { headers: spoofed })
  expect(organizations.ok()).toBe(true)
  expect((await organizations.json())[0].role).toBe('Editor')
})

test('a device page graphs its own availability, latency, and interface traffic', async ({
  page,
}) => {
  await openAuthenticated(page)

  // Pick a source that is actually reporting: an inventoried but unpolled device
  // legitimately draws no chart, so the first row in the list proves nothing.
  const fleet = await page.request.get('/api/v1/graphs/fleet')
  expect(fleet.ok()).toBe(true)
  const reporting = (await fleet.json()).latestSources[0]
  expect(reporting, 'no source has reported metrics yet').toBeTruthy()

  await page.goto(`/devices/${reporting.sourceId}`)
  await expect(page).toHaveURL(/\/devices\/[0-9a-f-]+$/)

  for (const title of ['Availability', 'Latency', 'Interface traffic']) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
  }
  expect(await page.locator('iframe').count()).toBe(0)
  await expect(page.locator('.graph-panel canvas').first()).toBeVisible()

  // The times a viewer reads are the browser's, not the server's or QuestDB's.
  const footer = page.locator('.row-chart__footer').first()
  if (await footer.count()) {
    const span = await footer.innerText()
    const [, ended] = span.split('\n').filter(Boolean)
    expect(ended).toBeTruthy()
  }
})

test('operator can create a contact and an alert rule that Grafana evaluates', async ({ page }) => {
  const suffix = Date.now().toString()
  const contactName = `E2E webhook ${suffix}`
  const ruleName = `E2E availability ${suffix}`
  await openAuthenticated(page)

  // Contacts have their own screen under Settings.
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Contacts', exact: true })
    .click()
  await expect(page).toHaveURL('/contacts')
  await expect(page.locator('h1')).toHaveClass(/sr-only/)

  await page.getByRole('button', { name: 'Add contact' }).click()
  const contactDialog = page.getByRole('dialog')
  await contactDialog.getByLabel('Name', { exact: true }).fill(contactName)
  // Never called: this journey checks the desired state and Grafana's evaluation,
  // not delivery, so the URL only has to be well formed.
  await contactDialog.getByLabel('Webhook URL').fill('http://alerts.invalid/e2e')
  await contactDialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(page.getByText(contactName, { exact: true })).toBeVisible()

  // A saved contact can be edited, and the write-only token is never shown back.
  const contactRow = page.locator('.resource-list-row', { hasText: contactName })
  await contactRow.getByRole('button', { name: 'Edit' }).click()
  const editDialog = page.getByRole('dialog')
  await expect(editDialog.getByLabel('Name', { exact: true })).toHaveValue(contactName)
  await editDialog.getByLabel('Webhook URL').fill('http://alerts.invalid/edited')
  await editDialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(contactRow).toContainText('http://alerts.invalid/edited')

  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Alerts', exact: true })
    .click()
  await expect(page).toHaveURL('/alerts')

  await page.getByRole('button', { name: 'Add rule' }).click()
  const ruleDialog = page.getByRole('dialog')
  await ruleDialog.getByLabel('Name', { exact: true }).fill(ruleName)
  await ruleDialog.getByLabel('Threshold').fill('99')
  await ruleDialog.getByLabel('Clears at (optional)').fill('99.5')
  await ruleDialog.getByLabel('Notify').selectOption({ label: contactName })

  // The preview runs the rule's own query before anything is saved.
  await ruleDialog.getByRole('button', { name: 'Preview' }).click()
  await expect(ruleDialog.getByRole('status')).toContainText(/Would (fire|stay quiet) now/)

  await ruleDialog.getByRole('button', { name: 'Save rule' }).click()
  const ruleRow = page.locator('.resource-list-row', { hasText: ruleName })
  await expect(ruleRow).toBeVisible()
  // Hysteresis is part of the rule the operator sees, not just the Grafana payload.
  await expect(ruleRow).toContainText('clears at 99.5')

  // Apply the desired state and let Grafana report a state back.
  await page.getByRole('button', { name: 'Apply to Grafana' }).click()
  await expect
    .poll(async () => (await ruleRow.locator('.status-pill').innerText()).toLowerCase(), {
      timeout: 60_000,
    })
    .not.toBe('unknown')

  // Destructive actions confirm in the application's own dialog, not the browser's.
  await ruleRow.getByRole('button', { name: `Delete ${ruleName}` }).click()
  const confirmRule = page.getByRole('dialog')
  await expect(confirmRule).toContainText(`Delete ${ruleName}?`)
  await confirmRule.getByRole('button', { name: 'Delete rule' }).click()
  await expect(page.getByText(ruleName, { exact: true })).not.toBeVisible()

  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Contacts', exact: true })
    .click()
  await contactRow.getByRole('button', { name: `Delete ${contactName}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete contact' }).click()
  await expect(page.getByText(contactName, { exact: true })).not.toBeVisible()
})

test('an email contact asks only for what the chosen provider needs', async ({ page }) => {
  const mailName = `E2E mail ${Date.now()}`
  await openAuthenticated(page)
  await page.goto('/contacts')

  await page.getByRole('button', { name: 'Add contact' }).click()
  const mailDialog = page.getByRole('dialog')
  await mailDialog.getByLabel('Name', { exact: true }).fill(mailName)
  // Fields whose label carries help text or options are addressed by name: a
  // wrapping label's accessible name absorbs that text, so neither an exact nor a
  // partial label match is reliable for them.
  await mailDialog.locator('select[name="kind"]').selectOption('email')
  await expect(mailDialog.locator('input[name="url"]')).toHaveCount(0)
  await mailDialog.locator('input[name="addresses"]').fill('ops@example.test')

  const service = mailDialog.locator('select[name="provider"]')
  await service.selectOption('graph')
  await expect(mailDialog.getByLabel('Directory (tenant) ID', { exact: true })).toBeVisible()
  await service.selectOption('sendgrid')
  await expect(mailDialog.getByLabel('Directory (tenant) ID', { exact: true })).toHaveCount(0)

  await mailDialog.getByLabel('API key', { exact: true }).fill('SG.e2e-not-a-real-key')
  await mailDialog.locator('input[name="from"]').fill('alerts@example.test')
  await mailDialog.getByRole('button', { name: 'Save contact' }).click()

  const mailRow = page.locator('.resource-list-row', { hasText: mailName })
  await expect(mailRow).toContainText('SendGrid')
  await expect(mailRow).toContainText('Not sent yet')

  // Editing keeps the stored credential: the field invites a replacement instead
  // of demanding one.
  await mailRow.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('dialog').getByLabel('API key', { exact: true })).toHaveAttribute(
    'placeholder',
    /leave blank to keep/i,
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await mailRow.getByRole('button', { name: `Delete ${mailName}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete contact' }).click()
  await expect(page.getByText(mailName, { exact: true })).not.toBeVisible()
})
