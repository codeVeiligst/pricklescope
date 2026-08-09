import { describe, expect, it } from 'vitest'

import { parseUtcTimestamp } from './questdb.js'

// QuestDB stores UTC but returns TIMESTAMP without a zone marker. Reading it in
// the host's zone shifted every sample, so a graph in Brussels showed data two
// hours older than it was.
describe('QuestDB timestamp parsing', () => {
  it('reads a zoneless timestamp as UTC, whatever the host zone is', () => {
    expect(parseUtcTimestamp('2026-08-06 14:16:00.288000').toISOString()).toBe(
      '2026-08-06T14:16:00.288Z',
    )
    expect(parseUtcTimestamp('2026-08-06 14:16:00').toISOString()).toBe('2026-08-06T14:16:00.000Z')
  })

  it('accepts the ISO and already-zoned forms unchanged', () => {
    expect(parseUtcTimestamp('2026-08-06T14:16:00.288000').toISOString()).toBe(
      '2026-08-06T14:16:00.288Z',
    )
    expect(parseUtcTimestamp('2026-08-06T14:16:00Z').toISOString()).toBe('2026-08-06T14:16:00.000Z')
  })

  it('never depends on the process offset', () => {
    const parsed = parseUtcTimestamp('2026-01-15 08:30:00')
    expect(parsed.getTime()).toBe(Date.UTC(2026, 0, 15, 8, 30, 0))
  })
})
