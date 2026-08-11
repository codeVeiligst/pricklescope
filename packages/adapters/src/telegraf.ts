import { createHash } from 'node:crypto'

export type TelegrafSnmpCredential =
  | { version: '2c'; community: string }
  | {
      version: '3'
      username: string
      securityLevel: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv'
      authProtocol?: 'sha' | 'sha224' | 'sha256' | 'sha384' | 'sha512'
      authPassword?: string
      privacyProtocol?: 'aes' | 'aes256b' | 'aes256r'
      privacyPassword?: string
    }

export interface TelegrafCheckDesiredState {
  checkId: string
  sourceId: string
  sourceName: string
  target: string
  port: number
  transport: 'udp4' | 'udp6'
  siteId: string | null
  tags: string[]
  intervalSeconds: number
  timeoutMs: number
  retries: number
  collectSystem: boolean
  collectInterfaces: boolean
  credential: TelegrafSnmpCredential
}

export interface TelegrafRenderedConfig {
  content: string
  redactedContent: string
  contentHash: string
  sourceCount: number
  checkCount: number
}

export interface CollectorConfigurationAdapter<TDesired, TRendered> {
  readonly kind: string
  render(desiredState: TDesired): TRendered
  validate(content: string, expectedChecks: number): void
}

function string(value: string): string {
  return JSON.stringify(value)
}

/**
 * Text for a TOML comment, with everything that could end the comment removed.
 *
 * A comment is the one place a value is not quoted, and a newline in it ends the
 * comment — so a source named `Evil\n[[inputs.exec]]\n  commands = [...]` used to
 * render a real Telegraf input. `inputs.exec` runs commands on the collector
 * host, which made naming a source a way to execute code there.
 *
 * Control characters are replaced rather than rejected here so that rendering
 * cannot fail on data already in the database; `validateTelegrafDesiredState`
 * refuses them at the front, and `validateTelegrafCandidate` checks the rendered
 * output for tables the renderer never emits.
 */
function comment(value: string): string {
  // Matching control characters is the entire purpose of this expression.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 200)
}

function tagBlock(check: TelegrafCheckDesiredState): string[] {
  const lines = [
    `    collector = "telegraf"`,
    `    source_id = ${string(check.sourceId)}`,
    `    check_id = ${string(check.checkId)}`,
    `    source_name = ${string(check.sourceName)}`,
  ]
  if (check.siteId) lines.push(`    site_id = ${string(check.siteId)}`)
  if (check.tags.length) lines.push(`    source_tags = ${string([...check.tags].sort().join(','))}`)
  return lines
}

function endpoint(check: TelegrafCheckDesiredState): string {
  const target =
    check.transport === 'udp6' ? `[${check.target.replace(/^\[|\]$/g, '')}]` : check.target
  return `udp://${target}:${check.port}`
}

function seconds(milliseconds: number): string {
  return `${milliseconds / 1000}s`
}

