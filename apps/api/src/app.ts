import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { MetadataDatabase } from '@pricklescope/db'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'

import { createAuthGuards } from './auth/guards.js'
import { LocalAuthService } from './auth/local.js'
import { OidcService } from './auth/oidc.js'
import { registerAuthRoutes } from './auth/routes.js'
import { AuthStore } from './auth/store.js'
import type { AppConfig } from './config.js'
import { TelegrafConfigPublisher } from './collectors/publisher.js'
import { registerCollectorRoutes } from './collectors/routes.js'
import { TelegrafReconciliationService } from './collectors/service.js'
import { CollectorStore } from './collectors/store.js'
import { HttpError } from './errors.js'
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from './logging.js'
import { registerGrafanaGateway } from './grafana/gateway.js'
import { registerAlertRoutes } from './alerts/routes.js'
import { AlertService } from './alerts/service.js'
import { AlertStore } from './alerts/store.js'
import { registerGrafanaRoutes } from './grafana/routes.js'
import { registerGraphRoutes } from './graphs/routes.js'
import { GraphService } from './graphs/service.js'
import { GrafanaService } from './grafana/service.js'
import { GrafanaStore } from './grafana/store.js'
import { HealthRecorder } from './health/recorder.js'
import { HealthService } from './health/service.js'
import { CredentialCrypto } from './inventory/credential-crypto.js'
import { registerInventoryRoutes } from './inventory/routes.js'
import { CredentialService, SnmpInventoryService } from './inventory/service.js'
import { InventoryStore } from './inventory/store.js'
import { registerJobRoutes } from './jobs/routes.js'
import { JobRunner, type JobHandler } from './jobs/runner.js'
import { JobStore } from './jobs/store.js'
import { hashToken } from './security.js'
import { OidcSettingsService } from './settings/oidc.js'
import { registerSettingsRoutes } from './settings/routes.js'
import { QuestDbClient } from './storage/questdb.js'
import { registerStorageRoutes } from './storage/routes.js'
import { StorageService } from './storage/service.js'
import { StorageStore } from './storage/store.js'
import { registerSyncRoutes } from './sync/routes.js'
import { SyncService } from './sync/service.js'
import { registerSystemRoutes } from './system/routes.js'
import { registerUserRoutes } from './users/routes.js'
import { UserManagementService } from './users/service.js'

