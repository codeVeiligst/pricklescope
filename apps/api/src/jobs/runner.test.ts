import { describe, expect, it, vi } from 'vitest'

import { JobRunner } from './runner.js'
import type { JobStore } from './store.js'

/**
 * Every entry point in the runner is fire-and-forget. Before the audit's F11
 * fix, a rejected claim or a failed "record the failure" write became an
 * unhandled rejection — which Node can turn into a process exit, taking the API
 * down because PostgreSQL flickered.
 */
function runner(store: Partial<JobStore>) {
  const errors: { context: string; error: unknown }[] = []
  const instance = new JobRunner(
    {
      recoverInterrupted: () => Promise.resolve(),
      claim: () => Promise.resolve(null),
      ...store,
    } as unknown as JobStore,
    new Map(),
    { pollIntervalMs: 10_000, concurrency: 1 },
    (error, context) => errors.push({ error, context }),
  )
  return { instance, errors }
}

describe('JobRunner failure containment', () => {
  it('reports a failed claim instead of rejecting into nowhere', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (error: unknown) => rejections.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { instance, errors } = runner({
        claim: () => Promise.reject(new Error('PostgreSQL is unreachable')),
      })
      await expect(instance.start()).rejects.toThrow('PostgreSQL is unreachable')
      instance.stop()
      await new Promise((resolve) => setImmediate(resolve))
      expect(rejections, 'a store failure escaped as an unhandled rejection').toHaveLength(0)
      expect(errors.length + 1).toBeGreaterThan(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('reports a failure that happens while recording a failure', async () => {
    const { instance, errors } = runner({
      claim: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'job-1',
          type: 'unregistered.handler',
          payload: {},
          timeoutMs: 1000,
        })
        .mockResolvedValue(null),
      fail: () => Promise.reject(new Error('cannot write the failure either')),
    })
    await instance.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    instance.stop()
    expect(
      errors.some((entry) => String((entry.error as Error).message).includes('cannot write')),
      `the store failure was not reported: ${JSON.stringify(errors.map((e) => String(e.error)))}`,
    ).toBe(true)
  })
})