const rateProcessor = `# Derive reset-aware rates before the raw counters are converted for lossless storage.
[[processors.starlark]]
  order = 1
  namepass = ["network_system", "network_interface"]
  source = '''
COUNTERS = {
    "if_in_octets": 18446744073709551615,
    "if_out_octets": 18446744073709551615,
    "if_in_errors": 4294967295,
    "if_out_errors": 4294967295,
}

def identity(metric):
    return "%s:%s" % (metric.tags.get("source_id", ""), metric.tags.get("check_id", ""))

def apply(metric):
    owner = identity(metric)
    if metric.name == "network_system":
        uptime = metric.fields.get("sys_uptime")
        if uptime != None:
            state["uptime:" + owner] = uptime
        return metric

    interface_id = metric.tags.get("if_index", "")
    discontinuity = metric.fields.get("if_counter_discontinuity_time")
    uptime = state.get("uptime:" + owner)
    rates = {}
    for field, maximum in COUNTERS.items():
        value = metric.fields.get(field)
        if value == None:
            continue
        key = "counter:%s:%s:%s" % (owner, interface_id, field)
        previous = state.get(key)
        state[key] = (value, metric.time, discontinuity, uptime)
        if previous == None:
            continue
        old_value, old_time, old_discontinuity, old_uptime = previous
        elapsed = float(metric.time - old_time) / 1000000000.0
        if elapsed <= 0:
            continue
        if old_uptime != None and uptime != None and uptime < old_uptime:
            continue
        if old_discontinuity != None and discontinuity != None and discontinuity != old_discontinuity:
            continue
        if value >= old_value:
            delta = value - old_value
        elif old_value > maximum * 8 // 10 and value < maximum * 2 // 10:
            delta = maximum - old_value + 1 + value
        else:
            continue
        rates[field + "_per_second"] = float(delta) / elapsed

    if len(rates) == 0:
        return metric
    rate_metric = Metric("network_interface_rate", metric.tags, rates)
    rate_metric.time = metric.time
    return [metric, rate_metric]
'''

[[processors.converter]]
  order = 2
  namepass = ["network_interface"]
  [processors.converter.fields]
    string = ["if_in_octets", "if_out_octets", "if_in_errors", "if_out_errors"]
`

function credentialLines(credential: TelegrafSnmpCredential, redact: boolean): string[] {
  const secret = (value: string): string => string(redact ? '[REDACTED]' : value)
  if (credential.version === '2c') {
    return ['  version = 2', `  community = ${secret(credential.community)}`]
  }

  const lines = [
    '  version = 3',
    `  sec_name = ${string(credential.username)}`,
    `  sec_level = ${string(credential.securityLevel)}`,
  ]
  if (credential.securityLevel !== 'noAuthNoPriv') {
    lines.push(`  auth_protocol = ${string(credential.authProtocol!.toUpperCase())}`)
    lines.push(`  auth_password = ${secret(credential.authPassword!)}`)
  }
  if (credential.securityLevel === 'authPriv') {
    lines.push(`  priv_protocol = ${string(credential.privacyProtocol!.toUpperCase())}`)
    lines.push(`  priv_password = ${secret(credential.privacyPassword!)}`)
  }
  return lines
}

function renderCheck(check: TelegrafCheckDesiredState, redact: boolean): string {
  const lines = [
    `# ${comment(check.sourceName)} (${check.sourceId})`,
    '[[inputs.ping]]',
    `  urls = [${string(check.target)}]`,
    '  method = "exec"',
    '  count = 1',
    `  deadline = ${Math.max(1, Math.ceil(check.timeoutMs / 1000))}`,
    `  interval = ${string(`${check.intervalSeconds}s`)}`,
    '  name_override = "network_availability"',
    '',
    '  [inputs.ping.tags]',
    ...tagBlock(check),
    '',
    '[[inputs.snmp]]',
    `  agents = [${string(endpoint(check))}]`,
    `  interval = ${string(`${check.intervalSeconds}s`)}`,
    `  timeout = ${string(seconds(check.timeoutMs))}`,
    `  retries = ${check.retries}`,
    '  agent_host_tag = "source"',
    '  name = "network_system"',
    ...credentialLines(check.credential, redact),
    '',
    '  [inputs.snmp.tags]',
    ...tagBlock(check),
  ]

  if (check.collectSystem) {
    lines.push(
      '',
      '  [[inputs.snmp.field]]',
      '    name = "sys_name"',
      '    oid = ".1.3.6.1.2.1.1.5.0"',
      '    is_tag = true',
      '  [[inputs.snmp.field]]',
      '    name = "sys_description"',
      '    oid = ".1.3.6.1.2.1.1.1.0"',
      '  [[inputs.snmp.field]]',
      '    name = "sys_object_id"',
      '    oid = ".1.3.6.1.2.1.1.2.0"',
      '  [[inputs.snmp.field]]',
      '    name = "sys_uptime"',
      '    oid = ".1.3.6.1.2.1.1.3.0"',
    )
  }

  if (check.collectInterfaces) {
    lines.push(
      '',
      '  [[inputs.snmp.table]]',
      '    name = "network_interface"',
      '    inherit_tags = ["collector", "source_id", "check_id", "source_name", "site_id", "source_tags"]',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_index"',
      '      oid = ".1.3.6.1.2.1.2.2.1.1"',
      '      is_tag = true',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_description"',
      '      oid = ".1.3.6.1.2.1.2.2.1.2"',
      '      is_tag = true',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_type"',
      '      oid = ".1.3.6.1.2.1.2.2.1.3"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_mtu"',
      '      oid = ".1.3.6.1.2.1.2.2.1.4"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_speed"',
      '      oid = ".1.3.6.1.2.1.2.2.1.5"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_admin_status"',
      '      oid = ".1.3.6.1.2.1.2.2.1.7"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_oper_status"',
      '      oid = ".1.3.6.1.2.1.2.2.1.8"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_counter_discontinuity_time"',
      '      oid = ".1.3.6.1.2.1.31.1.1.1.19"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_in_octets"',
      '      oid = ".1.3.6.1.2.1.31.1.1.1.6"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_out_octets"',
      '      oid = ".1.3.6.1.2.1.31.1.1.1.10"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_in_errors"',
      '      oid = ".1.3.6.1.2.1.2.2.1.14"',
      '    [[inputs.snmp.table.field]]',
      '      name = "if_out_errors"',
      '      oid = ".1.3.6.1.2.1.2.2.1.20"',
    )
  }
  return `${lines.join('\n')}\n`
}

