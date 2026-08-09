import { describe, expect, it } from 'vitest'

import { bucket } from './questdb.js'

function range(minutes: number) {
  const to = new Date('2026-08-06T12:00:00Z')
  return { from: new Date(to.getTime() - minutes * 60_000), to }
}

describe('graph downsampling interval', () => {
  it('keeps a short range at fine resolution', () => {
    expect(bucket(range(60))).toBe('1m')
    expect(bucket(range(6 * 60))).toBe('5m')
  })

  it('widens the bucket as the range grows so the row count stays bounded', () => {
    expect(bucket(range(24 * 60))).toBe('15m')
    expect(bucket(range(7 * 24 * 60))).toBe('1h')
    expect(bucket(range(90 * 24 * 60))).toBe('1d')
  })

  it('never returns a bucket outside the documented steps', () => {
    const steps = new Set(['1m', '5m', '15m', '30m', '1h', '6h', '1d'])
    for (const minutes of [1, 5, 30, 180, 1440, 10_080, 129_600]) {
      expect(steps.has(bucket(range(minutes)))).toBe(true)
    }
  })
})
