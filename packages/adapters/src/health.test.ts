import { createServer } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { checkHttpDependency, checkTcpDependency } from './health.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('dependency health adapters', () => {
  it('marks an omitted HTTP dependency as disabled', async () => {
    await expect(checkHttpDependency(null, { name: 'Grafana' })).resolves.toMatchObject({
      state: 'disabled',
      latencyMs: null,
    })
  })

  it('detects a reachable TCP service', async () => {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    await expect(
      checkTcpDependency('127.0.0.1', address.port, { name: 'Telegraf' }),
    ).resolves.toMatchObject({ state: 'up' })
  })
})
