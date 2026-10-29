import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSalesProcessor } from './hourly-write'

const FIX = join(__dirname, '../../../fixtures/amazon-notifications')
const salesJson = readFileSync(join(FIX, 'item-sales-event-change.json'), 'utf8')

describe('小时销售写入', () => {
  it('首次写入创建行；较旧的补发不覆盖；较新的覆盖', async () => {
    const created: unknown[] = []
    const updated: unknown[] = []
    const store = new Map<string, { id: string; sourceUpdatedAt: Date; hourStart: Date }>()
    const keyOf = (asin: string, hourStart: Date) => `${asin}|${hourStart.toISOString()}`
    const db = {
      sellerAccount: { findMany: vi.fn() },
      hourlySalesEvent: {
        findFirst: vi.fn(async ({ where }: { where: { asin: string; hourStart: Date } }) => store.get(keyOf(where.asin, where.hourStart)) ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data)
          store.set(keyOf(data.asin as string, data.hourStart as Date), {
            id: `h-${created.length}`,
            sourceUpdatedAt: data.sourceUpdatedAt as Date,
            hourStart: data.hourStart as Date,
          })
        }),
        update: vi.fn(async ({ where, data }: { where: { id_hourStart: { id: string; hourStart: Date } }; data: Record<string, unknown> }) => {
          updated.push(data)
          for (const [key, row] of store) {
            if (row.id === where.id_hourStart.id) {
              store.set(key, { ...row, sourceUpdatedAt: data.sourceUpdatedAt as Date })
              break
            }
          }
        }),
      },
      dataFreshness: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn(), updateMany: vi.fn() },
    }
    const storage = { openRead: vi.fn(async () => Readable.from([Buffer.from(salesJson)])) }
    const processor = createSalesProcessor({ db: db as never, storage })
    await processor({
      id: 'e1',
      tenantId: 't1',
      sellerAccountId: 's1',
      notificationType: 'ITEM_SALES_EVENT_CHANGE',
      payloadObjectKey: 'events/e1.json',
    })
    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({ asin: 'B00032HE0O', units: 9, salesAmount: 80.91, orders: 0 })
    expect(db.dataFreshness.create).toHaveBeenCalled()

    // 较旧：不覆盖
    const older = JSON.parse(salesJson) as { eventTime: string; payload: { itemSalesEventChanges: Array<{ orderedUnits: number }> } }
    older.eventTime = '2023-02-07T16:00:00Z'
    older.payload.itemSalesEventChanges[0].orderedUnits = 1
    storage.openRead.mockResolvedValueOnce(Readable.from([Buffer.from(JSON.stringify(older))]))
    await processor({
      id: 'e2',
      tenantId: 't1',
      sellerAccountId: 's1',
      notificationType: 'ITEM_SALES_EVENT_CHANGE',
      payloadObjectKey: 'events/e2.json',
    })
    expect(updated).toHaveLength(0)

    // 较新：覆盖
    const newer = JSON.parse(salesJson) as { eventTime: string; payload: { itemSalesEventChanges: Array<{ orderedUnits: number }> } }
    newer.eventTime = '2023-02-07T18:00:00Z'
    newer.payload.itemSalesEventChanges[0].orderedUnits = 12
    storage.openRead.mockResolvedValueOnce(Readable.from([Buffer.from(JSON.stringify(newer))]))
    await processor({
      id: 'e3',
      tenantId: 't1',
      sellerAccountId: 's1',
      notificationType: 'ITEM_SALES_EVENT_CHANGE',
      payloadObjectKey: 'events/e3.json',
    })
    expect(updated.length).toBeGreaterThan(0)
    expect(updated.some(row => (row as { units: number }).units === 12)).toBe(true)
  })
})
