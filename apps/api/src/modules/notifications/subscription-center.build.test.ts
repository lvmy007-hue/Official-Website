import { NOTIFICATION_TYPES } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { buildSubscriptionCenter, maskTail, type SubscriptionCenterInput } from './subscription-center.build'

const input = (over: Partial<SubscriptionCenterInput> = {}): SubscriptionCenterInput => ({
  destinationId: 'dest-0001',
  canManage: true,
  stores: [{ id: 's1', displayName: '主店' }],
  authorizedStoreIds: new Set(['s1']),
  rows: [],
  events: [],
  truncated: false,
  ...over,
})
const find = (data: ReturnType<typeof buildSubscriptionCenter>, type: string, store = 's1') => data.items.find(entry => entry.sellerAccountId === store && entry.notificationType === type)!

describe('订阅页装配', () => {
  it('接收端编号只露末 4 位，过短的全部遮住', () => {
    expect(maskTail('arn:aws:sqs:queue-9876')).toBe('****9876')
    expect(maskTail('abc')).toBe('****')
  })

  it('每个店铺每种类型一行，店铺排在前、类型顺序同目录', () => {
    const data = buildSubscriptionCenter(
      input({
        stores: [
          { id: 's1', displayName: '主店' },
          { id: 's2', displayName: '二店' },
        ],
      }),
    )
    expect(data.items).toHaveLength(2 * NOTIFICATION_TYPES.length)
    expect(data.items.slice(0, NOTIFICATION_TYPES.length).map(entry => entry.notificationType)).toEqual(NOTIFICATION_TYPES.map(entry => entry.type))
    expect(data.items[NOTIFICATION_TYPES.length]?.sellerAccountId).toBe('s2')
  })

  it('事件数与失败数按店铺与类型累计；没有店铺归属的事件不计入', () => {
    const data = buildSubscriptionCenter(
      input({
        events: [
          { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE', status: 'PROCESSED', count: 5 },
          { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE', status: 'FAILED', count: 2 },
          { sellerAccountId: 's1', notificationType: 'ORDER_CHANGE', status: 'RECEIVED', count: 1 },
          { sellerAccountId: null, notificationType: 'ORDER_CHANGE', status: 'FAILED', count: 9 },
        ],
      }),
    )
    expect(find(data, 'ORDER_CHANGE')).toMatchObject({ events24h: 8, failures24h: 2 })
    expect(find(data, 'TRANSACTION_UPDATE')).toMatchObject({ events24h: 0, failures24h: 0 })
  })

  it('同店铺同类型有两个接收端的记录时，优先显示当前接收端的', () => {
    const row = (id: string, destinationId: string) => ({
      id,
      sellerAccountId: 's1',
      destinationId,
      notificationType: 'ORDER_CHANGE',
      status: 'ACTIVE',
      filterJson: null,
      lastReceivedAt: null,
      version: 1,
    })
    const data = buildSubscriptionCenter(input({ rows: [row('now', 'dest-0001'), row('old', 'dest-0000')] }))
    expect(find(data, 'ORDER_CHANGE').id).toBe('now')
    const reversed = buildSubscriptionCenter(input({ rows: [row('old', 'dest-0000'), row('now', 'dest-0001')] }))
    expect(find(reversed, 'ORDER_CHANGE').id).toBe('now')
  })

  it('过滤条件：只取站点与聚合周期，其余字段与空值丢掉', () => {
    const row = (filterJson: unknown) => ({
      id: 'x',
      sellerAccountId: 's1',
      destinationId: 'dest-0001',
      notificationType: 'ANY_OFFER_CHANGED',
      status: 'ACTIVE',
      filterJson,
      lastReceivedAt: null,
      version: 2,
    })
    expect(find(buildSubscriptionCenter(input({ rows: [row({ marketplaceIds: ['ATVPDKIKX0DER'], aggregationTimePeriod: 'FiveMinutes', secret: 'x' })] })), 'ANY_OFFER_CHANGED').filter).toEqual({
      marketplaceIds: ['ATVPDKIKX0DER'],
      aggregationTimePeriod: 'FiveMinutes',
    })
    expect(find(buildSubscriptionCenter(input({ rows: [row({})] })), 'ANY_OFFER_CHANGED').filter).toBeNull()
    expect(find(buildSubscriptionCenter(input({ rows: [row([1])] })), 'ANY_OFFER_CHANGED').filter).toBeNull()
  })

  it('接收端未配置：受影响的页面列出，已配置则为空；没有店铺授权时标出', () => {
    const missing = buildSubscriptionCenter(input({ destinationId: null, authorizedStoreIds: new Set() }))
    expect(missing.destination).toMatchObject({ configured: false, hint: null })
    expect(missing.affectedPages.length).toBeGreaterThan(5)
    expect(missing.affectedPages.map(item => item.page)).toContain('今日广告') // 依赖营销数据流，本页不管理但同样退化
    expect(missing.affectedPages.map(item => item.page)).toContain('今日实时')
    expect(missing.stores).toEqual([{ id: 's1', displayName: '主店', authorized: false }])
    expect(buildSubscriptionCenter(input()).affectedPages).toEqual([])
  })

  it('截断标记原样带出；没有任何店铺时没有行', () => {
    const data = buildSubscriptionCenter(input({ stores: [], truncated: true }))
    expect(data.items).toEqual([])
    expect(data.truncated).toBe(true)
    expect(data.summary.rows).toBe(0)
  })
})
