import type { Graph, GraphSeries, GraphUnit } from '@pricklescope/contracts'

export interface SeriesPoint {
  timestamp: Date
  series: string
  value: number | null
}

// Rows arrive as one record per (timestamp, series). Charts need one shared
// ascending time axis with a value slot per series, and an explicit null wherever
// a series has no sample, so a gap draws as a break rather than a straight line.
export function alignSeries(points: SeriesPoint[], unit: GraphUnit, truncated = false): Graph {
  const timestamps = [...new Set(points.map((point) => point.timestamp.getTime()))].sort(
    (a, b) => a - b,
  )
  const slots = new Map(timestamps.map((value, index) => [value, index]))

  const names: string[] = []
  const byName = new Map<string, (number | null)[]>()
  for (const point of points) {
    let values = byName.get(point.series)
    if (!values) {
      values = new Array<number | null>(timestamps.length).fill(null)
      byName.set(point.series, values)
      names.push(point.series)
    }
    const index = slots.get(point.timestamp.getTime())
    if (index !== undefined) values[index] = point.value
  }

  const series: GraphSeries[] = names.map((name) => ({ name, values: byName.get(name)! }))
  return {
    unit,
    timestamps: timestamps.map((value) => Math.floor(value / 1000)),
    series,
    truncated,
  }
}

export function emptyGraph(unit: GraphUnit): Graph {
  return { unit, timestamps: [], series: [], truncated: false }
}
