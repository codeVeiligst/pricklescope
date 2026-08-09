import type {
  InventoryInterface,
  InventorySystem,
  SnmpAuthProtocol,
  SnmpPrivacyProtocol,
  SnmpSecurityLevel,
} from '@pricklescope/contracts'
import * as snmp from 'net-snmp'

export type SnmpAccess =
  | { version: '2c'; community: string }
  | {
      version: '3'
      username: string
      securityLevel: SnmpSecurityLevel
      authProtocol?: SnmpAuthProtocol
      authPassword?: string
      privacyProtocol?: SnmpPrivacyProtocol
      privacyPassword?: string
    }

export interface SnmpTarget {
  target: string
  port: number
  transport: 'udp4' | 'udp6'
  timeoutMs: number
  retries: number
  access: SnmpAccess
}

export interface SnmpProbeResult {
  system: InventorySystem
  interfaces: InventoryInterface[]
  partial: boolean
  errors: string[]
}

const systemOids = [
  '1.3.6.1.2.1.1.1.0',
  '1.3.6.1.2.1.1.2.0',
  '1.3.6.1.2.1.1.3.0',
  '1.3.6.1.2.1.1.4.0',
  '1.3.6.1.2.1.1.5.0',
  '1.3.6.1.2.1.1.6.0',
] as const

function authProtocol(protocol: SnmpAuthProtocol): snmp.AuthProtocols {
  return snmp.AuthProtocols[protocol]
}

function privacyProtocol(protocol: SnmpPrivacyProtocol): snmp.PrivProtocols {
  return snmp.PrivProtocols[protocol]
}

function securityLevel(level: SnmpSecurityLevel): snmp.SecurityLevel {
  return snmp.SecurityLevel[level]
}

function createSession(target: SnmpTarget): snmp.Session {
  const options = {
    port: target.port,
    retries: target.retries,
    timeout: target.timeoutMs,
    backoff: 1,
    transport: target.transport,
    reportOidMismatchErrors: true,
  } as const
  if (target.access.version === '2c') {
    return snmp.createSession(target.target, target.access.community, {
      ...options,
      version: snmp.Version2c,
    })
  }
  const user: snmp.User = {
    name: target.access.username,
    level: securityLevel(target.access.securityLevel),
  }
  if (target.access.authProtocol) user.authProtocol = authProtocol(target.access.authProtocol)
  if (target.access.authPassword) user.authKey = target.access.authPassword
  if (target.access.privacyProtocol)
    user.privProtocol = privacyProtocol(target.access.privacyProtocol)
  if (target.access.privacyPassword) user.privKey = target.access.privacyPassword
  return snmp.createV3Session(target.target, user, { ...options, version: snmp.Version3 })
}

function readable(value: snmp.VarbindValue): string | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8').replaceAll('\0', '').trim()
    return text && /^[\t\n\r\x20-\x7e\u00a0-\uffff]+$/u.test(text) ? text : value.toString('hex')
  }
  return String(value)
}

function numeric(value: snmp.VarbindValue): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function macAddress(value: snmp.VarbindValue): string | null {
  if (Buffer.isBuffer(value))
    return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(':')
  return readable(value)
}

function get(session: snmp.Session, oids: readonly string[]): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    session.get([...oids], (error, varbinds) => {
      if (error) return reject(error)
      if (!varbinds) return reject(new Error('SNMP response did not contain values'))
      for (const varbind of varbinds) {
        if (snmp.isVarbindError(varbind)) return reject(new Error(snmp.varbindError(varbind)))
      }
      resolve(varbinds)
    })
  })
}

type TableRows = Record<string, Record<string, snmp.VarbindValue>>

function tableColumns(session: snmp.Session, oid: string, columns: string[]): Promise<TableRows> {
  return new Promise((resolve, reject) => {
    session.tableColumns(oid, columns, 20, (error, table) => {
      if (error) return reject(error)
      if (!table) return reject(new Error(`SNMP table ${oid} returned no data`))
      // net-snmp returns rows keyed by instance, then columns. Its published
      // TypeScript type currently describes the inverse shape.
      resolve(table)
    })
  })
}

function tableValue(table: TableRows, column: string, index: number): snmp.VarbindValue {
  return table[String(index)]?.[column]
}

async function readSystem(session: snmp.Session): Promise<InventorySystem> {
  const values = await get(session, systemOids)
  return {
    description: readable(values[0]?.value),
    objectId: readable(values[1]?.value),
    uptimeTicks: numeric(values[2]?.value),
    contact: readable(values[3]?.value),
    name: readable(values[4]?.value),
    location: readable(values[5]?.value),
  }
}

async function readInterfaces(session: snmp.Session): Promise<InventoryInterface[]> {
  const core = await tableColumns(session, '1.3.6.1.2.1.2.2', [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
  ])
  let highCapacity: TableRows = {}
  try {
    highCapacity = await tableColumns(session, '1.3.6.1.2.1.31.1.1.1', ['1', '15', '18'])
  } catch {
    // Older agents may not expose IF-MIB::ifXTable; the base table remains useful.
  }
  const indices = new Set(Object.keys(core).map(Number))
  return [...indices]
    .filter(Number.isInteger)
    .sort((left, right) => left - right)
    .map((index) => {
      const highSpeedMbps = numeric(tableValue(highCapacity, '15', index))
      const baseSpeed = numeric(tableValue(core, '5', index))
      return {
        index: numeric(tableValue(core, '1', index)) ?? index,
        name: readable(tableValue(highCapacity, '1', index)),
        description: readable(tableValue(core, '2', index)),
        alias: readable(tableValue(highCapacity, '18', index)),
        type: numeric(tableValue(core, '3', index)),
        mtu: numeric(tableValue(core, '4', index)),
        speedBps: highSpeedMbps && highSpeedMbps > 0 ? highSpeedMbps * 1_000_000 : baseSpeed,
        macAddress: macAddress(tableValue(core, '6', index)),
        adminStatus: numeric(tableValue(core, '7', index)),
        operStatus: numeric(tableValue(core, '8', index)),
      }
    })
}

function message(error: unknown, access: SnmpAccess): string {
  const detail = error instanceof Error ? error.message : 'Unknown SNMP error'
  const secrets =
    access.version === '2c'
      ? [access.community]
      : [access.authPassword, access.privacyPassword].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
  return secrets
    .reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), detail)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300)
}

async function withSession<T>(
  target: SnmpTarget,
  signal: AbortSignal | undefined,
  operation: (session: snmp.Session) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new Error('SNMP operation was cancelled')
  const session = createSession(target)
  const abort = () => session.cancelRequests(new Error('SNMP operation was cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await operation(session)
  } finally {
    signal?.removeEventListener('abort', abort)
    session.close()
  }
}

export async function testSnmpConnection(
  target: SnmpTarget,
  signal?: AbortSignal,
): Promise<InventorySystem> {
  return withSession(target, signal, readSystem)
}

export async function inventorySnmp(
  target: SnmpTarget,
  options: { collectInterfaces: boolean },
  signal?: AbortSignal,
): Promise<SnmpProbeResult> {
  return withSession(target, signal, async (session) => {
    const system = await readSystem(session)
    if (!options.collectInterfaces) return { system, interfaces: [], partial: false, errors: [] }
    try {
      const interfaces = await readInterfaces(session)
      return { system, interfaces, partial: false, errors: [] }
    } catch (error) {
      return { system, interfaces: [], partial: true, errors: [message(error, target.access)] }
    }
  })
}
