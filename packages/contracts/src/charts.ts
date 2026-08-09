// The canonical series palette, shared by the in-product charts and the managed
// Grafana dashboards so the same measurement is the same colour in both.
//
// Green then blue, the pair Cacti and MRTG trained network operators on: inbound
// green, outbound blue. That order also separates about twice as well as
// Grafana's green/yellow default under red/green colour deficiency (ΔE 23.6
// against 9.9), which matters because interface in/out is the most-read chart
// here.
//
// Dark is a separately chosen set from the same hue families, not a flip of
// light: one list cannot clear the contrast floor against both a white and a
// near-black surface. Both lists pass the lightness band, chroma floor, adjacent
// colour-vision separation, the normal-vision floor, and 3:1 contrast.
//
// Slot order is fixed and never cycled: a series keeps its colour when other
// series are filtered away.
export const CHART_SERIES_COLORS = {
  light: ['#2e7d32', '#1565c0', '#c2570a', '#5a4bab', '#7a6a10', '#a1478f'],
  dark: ['#4f9f4a', '#5a93d6', '#d1732f', '#9182dd', '#a38e2f', '#bf6dab'],
} as const

export type ChartTheme = keyof typeof CHART_SERIES_COLORS

// Grafana renders one theme per user and cannot vary colours per theme, so the
// managed dashboards use the dark steps.
export const GRAFANA_SERIES_COLORS = CHART_SERIES_COLORS.dark

// Inbound is drawn as a filled area and outbound as a plain line, the way Cacti
// and MRTG have always drawn traffic. The direction is then encoded by shape as
// well as by hue, so the pair stays readable without colour, and two translucent
// fills never overlap into a muddy band.
export const TRAFFIC_FILL_OPACITY = 34