/** Anything that could end a line, a comment, or a quoted string. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export function validateTelegrafDesiredState(checks: TelegrafCheckDesiredState[]): void {
  const ids = new Set<string>()
  for (const check of checks) {
    if (!check.checkId || !check.sourceId || !check.sourceName.trim() || !check.target.trim()) {
      throw new Error('Every Telegraf check needs stable identity, name, and target values')
    }
    // Refused at the front rather than escaped later. A newline in a name is
    // never legitimate, and it is what turned a source name into a Telegraf
    // input that runs commands.
    for (const [field, value] of [
      ['name', check.sourceName],
      ['target', check.target],
      ...check.tags.map((tag) => ['tag', tag] as const),
    ] as const) {
      if (CONTROL_CHARACTERS.test(value)) {
        throw new Error(`A Telegraf check ${field} cannot contain control characters`)
      }
    }
    if (ids.has(check.checkId)) throw new Error(`Duplicate Telegraf check ${check.checkId}`)
    ids.add(check.checkId)
    if (check.port < 1 || check.port > 65_535)
      throw new Error(`Invalid port for ${check.sourceName}`)
    if (check.intervalSeconds < 10 || check.timeoutMs < 250 || check.retries < 0) {
      throw new Error(`Invalid polling profile for ${check.sourceName}`)
    }
    if (!check.collectSystem && !check.collectInterfaces) {
      throw new Error(`No SNMP metric groups are enabled for ${check.sourceName}`)
    }
    if (check.credential.version === '2c' && !check.credential.community) {
      throw new Error(`SNMP community is missing for ${check.sourceName}`)
    }
    if (check.credential.version === '3') {
      const credential = check.credential
      if (!credential.username)
        throw new Error(`SNMPv3 username is missing for ${check.sourceName}`)
      if (
        credential.securityLevel !== 'noAuthNoPriv' &&
        (!credential.authProtocol || !credential.authPassword)
      ) {
        throw new Error(`SNMPv3 authentication is incomplete for ${check.sourceName}`)
      }
      if (
        credential.securityLevel === 'authPriv' &&
        (!credential.privacyProtocol || !credential.privacyPassword)
      ) {
        throw new Error(`SNMPv3 privacy is incomplete for ${check.sourceName}`)
      }
    }
  }
}

/**
 * Telegraf reporting on itself, which is where the health dashboard and the
 * collector alerts get their data. Until 2026-08-11 nothing wrote
 * `collector_health` at all, so the dashboard drew an empty chart permanently and
 * an alert over it would have sat in NoData forever.
 *
 * `name_override` collapses the internal plugin's several measurements into the
 * one controller-owned table. That matters for more than tidiness: the bootstrap
 * configuration used to run this input unmanaged, and its `internal_*` tables
 * were created implicitly by the line protocol, so the retention reconciler never
 * saw them and they grew without limit — twenty thousand rows in the first forty
 * minutes of a fresh install.
 *
 * No processor is involved. The rate pipeline below uses explicit `order`, and
 * adding unordered processors alongside it would change when they run.
 */
