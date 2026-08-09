import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'

import { formatAxisValue, formatChartValue, type ChartUnit } from './format.js'
import { seriesColor, type ChartTheme } from './palette.js'

export interface ChartSeries {
  name: string
  values: (number | null)[]
}

export interface TimeSeriesChartProps {
  /** Epoch seconds, ascending. */
  timestamps: number[]
  series: ChartSeries[]
  unit: ChartUnit
  theme: ChartTheme
  height?: number
  /** Draw a translucent band under a single series, as Grafana does. */
  fill?: boolean
  emptyMessage?: string
}

interface HoverState {
  index: number
  left: number
}

const ink = {
  light: { axis: '#657068', grid: '#e6ebe6' },
  dark: { axis: '#9ca9a0', grid: '#232d26' },
} as const

function withAlpha(color: string, alpha: number): string {
  const value = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')
  return `${color}${value}`
}

export function TimeSeriesChart({
  timestamps,
  series,
  unit,
  theme,
  height = 232,
  fill = false,
  emptyMessage = 'No data for this range',
}: TimeSeriesChartProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)

  const hasData =
    timestamps.length > 0 && series.some((item) => item.values.some((v) => v !== null))

  const data = useMemo(
    () => [timestamps, ...series.map((item) => item.values)] as uPlot.AlignedData,
    [timestamps, series],
  )

  useEffect(() => {
    const container = host.current
    if (!container || !hasData) return

    const colors = ink[theme]
    // uPlot's spline builder is monotone cubic: it smooths without overshooting,
    // so a rate series can never be drawn dipping below a value it never reached.
    const spline = uPlot.paths.spline?.()
    const options: uPlot.Options = {
      width: container.clientWidth || 320,
      height,
      // Our own React legend renders below the plot instead.
      legend: { show: false },
      cursor: {
        y: false,
        points: { size: 8 },
      },
      scales: {
        x: { time: true },
        // A percentage reads against a fixed 0–100 frame; letting it auto-range
        // to 200% makes a flat 100% line look like it sits halfway down.
        ...(unit === 'percent'
          ? {
              y: {
                range: (_self: uPlot, min: number, max: number) =>
                  [Math.min(0, min), Math.max(100, max)] as [number, number],
              },
            }
          : {}),
      },
      axes: [
        { stroke: colors.axis, grid: { stroke: colors.grid, width: 1 }, ticks: { show: false } },
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
          ticks: { show: false },
          // Wide enough for the longest tick this unit produces, so a label such
          // as "1.5 Gbit/s" is not clipped to ".5 Gbit/s".
          size: unit === 'bps' ? 78 : unit === 'ms' ? 62 : 52,
          values: (_self, splits) => splits.map((value) => formatAxisValue(value, unit)),
        },
      ],
      series: [
        {},
        ...series.map((item, index) => ({
          label: item.name,
          stroke: seriesColor(index, theme),
          width: 2,
          // The line carries the shape; a marker on every sample only adds noise.
          // The cursor still shows a point for whichever sample is hovered.
          points: { show: false },
          ...(spline ? { paths: spline } : {}),
          ...(fill && series.length === 1
            ? { fill: withAlpha(seriesColor(index, theme), 0.16) }
            : {}),
        })),
      ],
      hooks: {
        setCursor: [
          (self) => {
            const index = self.cursor.idx
            if (index === null || index === undefined) return setHover(null)
            setHover({ index, left: self.cursor.left ?? 0 })
          },
        ],
      },
    }

    const instance = new uPlot(options, data, container)

    const observer = new ResizeObserver(() => {
      instance.setSize({ width: container.clientWidth || 320, height })
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      instance.destroy()
    }
  }, [data, fill, hasData, height, series, theme, unit])

  if (!hasData) {
    return (
      <div className="chart-empty" style={{ height }}>
        {emptyMessage}
      </div>
    )
  }

  const hovered = hover
    ? series
        .map((item, index) => ({
          name: item.name,
          color: seriesColor(index, theme),
          value: item.values[hover.index] ?? null,
        }))
        .filter((entry) => entry.value !== null)
    : []

  return (
    <div className="chart">
      <div className="chart__plot" ref={host} />
      {hover && hovered.length ? (
        <div className="chart__tooltip" style={{ left: hover.left }} role="status" aria-live="off">
          <strong>{new Date((timestamps[hover.index] ?? 0) * 1000).toLocaleString()}</strong>
          {hovered.map((entry) => (
            <span key={entry.name}>
              <i style={{ background: entry.color }} aria-hidden="true" />
              {entry.name}
              <b>{formatChartValue(entry.value, unit)}</b>
            </span>
          ))}
        </div>
      ) : null}
      {series.length > 1 ? (
        <ul className="chart__legend">
          {series.map((item, index) => (
            <li key={item.name}>
              <i style={{ background: seriesColor(index, theme) }} aria-hidden="true" />
              {item.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
