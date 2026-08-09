import { expect, test, type Page } from '@playwright/test'

import { administratorSession, useSession } from './session.js'

/**
 * Below 400px. The top bar overflowed a 390px viewport until it was fixed on
 * 2026-08-06, and nothing else had been measured — so this walks every screen at
 * the narrowest width the product claims to support and fails on the specific
 * thing a phone user actually experiences: the page scrolling sideways.
 *
 * 360px is the common Android width and 320px is the narrowest device still in
 * use. Wide content is allowed to scroll, but only inside its own container.
 */
const WIDTHS = [
  { name: '320px', width: 320 },
  { name: '360px', width: 360 },
  { name: '390px', width: 390 },
]

const SCREENS = [
  { name: 'Overview', path: '/' },
  { name: 'Devices', path: '/devices' },
  { name: 'Dashboards', path: '/dashboards' },
  { name: 'Alerts', path: '/alerts' },
  { name: 'Sites', path: '/sites' },
  { name: 'Polling profiles', path: '/polling-profiles' },
  { name: 'Collectors', path: '/collectors' },
  { name: 'Contacts', path: '/contacts' },
  { name: 'Storage', path: '/storage' },
  { name: 'Credentials', path: '/credentials' },
  { name: 'Users', path: '/users' },
  { name: 'Settings', path: '/settings' },
]

let administratorCookie = ''

test.beforeAll(async ({ request }) => {
  administratorCookie = await administratorSession(request)
})

test.beforeEach(async ({ context }) => {
  await useSession(context, administratorCookie)
})

/**
 * The document scrolling sideways, which is the defect. An element wider than the
 * viewport is fine as long as it scrolls within itself, so this measures the page
 * rather than every node.
 */
async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement
    return Math.max(0, root.scrollWidth - root.clientWidth)
  })
}

/** Named so a failure says which element is pushing the page wide. */
async function offendingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth
    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase()
      const className = typeof element.className === 'string' ? element.className : ''
      const identity = className ? `.${className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''
      const text = (element.textContent ?? '').trim().slice(0, 30)
      return `${tag}${identity} (${Math.round(element.getBoundingClientRect().right)}px) "${text}"`
    }
    return [...document.querySelectorAll('body *')]
      .filter((element) => {
        const box = element.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return false
        // Something that scrolls inside itself is not the problem.
        const style = getComputedStyle(element)
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return false
        return box.right > limit + 1
      })
      .slice(0, 6)
      .map(describe)
  })
}

for (const viewport of WIDTHS) {
  test.describe(`at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: 780 } })

    for (const screen of SCREENS) {
      test(`${screen.name} does not scroll sideways`, async ({ page }) => {
        await page.goto(screen.path)
        // The shell is what every screen shares; waiting on it avoids measuring
        // a half-rendered page.
        await expect(page.getByRole('navigation')).toBeAttached()
        await page.waitForLoadState('networkidle')

        const overflow = await documentOverflow(page)
        if (overflow > 0) {
          const offenders = await offendingElements(page)
          expect(
            overflow,
            `${screen.name} overflows by ${overflow}px at ${viewport.name}. Widest: ${offenders.join(' | ')}`,
          ).toBe(0)
        }
        expect(overflow).toBe(0)
      })
    }
  })
}

test.describe('the inventory table on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('every device row stays reachable without moving the page', async ({ page }) => {
    await page.goto('/devices')
    await expect(page.getByRole('navigation')).toBeAttached()
    await page.waitForLoadState('networkidle')

    // A table wider than the phone is expected; it must carry its own scroller
    // rather than widening the document.
    expect(await documentOverflow(page)).toBe(0)

    const rows = page.getByRole('row')
    // Not `test.skip`: this environment is seeded with devices, so an empty table
    // means the page failed to load and the check silently measured nothing.
    await expect(rows.first()).toBeVisible()
    const count = await rows.count()
    expect(count, 'the inventory table rendered no rows').toBeGreaterThan(0)

    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index)
      await expect(row).toBeVisible()
      const box = await row.boundingBox()
      expect(box, 'the row has no box').not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.width).toBeLessThanOrEqual(360 + 1)
    }
  })
})

test.describe('the top bar on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('its controls stay inside the viewport', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('navigation')).toBeAttached()
    await page.waitForLoadState('networkidle')

    const banner = page.getByRole('banner')
    await expect(banner).toBeVisible()
    const box = await banner.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(360 + 1)

    for (const control of await banner.getByRole('button').all()) {
      if (!(await control.isVisible())) continue
      const controlBox = await control.boundingBox()
      if (!controlBox) continue
      expect(controlBox.x).toBeGreaterThanOrEqual(-1)
      expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(360 + 1)
    }
  })
})