const healthInput = `# Collector health. The controller owns this table, so retention applies to it.
[[inputs.internal]]
  collect_memstats = false
  name_override = "collector_health"
`

/** Every table this renderer is capable of emitting. Anything else is injected. */
const RENDERED_TABLES = new Set([
  '[[inputs.ping]]',
  '[inputs.ping.tags]',
  '[[inputs.snmp]]',
  '[inputs.snmp.tags]',
  '[[inputs.snmp.field]]',
  '[[inputs.snmp.table]]',
  '[[inputs.snmp.table.field]]',
  '[[inputs.internal]]',
  '[[processors.starlark]]',
  '[[processors.converter]]',
  '[processors.converter.fields]',
])

export function validateTelegrafCandidate(content: string, expectedChecks: number): void {
  if (!content.endsWith('\n') || content.includes('\0')) {
    throw new Error('Rendered Telegraf configuration is not valid UTF-8 text')
  }
  // The last line of defence, and the one that does not depend on knowing which
  // field was unsafe: if a table appears that this renderer cannot produce, the
  // configuration is not published, whatever put it there.
  for (const line of content.split('\n')) {
    const table = /^\s*(\[\[?[^\]]+\]\]?)\s*$/.exec(line)?.[1]
    if (table && !RENDERED_TABLES.has(table)) {
      throw new Error(`Rendered Telegraf configuration contains an unexpected table: ${table}`)
    }
  }
  if (content.includes('[REDACTED]')) {
    throw new Error('A redacted secret cannot be activated as Telegraf configuration')
  }
  const snmpInputs = content.match(/^\[\[inputs\.snmp\]\]$/gm)?.length ?? 0
  const pingInputs = content.match(/^\[\[inputs\.ping\]\]$/gm)?.length ?? 0
  if (snmpInputs !== expectedChecks || pingInputs !== expectedChecks) {
    throw new Error('Rendered Telegraf configuration does not match the desired check count')
  }
  if (/^\s*(community|auth_password|priv_password)\s*=\s*""\s*$/m.test(content)) {
    throw new Error('Rendered Telegraf configuration contains an empty credential secret')
  }
}

export function renderTelegrafConfig(checks: TelegrafCheckDesiredState[]): TelegrafRenderedConfig {
  validateTelegrafDesiredState(checks)
  const ordered = [...checks].sort((left, right) => left.checkId.localeCompare(right.checkId))
  const header = '# Managed by PrickleScope. Manual edits will be replaced.\n\n'
  // The health input is unconditional: a collector with no checks yet is exactly
  // the situation where knowing the collector is alive matters most.
  const trailer = `\n${healthInput}\n${rateProcessor}`
  const content = header + ordered.map((check) => renderCheck(check, false)).join('\n') + trailer
  const redactedContent =
    header + ordered.map((check) => renderCheck(check, true)).join('\n') + trailer
  validateTelegrafCandidate(content, ordered.length)
  return {
    content,
    redactedContent,
    contentHash: createHash('sha256').update(content).digest('hex'),
    sourceCount: new Set(ordered.map((check) => check.sourceId)).size,
    checkCount: ordered.length,
  }
}

export const telegrafAdapter: CollectorConfigurationAdapter<
  TelegrafCheckDesiredState[],
  TelegrafRenderedConfig
> = {
  kind: 'telegraf',
  render: renderTelegrafConfig,
  validate: validateTelegrafCandidate,
}
