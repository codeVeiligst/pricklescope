import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from './api.js'

/**
 * Version skew is the failure worth catching here (audit F15): a cached bundle
 * against a newer API, or a proxy answering with its own JSON. Retention is one
 * of the two responses a person acts on irreversibly — shortening a tier drops
 * data — so a shape this build does not understand must say so rather than
 * render a confident wrong number into a confirmation dialog.
 */
afterEach(() => vi.unstubAllGlobals())

function respond(body: unknown) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
}

describe('critical response validation', () => {
  it('refuses a storage overview that is not the shape this build expects', async () => {
    respond({ status: 'active', tables: 'not an array' })
    await expect(api.storage()).rejects.toThrow(/shape this version does not understand/)
  })

  it('refuses a sync status missing its targets', async () => {
    respond({ pendingCount: 0 })
    await expect(api.syncStatus()).rejects.toThrow(/shape this version does not understand/)
  })

  it('passes a well-formed response straight through', async () => {
    respond({ pendingCount: 0, targets: [] })
    await expect(api.syncStatus()).resolves.toEqual({ pendingCount: 0, targets: [] })
  })
})
