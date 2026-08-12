import { buildApp } from './app.js'
import { redactConfig } from './config.js'
import { createRuntime } from './runtime.js'

const runtime = await createRuntime()
const app = await buildApp({ config: runtime.config, metadata: runtime.metadata })

app.log.info({ config: redactConfig(runtime.config) }, 'Loaded PrickleScope configuration')

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Stopping PrickleScope API')
  // Each step is attempted even if an earlier one fails, and a failure here
  // cannot become an unhandled rejection: these run from a signal handler, with
  // no caller to catch them. Shutting down badly should still shut down.
  try {
    await app.close()
  } catch (error) {
    app.log.error({ err: error }, 'the HTTP server did not close cleanly')
  }
  try {
    await runtime.metadata.destroy()
  } catch (error) {
    app.log.error({ err: error }, 'the metadata pool did not close cleanly')
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: runtime.config.host, port: runtime.config.port })
} catch (error) {
  app.log.error(error)
  await runtime.metadata.destroy()
  process.exitCode = 1
}
