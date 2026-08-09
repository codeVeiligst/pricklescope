import { Type, type Static } from '@sinclair/typebox'

// Series share one ascending timestamp axis so the browser can plot them without
// re-aligning anything. Gaps are explicit nulls rather than missing points, so a
// stale source draws a break instead of a straight line across the outage.
export const GraphSeriesSchema = Type.Object({
  name: Type.String(),
  values: Type.Array(Type.Union([Type.Number(), Type.Null()])),
})
export type GraphSeries = Static<typeof GraphSeriesSchema>

export const GraphUnitSchema = Type.Union([
  Type.Literal('percent'),
  Type.Literal('ms'),
  Type.Literal('bps'),
  Type.Literal('count'),
])
export type GraphUnit = Static<typeof GraphUnitSchema>

export const GraphSchema = Type.Object({
  unit: GraphUnitSchema,
  // Epoch seconds.
  timestamps: Type.Array(Type.Integer()),
  series: Type.Array(GraphSeriesSchema),
  truncated: Type.Boolean(),
})
export type Graph = Static<typeof GraphSchema>

export const GraphRangeQuerySchema = Type.Object({
  from: Type.Optional(Type.String({ format: 'date-time' })),
  to: Type.Optional(Type.String({ format: 'date-time' })),
})
export type GraphRangeQuery = Static<typeof GraphRangeQuerySchema>

export const FleetSourceRowSchema = Type.Object({
  sourceId: Type.String(),
  sourceName: Type.String(),
  siteId: Type.Union([Type.String(), Type.Null()]),
  lastSeen: Type.String({ format: 'date-time' }),
})
export type FleetSourceRow = Static<typeof FleetSourceRowSchema>

export const FleetGraphsSchema = Type.Object({
  availability: GraphSchema,
  sourcesReporting: Type.Integer(),
  latestSources: Type.Array(FleetSourceRowSchema),
})
export type FleetGraphs = Static<typeof FleetGraphsSchema>

// One entry per interface, all sharing the response's timestamp axis, so the
// inventory table can draw a graph per row from a single request.
export const InterfaceGraphSchema = Type.Object({
  ifIndex: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  inbound: Type.Array(Type.Union([Type.Number(), Type.Null()])),
  outbound: Type.Array(Type.Union([Type.Number(), Type.Null()])),
})
export type InterfaceGraph = Static<typeof InterfaceGraphSchema>

export const InterfaceGraphsSchema = Type.Object({
  unit: GraphUnitSchema,
  timestamps: Type.Array(Type.Integer()),
  interfaces: Type.Array(InterfaceGraphSchema),
})
export type InterfaceGraphs = Static<typeof InterfaceGraphsSchema>

export const SourceGraphsSchema = Type.Object({
  availability: GraphSchema,
  latency: GraphSchema,
  traffic: GraphSchema,
})
export type SourceGraphs = Static<typeof SourceGraphsSchema>
