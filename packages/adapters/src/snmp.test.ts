import dgram from 'node:dgram'

import * as snmp from 'net-snmp'
import { afterEach, describe, expect, it } from 'vitest'

import { inventorySnmp, testSnmpConnection, type SnmpAccess } from './snmp.js'

interface TestAgent {
  close: (callback?: () => void) => void
}

const agents: TestAgent[] = []

async function availablePort(): Promise<number> {
  const socket = dgram.createSocket('udp4')
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address()
      socket.close(() => resolve(address.port))
    })
  })
}

async function startAgent(access: SnmpAccess): Promise<{ port: number; access: SnmpAccess }> {
  const port = await availablePort()
  const agent = snmp.createAgent(
    {
      port,
      address: '127.0.0.1',
      transport: 'udp4',
      disableAuthorization: false,
      accessControlModelType: snmp.AccessControlModelType.Simple,
    },
    (error: Error | null) => {
      if (error) throw error
    },
  ) as TestAgent & {
    getAuthorizer: () => {
      addCommunity: (community: string) => void
      addUser: (user: snmp.User) => void
    }
    getMib: () => {
      registerProvider: (provider: unknown) => void
      setScalarValue: (name: string, value: unknown) => void
      addTableRow: (name: string, row: unknown[]) => void
    }
    listener: { sockets: Record<string, dgram.Socket> }
  }
  agents.push(agent)
  if (access.version === '2c') {
    agent.getAuthorizer().addCommunity(access.community)
  } else {
    agent.getAuthorizer().addUser({
      name: access.username,
      level: snmp.SecurityLevel[access.securityLevel],
      ...(access.authProtocol ? { authProtocol: snmp.AuthProtocols[access.authProtocol] } : {}),
      ...(access.authPassword ? { authKey: access.authPassword } : {}),
      ...(access.privacyProtocol
        ? { privProtocol: snmp.PrivProtocols[access.privacyProtocol] }
        : {}),
      ...(access.privacyPassword ? { privKey: access.privacyPassword } : {}),
    })
  }

  const mib = agent.getMib()
  const scalars = [
    ['sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, 'PrickleSwitch test agent'],
    ['sysObjectID', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, '1.3.6.1.4.1.8072.3.2.10'],
    ['sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, 123_456],
    ['sysContact', '1.3.6.1.2.1.1.4', snmp.ObjectType.OctetString, 'noc@example.test'],
    ['sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, 'lab-switch-01'],
    ['sysLocation', '1.3.6.1.2.1.1.6', snmp.ObjectType.OctetString, 'Lab rack 7'],
  ] as const
  for (const [name, oid, scalarType, value] of scalars) {
    mib.registerProvider({
      name,
      oid,
      type: snmp.MibProviderType.Scalar,
      scalarType,
      maxAccess: snmp.MaxAccess['read-only'],
    })
    mib.setScalarValue(name, value)
  }
  mib.registerProvider({
    name: 'ifTable',
    oid: '1.3.6.1.2.1.2.2.1',
    type: snmp.MibProviderType.Table,
    maxAccess: snmp.MaxAccess['not-accessible'],
    tableColumns: [
      {
        number: 1,
        name: 'ifIndex',
        type: snmp.ObjectType.Integer,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 2,
        name: 'ifDescr',
        type: snmp.ObjectType.OctetString,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 3,
        name: 'ifType',
        type: snmp.ObjectType.Integer,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 4,
        name: 'ifMtu',
        type: snmp.ObjectType.Integer,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 5,
        name: 'ifSpeed',
        type: snmp.ObjectType.Gauge,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 6,
        name: 'ifPhysAddress',
        type: snmp.ObjectType.OctetString,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 7,
        name: 'ifAdminStatus',
        type: snmp.ObjectType.Integer,
        maxAccess: snmp.MaxAccess['read-only'],
      },
      {
        number: 8,
        name: 'ifOperStatus',
        type: snmp.ObjectType.Integer,
        maxAccess: snmp.MaxAccess['read-only'],
      },
    ],
    tableIndex: [{ columnName: 'ifIndex' }],
  })
  mib.addTableRow('ifTable', [
    1,
    'Ethernet 1',
    6,
    1500,
    1_000_000_000,
    Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]),
    1,
    1,
  ])

  await Promise.all(
    Object.values(agent.listener.sockets).map(
      (socket) =>
        new Promise<void>((resolve, reject) => {
          socket.once('error', reject)
          socket.once('listening', resolve)
        }),
    ),
  )
  return { port, access }
}

afterEach(async () => {
  await Promise.all(
    agents.splice(0).map(
      (agent) =>
        new Promise<void>((resolve) => {
          agent.close(resolve)
        }),
    ),
  )
})

describe('SNMP adapter', () => {
  it.each([
    {
      label: 'v2c',
      access: { version: '2c', community: 'test-public' } satisfies SnmpAccess,
    },
    {
      label: 'v3 authPriv',
      access: {
        version: '3',
        username: 'pricklescope',
        securityLevel: 'authPriv',
        authProtocol: 'sha256',
        authPassword: 'test-auth-passphrase',
        privacyProtocol: 'aes',
        privacyPassword: 'test-private-passphrase',
      } satisfies SnmpAccess,
    },
  ])('discovers system identity and IF-MIB over $label', async ({ access }) => {
    const target = await startAgent(access)
    const system = await testSnmpConnection({
      target: '127.0.0.1',
      port: target.port,
      transport: 'udp4',
      timeoutMs: 1_000,
      retries: 0,
      access: target.access,
    })
    expect(system.name).toBe('lab-switch-01')

    const inventory = await inventorySnmp(
      {
        target: '127.0.0.1',
        port: target.port,
        transport: 'udp4',
        timeoutMs: 1_000,
        retries: 0,
        access: target.access,
      },
      { collectInterfaces: true },
    )
    expect(inventory.partial).toBe(false)
    expect(inventory.system.location).toBe('Lab rack 7')
    expect(inventory.interfaces).toEqual([
      expect.objectContaining({
        index: 1,
        description: 'Ethernet 1',
        mtu: 1500,
        macAddress: '02:00:00:00:00:01',
        operStatus: 1,
      }),
    ])
  })
})
