import { request } from '@playwright/test'

/**
 * Gives the end-to-end suite the world it assumes.
 *
 * Five tests used to fail on a clean installation and pass on a developer's own
 * machine, because they quietly relied on whatever that machine happened to be
 * monitoring — a site tree, a device, collected metrics, a configured Grafana.
 * They were proving less than they appeared to, and CI is where that showed.
 *
 * Everything here is idempotent and additive. It creates what is missing under
 * names of its own and leaves anything else alone, so running the suite against a
 * populated instance does not disturb it.
 *
 * What each step exists for:
 *
 *   storage    the QuestDB tables, without which no graph can draw
 *   Grafana    the dashboards behind every "Open in Grafana" deep link
 *   a source   the device pages and the inventory table
 *   metrics    `latestSources` is empty until something has actually reported
 */

const baseURL = process.env.PRICKLESCOPE_E2E_BASE_URL ?? 'http://localhost:5173'
const questdbUrl = process.env.PRICKLESCOPE_E2E_QUESTDB_URL ?? 'http://localhost:9000'
const password = 'pricklescope-admin-dev-only'

/** Named so a human looking at a seeded instance knows where it came from. */
const FIXTURE = {
  credential: 'E2E fixture credential',
  site: 'E2E fixture site',
  source: 'e2e-fixture-device.example',
}

const log = (message: string): void => console.log(`  [e2e fixture] ${message}`)

