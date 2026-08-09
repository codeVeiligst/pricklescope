export type ChartUnit = 'percent' | 'ms' | 'bps' | 'count'

const BIT_STEPS = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s']

function trim(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString()
}

export function formatChartValue(value: number | null | undefined, unit: ChartUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  switch (unit) {
    case 'percent':
      return `${trim(value, 2)}%`
    case 'ms':
      return value >= 1000 ? `${trim(value / 1000, 2)} s` : `${trim(value, 2)} ms`
    case 'bps': {
      let scaled = Math.abs(value)
      let step = 0
      while (scaled >= 1000 && step < BIT_STEPS.length - 1) {
        scaled /= 1000
        step += 1
      }
      const sign = value < 0 ? '-' : ''
      return `${sign}${trim(scaled, 2)} ${BIT_STEPS[step]}`
    }
    case 'count':
      return trim(value, 0)
  }
}

// Axis ticks stay terser than tooltip values so they do not collide.
export function formatAxisValue(value: number, unit: ChartUnit): string {
  if (unit === 'percent') return `${trim(value, 0)}%`
  if (unit === 'count') return trim(value, 0)
  return formatChartValue(value, unit)
}
