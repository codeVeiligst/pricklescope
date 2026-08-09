// The palette itself lives in contracts, because the managed Grafana dashboards
// pin the same values and the adapter that builds them must not depend on a
// React package.
export { CHART_SERIES_COLORS, TRAFFIC_FILL_OPACITY, type ChartTheme } from '@pricklescope/contracts'

import { CHART_SERIES_COLORS, type ChartTheme } from '@pricklescope/contracts'

// Assign by position in the caller's fixed series order, never by rank.
export function seriesColor(index: number, theme: ChartTheme): string {
  const ramp = CHART_SERIES_COLORS[theme]
  return ramp[index % ramp.length]!
}
