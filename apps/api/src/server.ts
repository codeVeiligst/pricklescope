import { buildApp } from './app.js'
import { redactConfig } from './config.js'
import { createRuntime } from './runtime.js'

const runtime = await createRuntime()
const app = await buildApp({ config: runtime.config, metadata: runtime.metadata })

app.log.info({ config: redactConfig(runtime.config) }, 'Loaded PrickleScope configuration')

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Stopping PrickleScope API')
  await app.close()
  await runtime.metadata.destroy()
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
