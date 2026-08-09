import { connect } from 'node:net'
import { performance } from 'node:perf_hooks'

import type { DependencyHealth } from '@pricklescope/contracts'

interface CheckOptions {
  name: string
  critical?: boolean
  timeoutMs?: number
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Timed out'
    return error.message.slice(0, 240)
  }
  return 'Unknown dependency error'
}

export async function checkHttpDependency(
  url: string | null,
  options: CheckOptions,
): Promise<DependencyHealth> {
  const checkedAt = new Date().toISOString()
  if (!url) {
    return {
      name: options.name,
      state: 'disabled',
      critical: options.critical ?? false,
      latencyMs: null,
      message: 'Not configured',
      checkedAt,
    }
  }

  const startedAt = performance.now()
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      headers: { accept: 'application/json, text/plain;q=0.8' },
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    if (!response.ok) {
      return {
        name: options.name,
        state: 'down',
        critical: options.critical ?? false,
        latencyMs,
        message: `HTTP ${response.status}`,
        checkedAt,
      }
    }
    await response.body?.cancel()
    return {
      name: options.name,
      state: 'up',
      critical: options.critical ?? false,
      latencyMs,
      message: null,
      checkedAt,
    }
  } catch (error) {
    return {
      name: options.name,
      state: 'down',
      critical: options.critical ?? false,
      latencyMs: Math.round(performance.now() - startedAt),
      message: messageFromError(error),
      checkedAt,
    }
  }
}

export async function checkTcpDependency(
  host: string | null,
  port: number | null,
  options: CheckOptions,
): Promise<DependencyHealth> {
  const checkedAt = new Date().toISOString()
  if (!host || !port) {
    return {
      name: options.name,
      state: 'disabled',
      critical: options.critical ?? false,
      latencyMs: null,
      message: 'Not configured',
      checkedAt,
    }
  }

  const startedAt = performance.now()
  return new Promise((resolve) => {
    let finished = false
    const socket = connect({ host, port })
    const finish = (state: 'up' | 'down', message: string | null): void => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve({
        name: options.name,
        state,
        critical: options.critical ?? false,
        latencyMs: Math.round(performance.now() - startedAt),
        message,
        checkedAt,
      })
    }
    socket.setTimeout(options.timeoutMs ?? 2_000)
    socket.once('connect', () => finish('up', null))
    socket.once('timeout', () => finish('down', 'Timed out'))
    socket.once('error', (error) => finish('down', messageFromError(error)))
  })
}
