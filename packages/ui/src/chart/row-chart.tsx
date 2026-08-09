import { formatChartValue, type ChartUnit } from './format.js'
import { seriesColor, type ChartTheme } from './palette.js'

// A compact filled area chart sized to sit under a table row. Plain SVG rather
// than a chart instance: a page can hold fifty of these at once, and at this
// height the shape, the scale, and the peak are the whole message.
export interface RowChartProps {
  /** Epoch seconds, ascending; the first and last are shown under the plot. */
  timestamps: number[]
  inbound: (number | null)[]
  outbound: (number | null)[]
  unit: ChartUnit
  theme: ChartTheme
  height?: number
  label: string
}

function clockTime(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined) return ''
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface Shape {
  line: string
  area: string
}

function build(values: (number | null)[], max: number, width: number, height: number): Shape {
  if (max <= 0) return { line: '', area: '' }
  const step = values.length > 1 ? width / (values.length - 1) : width
  let line = ''
  let area = ''
  let pen = false
  values.forEach((value, index) => {
    const x = index * step
    if (value === null) {
      if (pen) area += `L${x.toFixed(1)} ${height}`
      pen = false
      return
    }
    const y = height - (value / max) * height
    line += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
    area += pen
      ? `L${x.toFixed(1)} ${y.toFixed(1)}`
      : `M${x.toFixed(1)} ${height}L${x.toFixed(1)} ${y.toFixed(1)}`
    pen = true
  })
  if (pen) area += `L${width} ${height}Z`
  return { line, area }
}

// Round the top of the scale up to 1, 2, or 5 times a power of ten, so the axis
// reads "50 Mbit/s" rather than "42.69 Mbit/s".
function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

export function RowChart({
  timestamps,
  inbound,
  outbound,
  unit,
  theme,
  height = 96,
  label,
}: RowChartProps) {
  const width = 600
  const points = [...inbound, ...outbound].filter((value): value is number => value !== null)
  const observed = points.length ? Math.max(...points) : 0

  // A down or silent interface gets no graph at all rather than an empty frame.
  if (!points.length || observed <= 0) return null

  const peak = niceCeiling(observed)

  const inColor = seriesColor(0, theme)
  const outColor = seriesColor(1, theme)
  const inShape = build(inbound, peak, width, height)
  const outShape = build(outbound, peak, width, height)

  return (
    <div className="row-chart">
      <div className="row-chart__axis" aria-hidden="true" style={{ height }}>
        <span>{formatChartValue(peak, unit)}</span>
        <span>{formatChartValue(peak / 2, unit)}</span>
        <span>{formatChartValue(0, unit)}</span>
      </div>
      <div className="row-chart__plot" style={{ height }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}. Peak ${formatChartValue(observed, unit)}`}
        >
          {/* Inbound is the filled area and outbound the line on top, as Cacti
              draws it: the direction reads by shape as well as by colour. */}
          <path d={inShape.area} fill={inColor} fillOpacity={0.42} />
          <path
            d={inShape.line}
            fill="none"
            stroke={inColor}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={outShape.line}
            fill="none"
            stroke={outColor}
            strokeWidth={2.25}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      {/* The plot carries no axis of its own, so the span and the key live here. */}
      <div className="row-chart__footer">
        <span>{clockTime(timestamps[0])}</span>
        <span className="row-chart__rule" aria-hidden="true" />
        <span className="row-chart__key">
          <i style={{ background: inColor }} aria-hidden="true" />
          Inbound
        </span>
        <span className="row-chart__key">
          <i style={{ background: outColor }} aria-hidden="true" />
          Outbound
        </span>
        <span className="row-chart__rule" aria-hidden="true" />
        <span>{clockTime(timestamps[timestamps.length - 1])}</span>
      </div>
    </div>
  )
}
