import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { administratorSession, useSession } from './session.js'

/**
 * Captures the screenshots the README and the docs use.
 *
 * These are generated rather than taken by hand so they cannot quietly stop
 * matching the product. Run with:
 *
 *   corepack pnpm --filter @pricklescope/web exec playwright test screenshots
 *
 * It is skipped in ordinary runs — a normal test run should not rewrite files in
 * the repository — and opted into with SCREENSHOTS=1.
 */

const OUTPUT = resolve(import.meta.dirname, '../../../../docs/images')
const capture = process.env.SCREENSHOTS === '1'

/**
 * Replaces anything that identifies a real network before the shutter opens.
 *
 * These images are taken against whatever fleet the developer happens to be
 * monitoring, and they end up in a public README. Hostnames, addresses, and site
 * names from someone's actual infrastructure are not ours to publish, and a
 * reviewer glancing at a PNG will not notice a subnet in the corner of a chart
 * legend.
 *
 * Substitution is by pattern, not by a list of known values, so an unfamiliar
 * device is masked too. `example.net` and the documentation ranges from RFC 5737
 * are reserved for exactly this.
 */
async function maskIdentifiers(page: Page, literals: string[]): Promise<void> {
  await page.evaluate((exact) => {
    const names = new Map<string, string>()
    const demo = (key: string, prefix: string): string => {
      if (!names.has(key)) names.set(key, `${prefix}-${String(names.size + 1).padStart(2, '0')}`)
      return names.get(key)!
    }
    const cities = ['Brussels', 'Rotterdam', 'Lisbon', 'Tallinn', 'Porto']

    const mask = (text: string): string => {
      let output = text

      // Exact strings the API told us are real: site names, and source names
      // that carry no pattern to match on. Longest first, so a name that
      // contains another is replaced whole.
      exact.forEach((value, index) => {
        if (!value) return
        output = output.split(value).join(cities[index % cities.length]!)
      })

      // Fully qualified names: keep the shape, lose the organisation.
      output = output.replace(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+\b/gi, (match) => {
        if (/^(localhost|grafana|questdb|postgres|telegraf)$/i.test(match)) return match
        if (/example\.(net|com|test)$/i.test(match)) return match
        return `${demo(match, 'edge-sw')}.example.net`
      })

      // IPv4 literals — but not the leading octets of a longer dotted run. An
      // SNMP object id starts 1.3.6.1.4.1, and matching that turns a legitimate
      // value into nonsense while pretending to protect something.
      output = output.replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, (match) =>
        match === '127.0.0.1' ? match : `192.0.2.${(demo(match, 'ip').length % 200) + 10}`,
      )

      return output
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    for (const node of nodes) {
      const masked = mask(node.nodeValue ?? '')
      if (masked !== node.nodeValue) node.nodeValue = masked
    }
  }, literals)
}

/** Site and source names, straight from the API, so nothing is guessed at. */
async function realNames(page: Page): Promise<string[]> {
  const collected = new Set<string>()
  for (const [path, key] of [
    ['/api/v1/sites', 'sites'],
    ['/api/v1/sources', 'sources'],
  ] as const) {
    const response = await page.request.get(path)
    if (!response.ok()) continue
    const body = (await response.json()) as Record<string, { name?: string }[]>
    for (const item of body[key] ?? []) if (item.name) collected.add(item.name)
  }
  // Longest first: a name that contains another must be replaced whole.
  return [...collected].sort((left, right) => right.length - left.length)
}

let administratorCookie = ''

test.describe('product screenshots', () => {
  test.skip(!capture, 'set SCREENSHOTS=1 to regenerate the documentation images')
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

  test.beforeAll(async ({ request }) => {
    administratorCookie = await administratorSession(request)
    await mkdir(OUTPUT, { recursive: true })
  })

  test.beforeEach(async ({ context }) => {
    await useSession(context, administratorCookie)
  })

  const shot = async (page: Page, name: string, path: string) => {
    await page.goto(path)
    await expect(page.getByRole('navigation')).toBeVisible()
    await page.waitForLoadState('networkidle')
    // uPlot draws on a canvas after layout settles; without this the charts are
    // captured mid-render.
    await page.waitForTimeout(1200)
    await maskIdentifiers(page, await realNames(page))
    const file = resolve(OUTPUT, `${name}.png`)
    await mkdir(dirname(file), { recursive: true })
    await page.screenshot({ path: file, fullPage: false })
  }

  test('overview', async ({ page }) => {
    await shot(page, 'overview', '/')
  })

  test('devices', async ({ page }) => {
    await shot(page, 'devices', '/devices')
  })

  test('device detail', async ({ page }) => {
    await page.goto('/devices')
    await expect(page.getByRole('navigation')).toBeVisible()
    // The row link specifically: `getByRole('row')` also matches the header.
    const firstDevice = page.locator('a.device-row').first()
    await expect(firstDevice).toBeVisible()
    await firstDevice.click()
    await expect(page).toHaveURL(/\/devices\/[0-9a-f-]+/)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1200)
    await maskIdentifiers(page, await realNames(page))
    await page.screenshot({ path: resolve(OUTPUT, 'device-detail.png') })
  })

  test('alerts', async ({ page }) => {
    await shot(page, 'alerts', '/alerts')
  })

  test('collectors', async ({ page }) => {
    await shot(page, 'collectors', '/collectors')
  })

  test('storage', async ({ page }) => {
    await shot(page, 'storage', '/storage')
  })
})
