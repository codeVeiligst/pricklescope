import { formatChartValue, type ChartUnit } from './format.js'

// A single headline number. Deliberately not a chart: one value has no shape to
// read, so a plot would add furniture without adding information.
export function StatTile({
  value,
  unit = 'count',
  caption,
}: {
  value: number | null
  unit?: ChartUnit
  caption?: string
}) {
  return (
    <div className="stat-tile">
      <strong>{formatChartValue(value, unit)}</strong>
      {caption ? <span>{caption}</span> : null}
    </div>
  )
}
