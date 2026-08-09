import type { FleetGraphs, InterfaceGraphs, SourceGraphs } from '@pricklescope/contracts'

import type { QuestDbClient } from '../storage/questdb.js'
import { alignSeries, emptyGraph, type SeriesPoint } from './series.js'

export interface GraphRange {
  from: Date
  to: Date
}

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
// Three interfaces fill six chart series once split into inbound and outbound,
// which is the point where a legend stops being readable.
const MAX_TRAFFIC_SERIES = 3

export function resolveRange(from?: string, to?: string): GraphRange {
  const end = to ? new Date(to) : new Date()
  if (Number.isNaN(end.getTime())) throw new Error('The requested end time is not a valid date')
  const start = from ? new Date(from) : new Date(end.getTime() - DEFAULT_WINDOW_MS)
  if (Number.isNaN(start.getTime())) throw new Error('The requested start time is not a valid date')
  if (start >= end) throw new Error('The requested range must start before it ends')
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new Error('The requested range is longer than the supported 90 days')
  }
  return { from: start, to: end }
}

export class GraphService {
  constructor(private readonly questdb: QuestDbClient | null) {}

  private get client(): QuestDbClient {
    if (!this.questdb) throw new Error('QuestDB is not configured')
    return this.questdb
  }

  async fleet(range: GraphRange): Promise<FleetGraphs> {
    const [rows, sourcesReporting, latest] = await Promise.all([
      this.client.availabilitySeries(range),
      this.client.sourcesReporting(range),
      this.client.latestSources(range),
    ])

    const points: SeriesPoint[] = rows.map((row) => ({
      timestamp: row.timestamp,
      series: row.source_name,
      value: row.availability,
    }))

    return {
      availability: points.length ? alignSeries(points, 'percent') : emptyGraph('percent'),
      sourcesReporting,
      latestSources: latest.map((row) => ({
        sourceId: row.source_id,
        sourceName: row.source_name,
        siteId: row.site_id,
        lastSeen: row.last_seen.toISOString(),
      })),
    }
  }

  async interfaces(sourceId: string, range: GraphRange): Promise<InterfaceGraphs> {
    const rows = await this.client.interfaceSeries({ ...range, sourceId })
    if (!rows.length) return { unit: 'bps', timestamps: [], interfaces: [] }

    // Align inbound and outbound on one shared axis, then split them back out
    // per interface so each table row draws from the same timestamps.
    const inbound = alignSeries(
      rows.map((row) => ({
        timestamp: row.timestamp,
        series: row.if_index,
        value: row.inbound_bps,
      })),
      'bps',
    )
    const outbound = alignSeries(
      rows.map((row) => ({
        timestamp: row.timestamp,
        series: row.if_index,
        value: row.outbound_bps,
      })),
      'bps',
    )
    const descriptions = new Map(rows.map((row) => [row.if_index, row.if_description]))
    const outboundByIndex = new Map(outbound.series.map((item) => [item.name, item.values]))

    return {
      unit: 'bps',
      timestamps: inbound.timestamps,
      interfaces: inbound.series.map((item) => ({
        ifIndex: item.name,
        description: descriptions.get(item.name) ?? null,
        inbound: item.values,
        outbound: outboundByIndex.get(item.name) ?? [],
      })),
    }
  }

  async source(sourceId: string, range: GraphRange): Promise<SourceGraphs> {
    const scope = { ...range, sourceId }
    const busiest = await this.client.busiestInterfaces(scope, MAX_TRAFFIC_SERIES)
    const [availability, latency, traffic] = await Promise.all([
      this.client.availabilitySeries(scope),
      this.client.latencySeries(scope),
      this.client.trafficSeries(scope, busiest),
    ])

    const availabilityPoints: SeriesPoint[] = availability.map((row) => ({
      timestamp: row.timestamp,
      series: 'Availability',
      value: row.availability,
    }))

    const latencyPoints: SeriesPoint[] = latency.flatMap((row) => [
      { timestamp: row.timestamp, series: 'Average', value: row.average_response_ms },
      { timestamp: row.timestamp, series: 'Maximum', value: row.maximum_response_ms },
    ])

    const trafficPoints: SeriesPoint[] = traffic.flatMap((row) => {
      const label = row.if_description ?? `Interface ${row.if_index}`
      return [
        { timestamp: row.timestamp, series: `${label} in`, value: row.inbound_bps },
        { timestamp: row.timestamp, series: `${label} out`, value: row.outbound_bps },
      ]
    })

    return {
      availability: availabilityPoints.length
        ? alignSeries(availabilityPoints, 'percent')
        : emptyGraph('percent'),
      latency: latencyPoints.length ? alignSeries(latencyPoints, 'ms') : emptyGraph('ms'),
      traffic: trafficPoints.length
        ? alignSeries(trafficPoints, 'bps', busiest.length >= MAX_TRAFFIC_SERIES)
        : emptyGraph('bps'),
    }
  }
}