async function questdb(sql: string): Promise<void> {
  const response = await fetch(`${questdbUrl}/exec?query=${encodeURIComponent(sql)}`)
  if (!response.ok) {
    throw new Error(`QuestDB rejected a statement: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { error?: string }
  if (body.error) throw new Error(`QuestDB rejected a statement: ${body.error}`)
}

export default async function globalSetup(): Promise<void> {
  const api = await request.newContext({ baseURL })

  // The dev servers are started by Playwright's webServer, which returns as soon
  // as the port answers — the API may still be applying migrations.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await api.get('/api/v1/auth/providers').catch(() => null)
    if (probe?.ok()) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  const login = await api.post('/api/v1/auth/login', {
    headers: { origin: baseURL },
    data: { username: 'admin', password },
  })
  if (!login.ok()) throw new Error(`fixture could not sign in: ${login.status()}`)
  const { csrfToken } = (await login.json()) as { csrfToken: string }
  const write = { origin: baseURL, 'x-csrf-token': csrfToken }

  /** Enqueues a job and waits for it, so the next step sees its effect. */
  const runJob = async (path: string, label: string): Promise<void> => {
    const started = await api.post(path, { headers: write })
    if (!started.ok()) {
      log(`${label} could not be started (${started.status()}); continuing`)
      return
    }
    const { id } = (await started.json()) as { id: string }
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const job = await api.get(`/api/v1/jobs/${id}`)
      const status = job.ok() ? ((await job.json()) as { status: string }).status : 'unknown'
      if (status === 'succeeded') return log(`${label} applied`)
      if (status === 'failed' || status === 'cancelled') {
        // Not fatal: a test that needs it will fail with its own message, which
        // is more useful than this one.
        return log(`${label} ${status}; continuing`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    log(`${label} did not finish in time; continuing`)
  }

  // 1. Retention, which is what creates the QuestDB tables and rollups.
  const storage = await api.get('/api/v1/storage')
  const applied = storage.ok() && (await storage.json()).status === 'active'
  if (!applied) {
    await api.put('/api/v1/storage/policy', {
      headers: write,
      data: { rawRetentionDays: 30, fiveMinuteRetentionDays: 365, hourlyRetentionDays: 1825 },
    })
    await runJob('/api/v1/storage/reconcile', 'storage')
  } else {
    log('storage already applied')
  }

  // 2. Grafana, for the dashboards every deep link points at.
  const grafana = await api.get('/api/v1/grafana')
  const grafanaReady = grafana.ok() && (await grafana.json()).status === 'active'
  if (!grafanaReady) {
    await runJob('/api/v1/grafana/reconcile', 'Grafana')
  } else {
    log('Grafana already reconciled')
  }

  // 3. A credential, a site, and a source to hang the graphs on.
  const named = async <T extends { name: string; id: string }>(
    path: string,
    key: string,
    name: string,
  ): Promise<T | undefined> => {
    const response = await api.get(path)
    if (!response.ok()) return undefined
    const body = (await response.json()) as Record<string, T[]>
    return (body[key] ?? []).find((item) => item.name === name)
  }

  let credential = await named<{ id: string; name: string }>(
    '/api/v1/credentials/snmp',
    'credentials',
    FIXTURE.credential,
  )
  if (!credential) {
    const created = await api.post('/api/v1/credentials/snmp', {
      headers: write,
      data: { name: FIXTURE.credential, version: '2c', community: 'e2e-fixture-community' },
    })
    if (created.ok()) credential = (await created.json()) as { id: string; name: string }
    log('credential created')
  }

  let site = await named<{ id: string; name: string }>('/api/v1/sites', 'sites', FIXTURE.site)
  if (!site) {
    const created = await api.post('/api/v1/sites', {
      headers: write,
      data: { name: FIXTURE.site, parentId: null },
    })
    if (created.ok()) site = (await created.json()) as { id: string; name: string }
    log('site created')
  }

  const profiles = await api.get('/api/v1/polling-profiles')
  const profile = profiles.ok()
    ? ((await profiles.json()) as { profiles: { id: string }[] }).profiles[0]
    : undefined

  let source = await named<{ id: string; name: string }>(
    '/api/v1/sources',
    'sources',
    FIXTURE.source,
  )
  if (!source && credential && profile) {
    const created = await api.post('/api/v1/sources', {
      headers: write,
      data: {
        name: FIXTURE.source,
        // Reserved for documentation (RFC 5737). It will never answer, which is
        // fine: the metrics below are written directly.
        target: '192.0.2.10',
        credentialId: credential.id,
        profileId: profile.id,
        ...(site ? { siteId: site.id } : {}),
      },
    })
    if (created.ok()) source = (await created.json()) as { id: string; name: string }
    log('source created')
  }
  if (!source) {
    log('no source could be created; device and graph tests will fail with their own message')
    await api.dispose()
    return
  }

  // 4. Metrics. `latestSources` stays empty until something has reported, and an
  //    inventoried but never-polled device legitimately draws no chart — so the
  //    graph tests need real rows, not just a device.
  const reporting = await api.get('/api/v1/graphs/fleet')
  const alreadyReporting =
    reporting.ok() &&
    ((await reporting.json()) as { latestSources: { sourceId: string }[] }).latestSources.some(
      (entry) => entry.sourceId === source.id,
    )

  if (alreadyReporting) {
    log('the fixture source is already reporting')
  } else {
    // Columns are listed explicitly. An INSERT without a list has to match every
    // column in the table, and QuestDB adds columns on its own when Telegraf
    // sends a field the schema did not declare — so the count differs between a
    // fresh instance and one that has been collecting.
    const identity =
      'environment, collector, host, source, source_id, check_id, source_name, site_id, source_tags'
    const identityValues = `'e2e', 'telegraf', 'e2e-runner', '192.0.2.10', '${source.id}', '${source.id}', '${FIXTURE.source}', '${site?.id ?? ''}', ''`
    // Two hours of one-minute samples, ending now, so any default range has data.
    const from = new Date(Date.now() - 120 * 60_000).toISOString()

    await questdb(`insert into network_availability
      (timestamp, ${identity}, url, packets_transmitted, packets_received,
       percent_packet_loss, minimum_response_ms, average_response_ms,
       maximum_response_ms, standard_deviation_ms, ttl, result_code)
      select timestamp_sequence('${from}', 60000000L),
        ${identityValues},
        '192.0.2.10',
        1L, 1L, 0.0,
        cast(8 + (x % 5) as double),
        cast(12 + (x % 7) as double),
        cast(20 + (x % 11) as double),
        1.5, 64L, 0L
      from long_sequence(120)`)

    await questdb(`insert into network_interface_rate
      (timestamp, ${identity}, if_index, if_description,
       if_in_octets_per_second, if_out_octets_per_second,
       if_in_errors_per_second, if_out_errors_per_second)
      select timestamp_sequence('${from}', 60000000L),
        ${identityValues},
        '1', 'eth0',
        cast(1000000 + (x % 500000) as double),
        cast(800000 + (x % 400000) as double),
        0.0, 0.0
      from long_sequence(120)`)

    // QuestDB's WAL applies asynchronously, so a query straight after the insert
    // can legitimately see nothing.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const fleet = await api.get('/api/v1/graphs/fleet')
      if (fleet.ok()) {
        const { latestSources } = (await fleet.json()) as { latestSources: { sourceId: string }[] }
        if (latestSources.some((entry) => entry.sourceId === source.id)) break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    log('metrics written')
  }

  await api.dispose()
}
