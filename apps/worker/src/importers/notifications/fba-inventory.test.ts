import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createFbaInventoryProcessor, parseFbaInventoryChanges } from './fba-inventory'

const raw = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/amazon-notifications/fba-inventory-availability-changes.json'), 'utf8')) as Record<string, unknown>
const wrap = (change: unknown, type = 'FBA_INVENTORY_AVAILABILITY_CHANGES') => ({ ...raw, notificationType: type, payload: { fbaInventoryAvailabilityChanges: change } })

describe('FBA_INVENTORY_AVAILABILITY_CHANGES 解析', () => {
  it('按站点数组取美国站可售数量，其他站点跳过', () => {
    const rows = parseFbaInventoryChanges(raw)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ accountId: 'A21CXK3C4ERTY8', sku: 'NOVA-SKU-001', fnsku: 'X001ABCDEF', asin: 'B00032HE0O', marketplaceId: 'ATVPDKIKX0DER', sellable: 120 })
    expect(rows[0].sourceUpdatedAt.toISOString()).toBe('2026-10-22T09:30:00.000Z')
  })

  it('行内直接带数量与站点的形态也能解析；数组形态的多行都解析', () => {
    const rows = parseFbaInventoryChanges(
      wrap([
        { sellerId: 'S', sellerSku: 'A', fnSku: 'F1', marketplaceId: 'ATVPDKIKX0DER', fulfillableQuantity: 5 },
        { sellerId: 'S', sku: 'B', marketplaceId: 'ATVPDKIKX0DER', availableQuantity: 0 },
      ]),
    )
    expect(rows.map(row => [row.sku, row.sellable])).toEqual([
      ['A', 5],
      ['B', 0],
    ])
  })

  it('没有数量的行、非美国站的行不写（没报的不当 0）', () => {
    expect(parseFbaInventoryChanges(wrap({ sellerId: 'S', sku: 'A', marketplaceId: 'ATVPDKIKX0DER' }))).toEqual([])
    expect(parseFbaInventoryChanges(wrap({ sellerId: 'S', sku: 'A', marketplaceId: 'A1F83G8C2ARO7P', fulfillableQuantity: 9 }))).toEqual([])
    expect(parseFbaInventoryChanges(wrap({ sellerId: 'S', sku: 'A', marketplaceId: 'ATVPDKIKX0DER', fulfillableQuantity: -1 }))).toEqual([])
  })

  it('结构不对抛 NTF_SCHEMA', () => {
    expect(() => parseFbaInventoryChanges(null)).toThrow('通知根对象')
    expect(() => parseFbaInventoryChanges(wrap({}, 'ITEM_INVENTORY_EVENT_CHANGE'))).toThrow('期望 FBA_INVENTORY_AVAILABILITY_CHANGES')
    expect(() => parseFbaInventoryChanges({ ...raw, eventTime: 'x' })).toThrow('eventTime')
    expect(() => parseFbaInventoryChanges({ ...raw, payload: {} })).toThrow('fbaInventoryAvailabilityChanges')
    expect(() => parseFbaInventoryChanges(wrap({ sku: 'A' }))).toThrow('sellerId')
  })
})

describe('库存变化推送写入', () => {
  const event = { id: 'e1', tenantId: 't1', sellerAccountId: 's1', notificationType: 'FBA_INVENTORY_AVAILABILITY_CHANGES', payloadObjectKey: 'events/e1.json' }

  function setup(existing: { id: string; sourceUpdatedAt: Date; snapshotDate: Date } | null) {
    const db = {
      tenant: { findFirst: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })) },
      sellerAccount: { findMany: vi.fn() },
      inventoryDailySnapshot: { findUnique: vi.fn(async () => existing), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      dataFreshness: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn(), updateMany: vi.fn() },
    }
    const storage = { openRead: vi.fn(async () => Readable.from([Buffer.from(JSON.stringify(raw))])) }
    return { db, processor: createFbaInventoryProcessor({ db: db as never, storage }) }
  }

  it('当日没有 API 快照：新建，只带可售数量，其他数量不填；记录新鲜度', async () => {
    const { db, processor } = setup(null)
    await processor(event)
    const data = (db.inventoryDailySnapshot.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data
    expect(data).toMatchObject({ tenantId: 't1', sellerAccountId: 's1', sku: 'NOVA-SKU-001', fnsku: 'X001ABCDEF', source: 'API', sellable: 120 })
    expect(data).not.toHaveProperty('reserved')
    expect(db.dataFreshness.create.mock.calls[0][0].data).toMatchObject({ sourceKey: 'ntf.fba-inventory', lastRowCount: 1 })
  })

  it('已有当日快照：较新的推送只更新可售数量；较旧的不覆盖', async () => {
    const snapshotDate = new Date('2026-10-22T00:00:00Z')
    const newer = setup({ id: 'x1', sourceUpdatedAt: new Date('2026-10-22T08:00:00Z'), snapshotDate })
    await newer.processor(event)
    expect(newer.db.inventoryDailySnapshot.update.mock.calls[0][0]).toMatchObject({ where: { id_snapshotDate: { id: 'x1', snapshotDate } }, data: { sellable: 120 } })
    const older = setup({ id: 'x2', sourceUpdatedAt: new Date('2026-10-22T10:00:00Z'), snapshotDate })
    await older.processor(event)
    expect(older.db.inventoryDailySnapshot.update).not.toHaveBeenCalled()
    expect(older.db.inventoryDailySnapshot.create).not.toHaveBeenCalled()
  })
})
