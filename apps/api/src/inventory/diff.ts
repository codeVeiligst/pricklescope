import type { InventoryDiff, InventoryInterface, InventorySystem } from '@pricklescope/contracts'

const systemFields = [
  'name',
  'description',
  'objectId',
  'location',
  'contact',
  'uptimeTicks',
] as const
const interfaceFields = [
  'name',
  'description',
  'alias',
  'type',
  'mtu',
  'speedBps',
  'macAddress',
  'adminStatus',
  'operStatus',
] as const

export function diffInventory(
  current: { system: InventorySystem; interfaces: InventoryInterface[] },
  previous: { system: InventorySystem; interfaces: InventoryInterface[] } | null,
): InventoryDiff {
  const previousInterfaces = new Map(previous?.interfaces.map((item) => [item.index, item]) ?? [])
  const currentInterfaces = new Map(current.interfaces.map((item) => [item.index, item]))
  const systemChanges = systemFields
    .filter((field) => !previous || previous.system[field] !== current.system[field])
    .map((field) => ({
      field,
      before: previous?.system[field] ?? null,
      after: current.system[field],
    }))
  const addedInterfaces = current.interfaces.filter((item) => !previousInterfaces.has(item.index))
  const removedInterfaces =
    previous?.interfaces.filter((item) => !currentInterfaces.has(item.index)) ?? []
  const changedInterfaces = current.interfaces.flatMap((item) => {
    const before = previousInterfaces.get(item.index)
    if (!before) return []
    const changes = interfaceFields
      .filter((field) => before[field] !== item[field])
      .map((field) => ({ field, before: before[field], after: item[field] }))
    return changes.length ? [{ index: item.index, name: item.name, changes }] : []
  })
  return {
    firstSnapshot: previous === null,
    systemChanges,
    addedInterfaces,
    removedInterfaces,
    changedInterfaces,
  }
}
