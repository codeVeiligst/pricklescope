import type { InventoryInterface, InventorySystem } from '@pricklescope/contracts'
import { describe, expect, it } from 'vitest'

import { diffInventory } from './diff.js'

const system: InventorySystem = {
  name: 'switch-1',
  description: 'Example switch',
  objectId: '1.3.6.1.4.1.9',
  location: 'Brussels',
  contact: null,
  uptimeTicks: 1234,
}
const ethernet: InventoryInterface = {
  index: 1,
  name: 'Gi0/1',
  description: 'GigabitEthernet0/1',
  alias: 'Uplink',
  type: 6,
  mtu: 1500,
  speedBps: 1_000_000_000,
  macAddress: '00:11:22:33:44:55',
  adminStatus: 1,
  operStatus: 1,
}

describe('inventory diff', () => {
  it('marks the first inventory as additions', () => {
    const diff = diffInventory({ system, interfaces: [ethernet] }, null)
    expect(diff.firstSnapshot).toBe(true)
    expect(diff.addedInterfaces).toEqual([ethernet])
  })

  it('reports changed and removed interfaces', () => {
    const changed = { ...ethernet, alias: 'Core uplink', operStatus: 2 }
    const removed = { ...ethernet, index: 2, name: 'Gi0/2' }
    const diff = diffInventory(
      { system, interfaces: [changed] },
      { system, interfaces: [ethernet, removed] },
    )
    expect(diff.changedInterfaces[0]?.changes.map((item) => item.field)).toEqual([
      'alias',
      'operStatus',
    ])
    expect(diff.removedInterfaces[0]?.index).toBe(2)
  })
})
