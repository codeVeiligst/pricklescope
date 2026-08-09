import { describe, expect, it } from 'vitest'

import { alignSeries, emptyGraph } from './series.js'

const at = (iso: string) => new Date(iso)

describe('graph series alignment', () => {
  it('shares one ascending axis and leaves a null where a series has no sample', () => {
    const graph = alignSeries(
      [
        { timestamp: at('2026-08-06T10:02:00Z'), series: 'core-01', value: 99 },
        { timestamp: at('2026-08-06T10:00:00Z'), series: 'core-01', value: 100 },
        { timestamp: at('2026-08-06T10:00:00Z'), series: 'edge-02', value: 98 },
      ],
      'percent',
    )

    expect(graph.timestamps).toEqual([
      Math.floor(at('2026-08-06T10:00:00Z').getTime() / 1000),
      Math.floor(at('2026-08-06T10:02:00Z').getTime() / 1000),
    ])
    expect(graph.series).toEqual([
      { name: 'core-01', values: [100, 99] },
      { name: 'edge-02', values: [98, null] },
    ])
    expect(graph.unit).toBe('percent')
  })

  it('keeps series order stable so a colour never follows rank', () => {
    const graph = alignSeries(
      [
        { timestamp: at('2026-08-06T10:00:00Z'), series: 'b', value: 1 },
        { timestamp: at('2026-08-06T10:00:00Z'), series: 'a', value: 2 },
      ],
      'count',
    )
    expect(graph.series.map((item) => item.name)).toEqual(['b', 'a'])
  })

  it('reports an empty graph rather than inventing points', () => {
    expect(alignSeries([], 'ms')).toEqual(emptyGraph('ms'))
    expect(emptyGraph('bps')).toEqual({ unit: 'bps', timestamps: [], series: [], truncated: false })
  })
})
