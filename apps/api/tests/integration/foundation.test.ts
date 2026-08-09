import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMetadataDatabase, migrateToLatest, type MetadataDatabase } from '@pricklescope/db'
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { bootstrapAdministrator } from '../../src/auth/bootstrap.js'
import { OidcService } from '../../src/auth/oidc.js'
import { AuthStore } from '../../src/auth/store.js'
import { loadConfig, loadEnvironmentFile } from '../../src/config.js'
import { InventoryStore } from '../../src/inventory/store.js'
import { hashPassword, verifyPassword } from '../../src/security.js'

loadEnvironmentFile()
const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must target a database whose name ends in _test')
  }
}
const integration = databaseUrl ? describe : describe.skip

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

class MockOidcProvider {
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  private server: Server | null = null
  private nonce = ''
  private codeChallenge = ''
  issuer = ''

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      if (request.url === '/.well-known/openid-configuration') {
        this.json(response, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        })
        return
      }
      if (request.url === '/jwks') {
        this.json(response, {
          keys: [
            {
              ...this.keys.publicKey.export({ format: 'jwk' }),
              alg: 'RS256',
              kid: 'integration-key',
              use: 'sig',
            },
          ],
        })
        return
      }
      if (request.method === 'POST' && request.url === '/token') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const parameters = new URLSearchParams(Buffer.concat(chunks).toString())
        const verifier = parameters.get('code_verifier') ?? ''
        const receivedChallenge = createHash('sha256').update(verifier).digest('base64url')
        if (
          parameters.get('code') !== 'integration-code' ||
          parameters.get('client_id') !== 'pricklescope-integration' ||
          parameters.get('client_secret') !== 'integration-client-secret' ||
          parameters.get('redirect_uri') !== 'http://localhost:5173/api/v1/auth/oidc/callback' ||
          receivedChallenge !== this.codeChallenge
        ) {
          response.writeHead(400)
          response.end()
          return
        }
        const now = Math.floor(Date.now() / 1_000)
        const header = encodedJson({ alg: 'RS256', kid: 'integration-key', typ: 'JWT' })
        const payload = encodedJson({
          iss: this.issuer,
          sub: 'integration-subject',
          aud: 'pricklescope-integration',
          iat: now,
          exp: now + 300,
          nonce: this.nonce,
          preferred_username: 'oidc-admin',
          name: 'OIDC Administrator',
          email: 'oidc-admin@example.test',
          email_verified: true,
          groups: ['pricklescope-admins'],
        })
        const signature = sign(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          this.keys.privateKey,
        ).toString('base64url')
        this.json(response, {
          access_token: 'integration-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: `${header}.${payload}.${signature}`,
        })
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('OIDC provider did not bind')
    this.issuer = `http://127.0.0.1:${address.port}`
  }

  expectAuthorization(url: URL): void {
    this.nonce = url.searchParams.get('nonce') ?? ''
    this.codeChallenge = url.searchParams.get('code_challenge') ?? ''
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    )
  }

  private json(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

integration('Milestone 1 API foundation', () => {
  let metadata: MetadataDatabase
  let app: FastifyInstance
  let administratorId = ''
  let administratorCookie = ''
  let administratorCsrf = ''
  let collectorConfigDirectory = ''

  beforeAll(async () => {
    const config = loadConfig({
      PRICKLESCOPE_NODE_ENV: 'test',
      PRICKLESCOPE_DATABASE_URL: databaseUrl!,
      PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD: 'integration-admin-password',
      PRICKLESCOPE_BOOTSTRAP_ADMIN_DISPLAY_NAME: 'Integration Administrator',
      PRICKLESCOPE_SESSION_TTL_SECONDS: '3600',
      PRICKLESCOPE_RUN_JOBS: 'true',
      PRICKLESCOPE_JOB_POLL_INTERVAL_MS: '100',
      PRICKLESCOPE_JOB_CONCURRENCY: '1',
    })
    collectorConfigDirectory = await mkdtemp(join(tmpdir(), 'pricklescope-collector-test-'))
    config.collectors.telegrafConfigDirectory = collectorConfigDirectory
    metadata = createMetadataDatabase(config.databaseUrl)
    await migrateToLatest(metadata.db)
    await sql`
      truncate table managed_grafana_resources, grafana_settings, collector_revisions, inventory_snapshots, source_checks, sources, sites, snmp_credentials,
      oidc_provider_settings, audit_events, desired_state, jobs, oidc_login_flows, sessions,
      oidc_identities, local_credentials, users restart identity cascade
    `.execute(metadata.db)
    await metadata.db.deleteFrom('polling_profiles').where('system_defined', '=', false).execute()
    await metadata.db
      .insertInto('storage_settings')
      .values({
        settings_key: 'primary',
        raw_retention_days: 30,
        five_minute_retention_days: 365,
        hourly_retention_days: 1825,
        status: 'unconfigured',
        error: null,
        revision: 1,
        updated_by: null,
        updated_at: new Date(),
        applied_at: null,
      })
      .onConflict((conflict) =>
        conflict.column('settings_key').doUpdateSet({
          raw_retention_days: 30,
          five_minute_retention_days: 365,
          hourly_retention_days: 1825,
          status: 'unconfigured',
          error: null,
          revision: 1,
          updated_by: null,
          updated_at: new Date(),
          applied_at: null,
        }),
      )
      .execute()
    await metadata.db
      .insertInto('grafana_settings')
      .values({
        settings_key: 'primary',
        status: 'unconfigured',
        error: null,
        revision: 1,
        service_account_id: null,
        service_account_token_id: null,
        token_key_version: null,
        token_nonce: null,
        token_ciphertext: null,
        token_auth_tag: null,
        grafana_version: null,
        plugin_version: null,
        updated_by: null,
        updated_at: new Date(),
        applied_at: null,
      })
      .execute()
    await bootstrapAdministrator(new AuthStore(metadata.db), config)
    app = await buildApp({ config, metadata, logger: false })
    await app.ready()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await metadata?.destroy()
    if (collectorConfigDirectory)
      await rm(collectorConfigDirectory, { recursive: true, force: true })
  })

  /**
   * The composed application, not a bare Fastify instance — this only fails once
   * everything is wired together. A route captures the error handler in force
   * when its context is built, and `await app.register(...)` for the Grafana
   * gateway boots the plugin tree, so a handler installed after the routes
   * applied to none of them. Errors came back in Fastify's default shape: no
   * controller error code, no request id, and Ajv's own message in place of the
   * generic one.
   */
  it('answers errors in the controller’s own shape, not Fastify’s default', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/system/health',
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json()).toMatchObject({ error: 'unauthorized' })
    expect(unauthenticated.json().requestId).toBeTruthy()

    const foreignOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://elsewhere.example' },
      payload: { username: 'admin', password: 'integration-admin-password' },
    })
    expect(foreignOrigin.statusCode).toBe(403)
    expect(foreignOrigin.json()).toMatchObject({ error: 'origin_invalid' })

    // The schema's own words would name the missing property; the controller's
    // do not.
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin' },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({
      error: 'invalid_request',
      message: 'The request did not match the expected format',
    })
  })

  it('rejects bad credentials without revealing which value was wrong', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'incorrect-password' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'invalid_credentials' })
  })

  it('creates a server-side session for the bootstrap administrator', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'integration-admin-password' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.user).toMatchObject({ username: 'admin', role: 'administrator' })
    expect(body.csrfToken).toEqual(expect.any(String))
    administratorId = body.user.id
    administratorCsrf = body.csrfToken
    administratorCookie = response.headers['set-cookie']!.split(';')[0]!

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: administratorCookie },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json().user.username).toBe('admin')
  })

  it('requires CSRF and role authorization for mutations', async () => {
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/dependency-check',
      headers: { cookie: administratorCookie },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const viewerId = randomUUID()
    await metadata.db
      .insertInto('users')
      .values({
        id: viewerId,
        username: 'viewer',
        username_normalized: 'viewer',
        display_name: 'Read Only Viewer',
        email: null,
        role: 'viewer',
        last_login_at: null,
      })
      .execute()
    await metadata.db
      .insertInto('local_credentials')
      .values({ user_id: viewerId, password_hash: await hashPassword('viewer-password-long') })
      .execute()
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'viewer', password: 'viewer-password-long' },
    })
    const viewerCookie = viewerLogin.headers['set-cookie']!.split(';')[0]!
    const viewerCsrf = viewerLogin.json().csrfToken
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/dependency-check',
      headers: { cookie: viewerCookie, 'x-csrf-token': viewerCsrf },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('persists and executes bounded background jobs', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/dependency-check',
      headers: { cookie: administratorCookie, 'x-csrf-token': administratorCsrf },
    })
    expect(created.statusCode).toBe(202)
    const jobId = created.json().id

    let status = 'queued'
    for (let attempt = 0; attempt < 30 && !['succeeded', 'failed'].includes(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const job = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${jobId}`,
        headers: { cookie: administratorCookie },
      })
      status = job.json().status
    }
    expect(status).toBe('succeeded')
  })

  it('exposes GUI-managed storage policy with admin-only confirmed mutation', async () => {
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/storage',
      headers: { cookie: administratorCookie },
    })
    expect(overview.statusCode).toBe(200)
    expect(overview.json()).toMatchObject({
      engine: 'questdb',
      decision: 'accepted',
      connection: 'disabled',
      policy: {
        rawRetentionDays: 30,
        fiveMinuteRetentionDays: 365,
        hourlyRetentionDays: 1825,
      },
    })
    expect(overview.body).not.toContain('postgresql://')

    const confirmationRequired = await app.inject({
      method: 'PUT',
      url: '/api/v1/storage/policy',
      headers: {
        cookie: administratorCookie,
        'x-csrf-token': administratorCsrf,
      },
      payload: {
        rawRetentionDays: 29,
        fiveMinuteRetentionDays: 365,
        hourlyRetentionDays: 1825,
      },
    })
    expect(confirmationRequired.statusCode).toBe(409)
    expect(confirmationRequired.json()).toMatchObject({
      error: 'retention_confirmation_required',
    })

    const viewer = await metadata.db
      .selectFrom('users')
      .select('id')
      .where('username_normalized', '=', 'viewer')
      .executeTakeFirstOrThrow()
    const viewerSession = await new AuthStore(metadata.db).createSession(viewer.id, 3600)
    const viewerRead = await app.inject({
      method: 'GET',
      url: '/api/v1/storage',
      headers: { cookie: `pricklescope_session=${viewerSession.token}` },
    })
    expect(viewerRead.statusCode).toBe(200)
    const viewerWrite = await app.inject({
      method: 'PUT',
      url: '/api/v1/storage/policy',
      headers: {
        cookie: `pricklescope_session=${viewerSession.token}`,
        'x-csrf-token': viewerSession.csrfToken,
      },
      payload: {
        rawRetentionDays: 31,
        fiveMinuteRetentionDays: 365,
        hourlyRetentionDays: 1825,
      },
    })
    expect(viewerWrite.statusCode).toBe(403)

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/storage/policy',
      headers: {
        cookie: administratorCookie,
        'x-csrf-token': administratorCsrf,
      },
      payload: {
        rawRetentionDays: 31,
        fiveMinuteRetentionDays: 365,
        hourlyRetentionDays: 1825,
      },
    })
    expect(saved.statusCode).toBe(202)
    expect(saved.json()).toMatchObject({ type: 'storage.questdb.reconcile', status: 'queued' })

    let status = 'queued'
    for (let attempt = 0; attempt < 30 && !['succeeded', 'failed'].includes(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const job = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${saved.json().id}`,
        headers: { cookie: administratorCookie },
      })
      status = job.json().status
    }
    expect(status).toBe('failed')
    const stored = await metadata.db
      .selectFrom('storage_settings')
      .select(['raw_retention_days', 'status'])
      .where('settings_key', '=', 'primary')
      .executeTakeFirstOrThrow()
    expect(stored).toMatchObject({ raw_retention_days: 31, status: 'failed' })

    await metadata.db
      .updateTable('storage_settings')
      .set({ raw_retention_days: 30, status: 'unconfigured', error: null })
      .where('settings_key', '=', 'primary')
      .execute()
  })

  it('keeps site moves cycle-safe and returns stable hierarchy paths', async () => {
    const headers = {
      cookie: administratorCookie,
      'x-csrf-token': administratorCsrf,
    }
    const createSite = async (name: string, parentId: string | null = null) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sites',
        headers,
        payload: { name, parentId },
      })
      expect(response.statusCode).toBe(201)
      return response.json()
    }

    const campus = await createSite('Hierarchy campus')
    const building = await createSite('Main building', campus.id)
    const floor = await createSite('First floor', building.id)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { cookie: administratorCookie },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: campus.id,
          parentId: null,
          childCount: 1,
          depth: 0,
          path: [{ id: campus.id, name: 'Hierarchy campus' }],
        }),
        expect.objectContaining({
          id: floor.id,
          parentId: building.id,
          depth: 2,
          path: [
            { id: campus.id, name: 'Hierarchy campus' },
            { id: building.id, name: 'Main building' },
            { id: floor.id, name: 'First floor' },
          ],
        }),
      ]),
    )

    const cyclicMove = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${campus.id}`,
      headers,
      payload: { parentId: floor.id },
    })
    expect(cyclicMove.statusCode).toBe(400)
    expect(cyclicMove.json()).toMatchObject({ error: 'site_cycle' })

    const parentDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sites/${campus.id}`,
      headers,
    })
    expect(parentDelete.statusCode).toBe(409)
    expect(parentDelete.json()).toMatchObject({ error: 'site_has_children' })

    const move = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${floor.id}`,
      headers,
      payload: { parentId: campus.id },
    })
    expect(move.statusCode).toBe(200)
    expect(move.json()).toMatchObject({ parentId: campus.id, depth: 1 })
  })

  it('exposes Grafana desired state without credentials and fails closed when unconfigured', async () => {
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/grafana',
      headers: { cookie: administratorCookie },
    })
    expect(overview.statusCode).toBe(200)
    expect(overview.json()).toMatchObject({
      connection: 'disabled',
      status: 'unconfigured',
      dataSourceUid: 'pricklescope-questdb',
      dashboards: expect.arrayContaining([
        expect.objectContaining({ uid: 'pricklescope-fleet' }),
        expect.objectContaining({ uid: 'pricklescope-interface' }),
      ]),
    })
    expect(overview.body).not.toMatch(/password|token|adminUser/i)

    const reconcile = await app.inject({
      method: 'POST',
      url: '/api/v1/grafana/reconcile',
      headers: {
        cookie: administratorCookie,
        'x-csrf-token': administratorCsrf,
      },
    })
    expect(reconcile.statusCode).toBe(202)
    let status = 'queued'
    for (let attempt = 0; attempt < 30 && !['succeeded', 'failed'].includes(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${reconcile.json().id}`,
        headers: { cookie: administratorCookie },
      })
      status = response.json().status
    }
    expect(status).toBe('failed')
    const settings = await metadata.db
      .selectFrom('grafana_settings')
      .select(['status', 'token_ciphertext'])
      .where('settings_key', '=', 'primary')
      .executeTakeFirstOrThrow()
    expect(settings).toMatchObject({ status: 'failed', token_ciphertext: null })
  })

  it('manages an encrypted SNMP source and persists a secret-free connection job', async () => {
    const headers = {
      cookie: administratorCookie,
      'x-csrf-token': administratorCsrf,
    }
    const siteResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers,
      payload: { name: 'Integration lab', description: 'Temporary API test site' },
    })
    expect(siteResponse.statusCode).toBe(201)

    const secret = 'very-secret-community'
    const credentialResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/credentials/snmp',
      headers,
      payload: { name: 'Integration SNMP', version: '2c', community: secret },
    })
    expect(credentialResponse.statusCode).toBe(201)
    expect(credentialResponse.body).not.toContain(secret)
    expect(credentialResponse.json()).not.toHaveProperty('community')

    const storedCredential = await metadata.db
      .selectFrom('snmp_credentials')
      .selectAll()
      .where('id', '=', credentialResponse.json().id)
      .executeTakeFirstOrThrow()
    expect(Buffer.from(storedCredential.secret_ciphertext).includes(Buffer.from(secret))).toBe(
      false,
    )

    const profileResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/polling-profiles',
      headers,
      payload: {
        name: 'Fast integration profile',
        description: 'Short timeout for local testing',
        intervalSeconds: 60,
        timeoutMs: 250,
        retries: 0,
        collectSystem: true,
        collectInterfaces: true,
      },
    })
    expect(profileResponse.statusCode).toBe(201)

    const sourceResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers,
      payload: {
        name: 'Unreachable integration switch',
        target: '127.0.0.1',
        port: 9,
        siteId: siteResponse.json().id,
        credentialId: credentialResponse.json().id,
        profileId: profileResponse.json().id,
        collectorSelection: 'auto',
      },
    })
    expect(sourceResponse.statusCode).toBe(201)
    expect(sourceResponse.json()).toMatchObject({
      collectorSelection: 'auto',
      collector: 'telegraf',
      status: 'new',
    })

    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/v1/collectors/capabilities',
      headers: { cookie: administratorCookie },
    })
    expect(capabilities.statusCode).toBe(200)
    expect(capabilities.json()).toMatchObject({ recommended: 'telegraf' })

    const testResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${sourceResponse.json().id}/test`,
      headers,
    })
    expect(testResponse.statusCode).toBe(202)
    let job = testResponse.json()
    for (
      let attempt = 0;
      attempt < 30 && !['succeeded', 'failed'].includes(job.status);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const jobResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${job.id}`,
        headers: { cookie: administratorCookie },
      })
      job = jobResponse.json()
    }
    expect(job.status).toBe('failed')
    expect(JSON.stringify(job)).not.toContain(secret)

    const storedJob = await metadata.db
      .selectFrom('jobs')
      .select(['payload', 'result', 'error'])
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow()
    expect(storedJob.payload).toEqual({ sourceId: sourceResponse.json().id })
    expect(JSON.stringify(storedJob)).not.toContain(secret)

    const source = await app.inject({
      method: 'GET',
      url: `/api/v1/sources/${sourceResponse.json().id}`,
      headers: { cookie: administratorCookie },
    })
    expect(source.json()).toMatchObject({ status: 'unreachable' })
    expect(source.body).not.toContain(secret)

    const audited = await metadata.db
      .selectFrom('audit_events')
      .select('action')
      .where('resource_id', '=', sourceResponse.json().id)
      .execute()
    expect(audited.map((event) => event.action)).toEqual(
      expect.arrayContaining(['source.created', 'source.test_requested']),
    )
  })

  it('persists discovered inventory arrays as JSON documents', async () => {
    const source = await metadata.db
      .selectFrom('sources')
      .select('id')
      .where('name', '=', 'Unreachable integration switch')
      .executeTakeFirstOrThrow()
    const jobId = randomUUID()
    await metadata.db
      .insertInto('jobs')
      .values({
        id: jobId,
        type: 'snmp.inventory',
        status: 'succeeded',
        payload: { sourceId: source.id },
        result: null,
        error: null,
        requested_by: administratorId,
        timeout_ms: 30_000,
        started_at: new Date(),
        finished_at: new Date(),
        heartbeat_at: new Date(),
      })
      .execute()

    const snapshot = await new InventoryStore(metadata.db).saveSnapshot({
      sourceId: source.id,
      jobId,
      system: {
        name: 'integration-switch',
        description: 'JSON persistence regression fixture',
        objectId: '.1.3.6.1.4.1.8072.3.2.10',
        location: 'Test lab',
        contact: null,
        uptimeTicks: 123_456,
      },
      interfaces: [
        {
          index: 1,
          name: 'eth0',
          description: 'Uplink',
          alias: null,
          type: 6,
          mtu: 1500,
          speedBps: 1_000_000_000,
          macAddress: '02:00:00:00:00:01',
          adminStatus: 1,
          operStatus: 1,
        },
      ],
      diff: {
        firstSnapshot: true,
        systemChanges: [],
        addedInterfaces: [],
        removedInterfaces: [],
        changedInterfaces: [],
      },
      partial: false,
      errors: [],
    })

    expect(snapshot.interfaces).toEqual([
      expect.objectContaining({ index: 1, name: 'eth0', speedBps: 1_000_000_000 }),
    ])
    expect(snapshot.errors).toEqual([])
    const stored = await metadata.db
      .selectFrom('inventory_snapshots')
      .select(['interfaces', 'errors'])
      .where('id', '=', snapshot.id)
      .executeTakeFirstOrThrow()
    expect(Array.isArray(stored.interfaces)).toBe(true)
    expect(Array.isArray(stored.errors)).toBe(true)
  })

  it('reconciles, redacts, preserves last-known-good, and rolls back Telegraf revisions', async () => {
    const headers = {
      cookie: administratorCookie,
      'x-csrf-token': administratorCsrf,
    }
    const source = await metadata.db
      .selectFrom('sources')
      .select('id')
      .where('name', '=', 'Unreachable integration switch')
      .executeTakeFirstOrThrow()

    const waitForJob = async (id: string) => {
      let current: { status: string; result?: unknown; error?: string | null } = {
        status: 'queued',
      }
      for (
        let attempt = 0;
        attempt < 50 && !['succeeded', 'failed'].includes(current.status);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/jobs/${id}`,
          headers: { cookie: administratorCookie },
        })
        current = response.json()
      }
      return current
    }

    const reconcile = await app.inject({
      method: 'POST',
      url: '/api/v1/collectors/telegraf/reconcile',
      headers,
    })
    expect(reconcile.statusCode).toBe(202)
    const firstJob = await waitForJob(reconcile.json().id)
    expect(firstJob).toMatchObject({ status: 'succeeded', result: { changed: true } })

    const firstList = await app.inject({
      method: 'GET',
      url: '/api/v1/collectors/telegraf/revisions',
      headers: { cookie: administratorCookie },
    })
    expect(firstList.statusCode).toBe(200)
    expect(firstList.body).not.toContain('very-secret-community')
    expect(firstList.body).toContain('[REDACTED]')
    const firstRevision = firstList.json().revisions[0]
    expect(firstRevision).toMatchObject({ status: 'active', sourceCount: 1, checkCount: 1 })

    const stored = await metadata.db
      .selectFrom('collector_revisions')
      .select(['config_ciphertext', 'rendered_config'])
      .where('id', '=', firstRevision.id)
      .executeTakeFirstOrThrow()
    expect(
      Buffer.from(stored.config_ciphertext).includes(Buffer.from('very-secret-community')),
    ).toBe(false)
    expect(stored.rendered_config).not.toContain('very-secret-community')
    const activePath = join(collectorConfigDirectory, 'active', 'managed.conf')
    expect(await readFile(activePath, 'utf8')).toContain('very-secret-community')

    const unchanged = await app.inject({
      method: 'POST',
      url: '/api/v1/collectors/telegraf/reconcile',
      headers,
    })
    expect(await waitForJob(unchanged.json().id)).toMatchObject({
      status: 'succeeded',
      result: { changed: false },
    })
    expect(await metadata.db.selectFrom('collector_revisions').select('id').execute()).toHaveLength(
      1,
    )

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${source.id}`,
      headers,
      payload: { target: '127.0.0.2' },
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/collectors/telegraf/reconcile',
      headers,
    })
    expect(await waitForJob(second.json().id)).toMatchObject({ status: 'succeeded' })

    const revisionsDirectory = join(collectorConfigDirectory, 'revisions')
    const heldRevisionsDirectory = join(collectorConfigDirectory, 'revisions-held')
    await rename(revisionsDirectory, heldRevisionsDirectory)
    await writeFile(revisionsDirectory, 'block publication')
    try {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/sources/${source.id}`,
        headers,
        payload: { target: '127.0.0.3' },
      })
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/v1/collectors/telegraf/reconcile',
        headers,
      })
      expect(await waitForJob(blocked.json().id)).toMatchObject({ status: 'failed' })
      expect(await readFile(activePath, 'utf8')).toContain('127.0.0.2')
      const activeRows = await metadata.db
        .selectFrom('collector_revisions')
        .select('id')
        .where('status', '=', 'active')
        .execute()
      expect(activeRows).toHaveLength(1)
    } finally {
      await rm(revisionsDirectory)
      await rename(heldRevisionsDirectory, revisionsDirectory)
    }

    const rollback = await app.inject({
      method: 'POST',
      url: `/api/v1/collectors/telegraf/revisions/${firstRevision.id}/rollback`,
      headers,
    })
    expect(rollback.statusCode).toBe(202)
    expect(await waitForJob(rollback.json().id)).toMatchObject({ status: 'succeeded' })
    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/collectors/telegraf',
      headers: { cookie: administratorCookie },
    })
    expect(status.json().activeRevision).toMatchObject({
      reason: 'rollback',
      sourceRevisionId: firstRevision.id,
    })
    expect(status.body).not.toContain('very-secret-community')
    expect(await readFile(activePath, 'utf8')).toContain('127.0.0.1')
  })

  it('manages local users with lockout protection and immediate session revocation', async () => {
    const headers = {
      cookie: administratorCookie,
      'x-csrf-token': administratorCsrf,
    }
    const password = 'managed-user-temporary-password'
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers,
      payload: {
        username: 'managed-operator',
        displayName: 'Managed Operator',
        email: 'managed-operator@example.test',
        role: 'operator',
        password,
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain(password)
    expect(created.json()).toMatchObject({
      username: 'managed-operator',
      active: true,
      role: 'operator',
      authMethods: ['local'],
      sessionCount: 0,
    })
    const userId = created.json().id

    const storedCredential = await metadata.db
      .selectFrom('local_credentials')
      .select('password_hash')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow()
    expect(storedCredential.password_hash).not.toContain(password)
    await expect(verifyPassword(storedCredential.password_hash, password)).resolves.toBe(true)

    const managedLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'managed-operator', password },
    })
    expect(managedLogin.statusCode).toBe(200)
    const managedCookie = managedLogin.headers['set-cookie']!.split(';')[0]!
    const managedCsrf = managedLogin.json().csrfToken
    const forbiddenUsers = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: managedCookie, 'x-csrf-token': managedCsrf },
    })
    expect(forbiddenUsers.statusCode).toBe(403)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: administratorCookie },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: userId, sessionCount: 1, authMethods: ['local'] }),
      ]),
    )
    expect(listed.body).not.toContain(password)

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/revoke-sessions`,
      headers,
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json()).toEqual({ revokedSessions: 1 })
    const revokedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: managedCookie },
    })
    expect(revokedSession.statusCode).toBe(401)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}`,
      headers,
      payload: { role: 'viewer', displayName: 'Managed Viewer' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ role: 'viewer', displayName: 'Managed Viewer' })

    const selfLockout = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${administratorId}`,
      headers,
      payload: { active: false },
    })
    expect(selfLockout.statusCode).toBe(400)
    expect(selfLockout.json()).toMatchObject({ error: 'self_lockout' })

    const newPassword = 'managed-user-reset-password'
    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/password`,
      headers,
      payload: { password: newPassword },
    })
    expect(reset.statusCode).toBe(200)
    expect(reset.body).not.toContain(newPassword)
    const resetCredential = await metadata.db
      .selectFrom('local_credentials')
      .select('password_hash')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow()
    await expect(verifyPassword(resetCredential.password_hash, newPassword)).resolves.toBe(true)
    await expect(verifyPassword(resetCredential.password_hash, password)).resolves.toBe(false)

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${userId}`,
      headers,
      payload: { active: false },
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({ active: false })

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${userId}`,
      headers,
    })
    expect(removed.statusCode).toBe(204)
    const audited = await metadata.db
      .selectFrom('audit_events')
      .select(['action', 'metadata'])
      .where('resource_id', '=', userId)
      .execute()
    expect(audited.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'user.created',
        'user.updated',
        'user.password_reset',
        'user.sessions_revoked',
        'user.deleted',
      ]),
    )
    expect(JSON.stringify(audited)).not.toContain(password)
    expect(JSON.stringify(audited)).not.toContain(newPassword)
  })

  it('manages encrypted OIDC provider settings and applies them without a restart', async () => {
    const provider = new MockOidcProvider()
    await provider.start()
    const clientSecret = 'managed-oidc-client-secret'
    const payload = {
      enabled: true,
      name: 'Managed integration SSO',
      issuerUrl: provider.issuer,
      clientId: 'pricklescope-integration',
      clientSecret,
      redirectUri: 'http://localhost:5173/api/v1/auth/oidc/callback',
      scopes: 'openid profile email',
      jitProvisioning: true,
      adminGroup: 'pricklescope-admins',
      operatorGroup: 'pricklescope-operators',
    }
    const headers = {
      cookie: administratorCookie,
      'x-csrf-token': administratorCsrf,
    }
    try {
      const defaults = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/oidc',
        headers: { cookie: administratorCookie },
      })
      expect(defaults.statusCode).toBe(200)
      expect(defaults.json()).toMatchObject({
        enabled: false,
        source: 'defaults',
        clientSecretConfigured: false,
      })

      const viewer = await metadata.db
        .selectFrom('users')
        .select('id')
        .where('username_normalized', '=', 'viewer')
        .executeTakeFirstOrThrow()
      const viewerSession = await new AuthStore(metadata.db).createSession(viewer.id, 3600)
      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/oidc',
        headers: { cookie: `pricklescope_session=${viewerSession.token}` },
      })
      expect(forbidden.statusCode).toBe(403)

      const missingCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/oidc/test',
        headers: { cookie: administratorCookie },
        payload,
      })
      expect(missingCsrf.statusCode).toBe(403)

      const tested = await app.inject({
        method: 'POST',
        url: '/api/v1/settings/oidc/test',
        headers,
        payload,
      })
      expect(tested.statusCode).toBe(200)
      expect(tested.json()).toMatchObject({
        issuer: provider.issuer,
        authorizationEndpoint: `${provider.issuer}/authorize`,
        tokenEndpoint: `${provider.issuer}/token`,
      })
      expect(tested.body).not.toContain(clientSecret)

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/oidc',
        headers,
        payload,
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.json()).toMatchObject({
        enabled: true,
        name: 'Managed integration SSO',
        source: 'database',
        clientSecretConfigured: true,
      })
      expect(saved.body).not.toContain(clientSecret)
      expect(saved.json()).not.toHaveProperty('clientSecret')

      const stored = await metadata.db
        .selectFrom('oidc_provider_settings')
        .selectAll()
        .where('provider_key', '=', 'primary')
        .executeTakeFirstOrThrow()
      expect(
        Buffer.from(stored.client_secret_ciphertext!).includes(Buffer.from(clientSecret)),
      ).toBe(false)

      const publicProviders = await app.inject({ method: 'GET', url: '/api/v1/auth/providers' })
      expect(publicProviders.json()).toMatchObject({
        oidc: { enabled: true, name: 'Managed integration SSO' },
      })
      const started = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' })
      expect(started.statusCode).toBe(302)
      const authorizationUrl = new URL(started.headers.location!)
      expect(authorizationUrl.origin).toBe(provider.issuer)
      expect(authorizationUrl.searchParams.get('client_id')).toBe('pricklescope-integration')

      const restored = await app.inject({
        method: 'DELETE',
        url: '/api/v1/settings/oidc',
        headers,
      })
      expect(restored.statusCode).toBe(200)
      expect(restored.json()).toMatchObject({ enabled: false, source: 'defaults' })
      const restoredProviders = await app.inject({ method: 'GET', url: '/api/v1/auth/providers' })
      expect(restoredProviders.json()).toMatchObject({ oidc: { enabled: false } })

      const audited = await metadata.db
        .selectFrom('audit_events')
        .select(['action', 'metadata'])
        .where('resource_type', '=', 'oidc_provider')
        .execute()
      expect(audited.map((event) => event.action)).toEqual(
        expect.arrayContaining([
          'oidc.settings_tested',
          'oidc.settings_updated',
          'oidc.settings_reset',
        ]),
      )
      expect(JSON.stringify(audited)).not.toContain(clientSecret)
    } finally {
      await provider.stop()
    }
  })

  it('completes OIDC discovery, PKCE, signed-token validation, and JIT provisioning', async () => {
    const provider = new MockOidcProvider()
    await provider.start()
    try {
      const config = loadConfig({
        PRICKLESCOPE_NODE_ENV: 'test',
        PRICKLESCOPE_DATABASE_URL: databaseUrl!,
      })
      const settings = {
        ...config.oidc,
        enabled: true,
        issuerUrl: provider.issuer,
        clientId: 'pricklescope-integration',
        clientSecret: 'integration-client-secret',
        adminGroup: 'pricklescope-admins',
      }
      const service = new OidcService(new AuthStore(metadata.db), config, {
        effective: () => Promise.resolve(settings),
      })
      const started = await service.start('/settings')
      const authorizationUrl = new URL(started.authorizationUrl)
      expect(authorizationUrl.searchParams.get('response_type')).toBe('code')
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorizationUrl.searchParams.get('state')).toEqual(expect.any(String))
      provider.expectAuthorization(authorizationUrl)

      const completed = await service.finish(
        started.flowToken,
        new URL(
          `${settings.redirectUri}?code=integration-code&state=${authorizationUrl.searchParams.get('state')}`,
        ),
      )
      expect(completed.returnTo).toBe('/settings')
      expect(completed.user).toMatchObject({
        username: 'oidc-admin',
        role: 'administrator',
        authMethods: ['oidc'],
      })
      const managedUsers = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { cookie: administratorCookie },
      })
      expect(managedUsers.statusCode).toBe(200)
      expect(managedUsers.json().users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            username: 'oidc-admin',
            authMethods: ['oidc'],
            oidcIssuers: [provider.issuer],
          }),
        ]),
      )
      expect(managedUsers.body).not.toContain('integration-subject')
      expect(managedUsers.body).not.toContain('claims')
      await expect(
        service.finish(started.flowToken, new URL(`${config.oidc.redirectUri}?code=replayed-code`)),
      ).rejects.toMatchObject({ code: 'oidc_flow_invalid' })
    } finally {
      await provider.stop()
    }
  })
})