export interface BuildAppOptions {
  config: AppConfig
  metadata: MetadataDatabase
  logger?: boolean
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, metadata } = options
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger:
      options.logger === false
        ? false
        : {
            level: config.environment === 'development' ? 'debug' : 'info',
            redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
          },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorateRequest('auth', null)
  await app.register(cookie)
  await app.register(helmet)
  // A ceiling rather than a quota: high enough that no screen can reach it, low
  // enough that a stolen session cannot be used to grind QuestDB or the SNMP
  // stack. Routes that cost more than a metadata read set their own below this.
  //
  // Keyed by session where there is one, so users behind one NAT are counted
  // apart, and by address otherwise, which is what the login and notification
  // limits need. The limiter runs on `onRequest`, before `authenticate` has
  // resolved the session, so the cookie is read directly — and hashed, because
  // the key ends up in the limiter's store.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const token = request.cookies[config.session.cookieName]
      return token ? `session:${hashToken(token)}` : `address:${request.ip}`
    },
  })
  await app.register(swagger, {
    openapi: {
      info: { title: 'PrickleScope API', version: config.version },
    },
  })

  // Both handlers are set here, before a single route exists, and that placement
  // is load-bearing. A route captures the error handler in force when its context
  // is built, and `await app.register(...)` — which the Grafana gateway needs —
  // boots the plugin tree and builds every route registered so far. Setting the
  // handler after that point silently applied to nothing: errors came back in
  // Fastify's default shape, so no controller error code and no request id ever
  // reached a client, and Ajv's raw message went out in place of the generic one.
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message: 'The requested API route does not exist',
      requestId: request.id,
    })
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        requestId: request.id,
      })
    }
    if (error.validation) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The request did not match the expected format',
        requestId: request.id,
      })
    }
    // Plugins and the framework raise their own HTTP errors, and the rate
    // limiter's 429 is the one that matters: throttled requests were being
    // reported as 500, losing the status and the Retry-After hint, and logging
    // every refused login as an unhandled error. The request was refused either
    // way, but a caller cannot tell "slow down" from "the server is broken", and
    // the noise would bury a real fault. Body-too-large and unsupported media
    // type arrive the same way.
    const status = typeof error.statusCode === 'number' ? error.statusCode : 0
    if (status >= 400 && status < 500) {
      const codes: Record<number, string> = {
        413: 'payload_too_large',
        415: 'unsupported_media_type',
        429: 'rate_limited',
      }
      return reply.code(status).send({
        error: codes[status] ?? 'request_refused',
        // The framework's own wording here is operational, not internal detail.
        message: error.message.slice(0, 200),
        requestId: request.id,
      })
    }

    const databaseCode = (error as FastifyError & { code?: string }).code
    if (databaseCode === '23505') {
      return reply.code(409).send({
        error: 'already_exists',
        message: 'A resource with those identifying details already exists',
        requestId: request.id,
      })
    }
    if (databaseCode === '23503') {
      return reply.code(409).send({
        error: 'resource_in_use',
        message: 'The resource is still in use and cannot be removed',
        requestId: request.id,
      })
    }
    request.log.error({ err: error }, 'Unhandled request error')
    return reply.code(500).send({
      error: 'internal_error',
      message: 'The request could not be completed',
      requestId: request.id,
    })
  })

  // Authenticated JSON, none of which should ever sit in a cache. A baseline DAST
  // pass flagged API responses as storable; the gateway serves the SPA's static
  // assets and sets its own caching for those, so this applies only to the API.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith('/api')) {
      reply.header('cache-control', 'no-store')
      reply.header('pragma', 'no-cache')
    }
    done(null, payload)
  })

  const appOrigin = new URL(config.appOrigin).origin
  // Fastify uses the returned promise to know this hook has completed.
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
    const origin = request.headers.origin
    if (origin && origin !== appOrigin) {
      throw new HttpError(403, 'origin_invalid', 'The request origin is not allowed')
    }
  })

  const authStore = new AuthStore(metadata.db)
  const userManagement = new UserManagementService(metadata.db, authStore)
  const localAuth = await LocalAuthService.create(authStore, config)
  const oidcSettings = new OidcSettingsService(metadata.db, authStore, config)
  const oidc = new OidcService(authStore, config, oidcSettings)
  const guards = createAuthGuards(authStore, config)
  const health = new HealthService(metadata.pool, config)
  const jobs = new JobStore(metadata.db)
  const inventoryStore = new InventoryStore(metadata.db)
  const credentialCrypto = new CredentialCrypto(
    config.security.credentialKey,
    config.security.credentialKeyVersion,
  )
  const credentials = new CredentialService(inventoryStore, credentialCrypto)
  const snmpInventory = new SnmpInventoryService(inventoryStore, credentialCrypto)
  const collectorStore = new CollectorStore(metadata.db)
  const questdb = config.storage.questdbDatabaseUrl
    ? new QuestDbClient(
        config.storage.questdbDatabaseUrl,
        config.storage.statementTimeoutMs,
        config.storage.queryLimit,
      )
    : null
  const grafanaStore = new GrafanaStore(metadata.db)
  const storage = new StorageService(new StorageStore(metadata.db), questdb, authStore)
  const graphs = new GraphService(questdb)
  const alerts = new AlertService(
    new AlertStore(metadata.db),
    grafanaStore,
    questdb,
    authStore,
    config,
  )
  const grafana = new GrafanaService(grafanaStore, authStore, config)
  const telegrafReconciliation = new TelegrafReconciliationService(
    collectorStore,
    credentialCrypto,
    new TelegrafConfigPublisher(config.collectors.telegrafConfigDirectory),
    authStore,
    config,
  )
  const sourceId = (payload: Record<string, unknown>): string => {
    if (typeof payload.sourceId !== 'string') throw new Error('The inventory job has no source ID')
    return payload.sourceId
  }
  const actorUserId = (payload: Record<string, unknown>): string | null =>
    typeof payload.actorUserId === 'string' ? payload.actorUserId : null
  const revisionId = (payload: Record<string, unknown>): string => {
    if (typeof payload.revisionId !== 'string') {
      throw new Error('The rollback job has no revision ID')
    }
    return payload.revisionId
  }
  const handlers = new Map<string, JobHandler>([
    [
      'system.dependencies.check',
      async ({ reportProgress }) => {
        await reportProgress(10)
        const result = await health.check()
        await reportProgress(90)
        return result
      },
    ],
    [
      'snmp.connection-test',
      async ({ payload, signal, reportProgress }) => {
        await reportProgress(10)
        const result = await snmpInventory.test(sourceId(payload), signal)
        await reportProgress(95)
        return result
      },
    ],
    [
      'snmp.inventory',
      async ({ jobId, payload, signal, reportProgress }) => {
        const id = sourceId(payload)
        await inventoryStore.markInventoryPending(id)
        await reportProgress(10)
        const snapshot = await snmpInventory.inventory(id, jobId, signal)
        await reportProgress(95)
        return { sourceId: id, snapshotId: snapshot.id, partial: snapshot.partial }
      },
    ],
    [
      'collector.telegraf.reconcile',
      async ({ payload, signal, reportProgress }) => {
        await reportProgress(10)
        const result = await telegrafReconciliation.reconcile(actorUserId(payload), signal)
        await reportProgress(95)
        return result
      },
    ],
    [
      'collector.telegraf.rollback',
      async ({ payload, signal, reportProgress }) => {
        await reportProgress(10)
        const result = await telegrafReconciliation.rollback(
          revisionId(payload),
          actorUserId(payload),
          signal,
        )
        await reportProgress(95)
        return result
      },
    ],
    [
      'storage.questdb.reconcile',
      async ({ payload, signal, reportProgress }) => {
        await reportProgress(10)
        const result = await storage.reconcile(actorUserId(payload), signal)
        await reportProgress(95)
        return result
      },
    ],
    [
      'grafana.reconcile',
      async ({ payload, signal, reportProgress }) => {
        await reportProgress(10)
        const result = await grafana.reconcile(actorUserId(payload), signal)
        await reportProgress(95)
        return result
      },
    ],
    [
      'alerts.reconcile',
      async ({ payload, signal, reportProgress }) => {
        await reportProgress(10)
        const result = await alerts.reconcile(actorUserId(payload), signal)
        await reportProgress(95)
        return result
      },
    ],
  ])
  const runner = new JobRunner(jobs, handlers, config.jobs)

  registerSystemRoutes(app, { config, health, guards })
  registerAuthRoutes(app, { config, store: authStore, localAuth, oidc, guards })
  registerUserRoutes(app, { users: userManagement, guards })
  registerSettingsRoutes(app, { oidcSettings, guards })
  registerJobRoutes(app, { store: jobs, runner, health, guards, audit: authStore })
  registerInventoryRoutes(app, {
    store: inventoryStore,
    credentials,
    jobs,
    guards,
    audit: authStore,
  })
  registerCollectorRoutes(app, {
    service: telegrafReconciliation,
    jobs,
    guards,
  })
  registerStorageRoutes(app, { service: storage, jobs, guards })
  registerGrafanaRoutes(app, { service: grafana, jobs, guards })
  registerGraphRoutes(app, { service: graphs, guards })
  registerAlertRoutes(app, { service: alerts, jobs, guards })
  registerSyncRoutes(app, {
    service: new SyncService({
      collectors: telegrafReconciliation,
      grafana,
      alerts,
      storage,
      jobs,
    }),
    guards,
  })
  await registerGrafanaGateway(app, { config, guards })

  // The generated description of every route, parameter, and response shape. It
  // carries no secrets, but handing an unauthenticated caller a map of the whole
  // API is a courtesy the product does not owe them. Any signed-in account may
  // read it; nothing in the browser fetches it at all.
  app.get(
    '/api/openapi.json',
    { preHandler: [guards.authenticate, guards.authorize('viewer')], schema: { hide: true } },
    () => app.swagger(),
  )

  await authStore.deleteExpiredArtifacts()
  if (config.runJobs) await runner.start()
  // Tied to runJobs for the same reason the job runner is: one process in a
  // deployment does the background work, and a second writing the same rows
  // would double every count the health rules take.
  const healthRecorder = new HealthRecorder(health, questdb, config, app.log)
  if (config.runJobs) healthRecorder.start()
  app.addHook('onClose', async () => {
    healthRecorder.stop()
    await runner.stop()
    await questdb?.close()
  })

  return app
}
