import { describe, expect, it, vi } from 'vitest'

import { GrafanaApiClient } from './grafana.js'

/**
 * Ownership collisions (audit F3, and its second pass).
 *
 * Contact points were found, overwritten, and deleted by name, so one an
 * operator had created themselves was adopted whenever it shared a name with
 * ours. Recording the uid fixed that going forward; it did not stop the *first*
 * encounter adopting by name, which is what the follow-up caught. A same-named
 * remote is only ours if the controller has a record of writing it.
 */
function client(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    calls.push({ url: path, method: init?.method ?? 'GET' })
    const handler =
      handlers[`${init?.method ?? 'GET'} ${path}`] ?? handlers[path] ?? handlers.default
    if (!handler) throw new Error(`unexpected call: ${init?.method ?? 'GET'} ${path}`)
    return Promise.resolve(handler(init))
  }) as unknown as typeof fetch
  return { api: GrafanaApiClient.bearer('http://grafana.invalid/', 'token', fetchImpl), calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Grafana contact point ownership', () => {
  it('refuses a same-named contact point the controller has no record of writing', async () => {
    const { api } = client({
      '/api/v1/provisioning/contact-points': () => json([{ uid: 'theirs', name: 'Ops' }]),
    })

    await expect(
      api.upsertContactPoint({ name: 'Ops' }, null, /* previouslyWritten */ false),
    ).rejects.toThrow(/did not create/)
  })

  it('adopts a same-named contact point once when it did write it before', async () => {
    // The upgrade path: created before uids were recorded, so the registry has a
    // row for it but no uid. Adopting is a migration, not a hijack.
    const { api } = client({
      '/api/v1/provisioning/contact-points': () => json([{ uid: 'ours-from-before', name: 'Ops' }]),
      'PUT /api/v1/provisioning/contact-points/ours-from-before': () => json({}),
    })

    const written = await api.upsertContactPoint({ name: 'Ops' }, null, true)
    expect(written).toEqual({ uid: 'ours-from-before', adopted: true })
  })

  it('writes by recorded uid without consulting names at all', async () => {
    const { api, calls } = client({
      '/api/v1/provisioning/contact-points/known': () => json({ uid: 'known', name: 'Whatever' }),
      'PUT /api/v1/provisioning/contact-points/known': () => json({}),
    })

    const written = await api.upsertContactPoint({ name: 'Renamed' }, 'known', true)
    expect(written).toEqual({ uid: 'known', adopted: false })
    // A rename must not orphan the old remote by creating a second one.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    expect(calls.some((call) => call.url === '/api/v1/provisioning/contact-points')).toBe(false)
  })

  /**
   * The hole the audit's third pass found. A recorded uid that has vanished used
   * to fall through to name matching with "we wrote this before" still true, so
   * a same-named contact point that appeared in its place — somebody else's —
   * was written to. Adoption is only ever a migration from before uids existed.
   */
  it('never adopts a same-named stranger after its own remote has vanished', async () => {
    const { api, calls } = client({
      '/api/v1/provisioning/contact-points/ours-gone': () => json({ message: 'gone' }, 404),
      '/api/v1/provisioning/contact-points': (init) =>
        init?.method === 'POST' ? json({ uid: 'fresh' }) : json([{ uid: 'theirs', name: 'Ops' }]),
    })

    // Refusing, not silently recreating: Grafana requires contact-point names to
    // be unique, so a second "Ops" is not available anyway. Saying which name
    // collides is the only useful outcome.
    await expect(api.upsertContactPoint({ name: 'Ops' }, 'ours-gone', true)).rejects.toThrow(
      /did not create/,
    )
    expect(
      calls.some((call) => call.url.endsWith('/theirs')),
      'wrote to a contact point it did not create',
    ).toBe(false)
  })

  it('recreates when the recorded uid has been deleted in Grafana', async () => {
    const { api } = client({
      '/api/v1/provisioning/contact-points/gone': () => json({ message: 'not found' }, 404),
      '/api/v1/provisioning/contact-points': (init) =>
        init?.method === 'POST' ? json({ uid: 'fresh' }) : json([]),
    })

    const written = await api.upsertContactPoint({ name: 'Ops' }, 'gone', true)
    expect(written.uid).toBe('fresh')
  })

  it('never escalates a service account it has no record of creating', async () => {
    const { api } = client({
      '/api/serviceaccounts/7': () => json({ message: 'not found' }, 404),
      default: () => json({}),
    })
    expect(await api.getServiceAccount(7)).toBeNull()
  })
})

// Silences nothing; makes an unexpected network call an obvious failure.
vi.stubGlobal('fetch', () => {
  throw new Error('a test reached the real network')
})
