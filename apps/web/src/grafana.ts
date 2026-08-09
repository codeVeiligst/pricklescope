export type GrafanaVariables = Record<string, string | string[] | null | undefined>

function applyVariables(parameters: URLSearchParams, variables: GrafanaVariables): void {
  for (const [name, value] of Object.entries(variables)) {
    if (Array.isArray(value)) {
      for (const item of value) parameters.append(`var-${name}`, item)
    } else if (value) {
      parameters.set(`var-${name}`, value)
    }
  }
}

// PrickleScope draws its own graphs; these links hand a user to Grafana for the
// same dashboards with the relevant variables already selected.
export function grafanaUrl(
  dashboardUid: string,
  variables: GrafanaVariables = {},
  options: { panelId?: number } = {},
): string {
  const route = options.panelId ? 'd-solo' : 'd'
  const parameters = new URLSearchParams({ orgId: '1', from: 'now-6h', to: 'now' })
  if (options.panelId) parameters.set('panelId', String(options.panelId))
  applyVariables(parameters, variables)
  return `/grafana/${route}/${dashboardUid}?${parameters.toString()}`
}
