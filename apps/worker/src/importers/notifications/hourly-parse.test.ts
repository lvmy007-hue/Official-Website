import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NtfSchemaError, parseItemInventoryEvent, parseItemSalesEvent, parsePageTrafficEvent } from './hourly-parse'

const FIX = join(__dirname, '../../../fixtures/amazon-notifications')
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as unknown

describe('小时推送解析器（官方样例）', () => {
  it('ITEM_SALES_EVENT_CHANGE：解析件数与销售额，同小时内事件不算延迟', () => {
    const rows = parseItemSalesEvent(load('item-sales-event-change.json'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      asin: 'B00032HE0O',
      units: 9,
      salesAmount: 80.91,
      currency: 'USD',
      marketplaceId: 'ATVPDKIKX0DER',
      isLateArrival: false,
    })
    expect(rows[0].hourStart.toISOString()).toBe('2023-02-07T15:00:00.000Z')
  })

  it('DETAIL_PAGE_TRAFFIC_EVENT：glanceViews → pageViews', () => {
    const rows = parsePageTrafficEvent(load('detail-page-traffic-event.json'))
    expect(rows.map(r => [r.asin, r.pageViews])).toEqual([
      ['B00032HE0O', 42],
      ['B00094A20U', 69],
    ])
  })

  it('ITEM_INVENTORY_EVENT_CHANGE：highlyAvailableInventory → availableQty', () => {
    const rows = parseItemInventoryEvent(load('item-inventory-event-change.json'))
    expect(rows.map(r => [r.asin, r.availableQty])).toEqual([
      ['B00032HE0O', 650],
      ['B00094A20U', 519],
    ])
  })

  it('非美国站行被丢弃；结构错误抛 NTF_SCHEMA', () => {
    const sales = load('item-sales-event-change.json') as { payload: { itemSalesEventChanges: Array<Record<string, unknown>> } }
    sales.payload.itemSalesEventChanges[0].marketplaceId = 'A1F83G8C2ARO7P'
    expect(parseItemSalesEvent(sales)).toHaveLength(1)
    expect(() => parseItemSalesEvent({ notificationType: 'ORDER_CHANGE', eventTime: '2023-01-01T00:00:00Z', payload: {} })).toThrow(NtfSchemaError)
    expect(() => parseItemSalesEvent({ notificationType: 'ITEM_SALES_EVENT_CHANGE', eventTime: 'x', payload: { itemSalesEventChanges: [] } })).toThrow(NtfSchemaError)
  })

  it('事件时间远晚于小时结束：标记延迟补发', () => {
    const raw = load('item-sales-event-change.json') as { eventTime: string }
    raw.eventTime = '2023-02-08T10:00:00Z'
    expect(parseItemSalesEvent(raw)[0].isLateArrival).toBe(true)
  })
})
