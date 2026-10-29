import { describe, expect, it } from 'vitest'
import { LISTING_ANOMALY_INFO, LISTING_ANOMALY_KINDS, LISTING_LIVE_ANOMALIES, LISTING_PENDING_COLUMNS, LISTING_PERF_SORTS, type ListingPerfRow } from './listing-performance.js'
import { compareLines, compareListingRows, isConversionDrop, isListingSort, listingConversion, listingDaysOfSupply, listingReturnRate } from './listing-performance-math.js'
import { ListingPerfQuerySchema } from './listing-performance-query.js'

const row = (patch: Partial<ListingPerfRow> = {}): ListingPerfRow => ({
  id: 'a',
  sellerAccountId: 's1',
  storeName: '店铺',
  asin: 'B0AAAAAAAA',
  sku: 'SKU-A',
  title: '商品',
  imageUrl: null,
  brand: null,
  listingStatus: 'ACTIVE',
  fulfillmentChannel: 'AFN',
  price: 10,
  currency: 'USD',
  sessions: 1000,
  pageViews: 1500,
  units: 100,
  sales: 1000,
  conversion: 0.1,
  buyBox: 0.9,
  sessionsPrev: 900,
  conversionPrev: 0.1,
  adsSales: null,
  returnRate: null,
  daysOfSupply: null,
  salesShared: false,
  anomalies: [],
  ownerUserId: null,
  ownerName: null,
  updatedAt: '2026-10-20T00:00:00Z',
  ...patch,
})

describe('刊登表现：比率与异常', () => {
  it('转化率 = 件数 ÷ 会话；缺一边或会话为 0 是 null，不是 0', () => {
    expect(listingConversion(5, 50)).toBe(0.1)
    expect(listingConversion(null, 50)).toBeNull()
    expect(listingConversion(5, null)).toBeNull()
    expect(listingConversion(5, 0)).toBeNull()
    expect(listingConversion(0, 50)).toBe(0)
  })

  it('转化率骤降：下降达到 30%（相对）且两期会话都不少于 100 才算', () => {
    expect(isConversionDrop({ sessions: 200, conversion: 0.07 }, { sessions: 200, conversion: 0.1 })).toBe(true)
    expect(isConversionDrop({ sessions: 200, conversion: 0.071 }, { sessions: 200, conversion: 0.1 })).toBe(false)
    // 恰好 30% 算（边界）
    expect(isConversionDrop({ sessions: 100, conversion: 0.07 }, { sessions: 100, conversion: 0.1 })).toBe(true)
  })

  it('样本不足、缺数据、上一周期转化率为 0：一律不报，不猜', () => {
    expect(isConversionDrop({ sessions: 99, conversion: 0.01 }, { sessions: 500, conversion: 0.1 })).toBe(false)
    expect(isConversionDrop({ sessions: 500, conversion: 0.01 }, { sessions: 99, conversion: 0.1 })).toBe(false)
    expect(isConversionDrop({ sessions: null, conversion: null }, { sessions: 500, conversion: 0.1 })).toBe(false)
    expect(isConversionDrop({ sessions: 500, conversion: 0.01 }, { sessions: 500, conversion: null })).toBe(false)
    expect(isConversionDrop({ sessions: 500, conversion: 0 }, { sessions: 500, conversion: 0 })).toBe(false)
    // 上升不算
    expect(isConversionDrop({ sessions: 500, conversion: 0.2 }, { sessions: 500, conversion: 0.1 })).toBe(false)
  })

  it('可售天数与退货率：分母缺失或不为正是 null', () => {
    expect(listingDaysOfSupply(100, 70, 7)).toBe(10)
    expect(listingDaysOfSupply(100, 0, 7)).toBeNull()
    expect(listingDaysOfSupply(null, 70, 7)).toBeNull()
    expect(listingDaysOfSupply(0, 70, 7)).toBe(0)
    expect(listingReturnRate(5, 100)).toBe(0.05)
    expect(listingReturnRate(0, 100)).toBe(0)
    expect(listingReturnRate(5, 0)).toBeNull()
    expect(listingReturnRate(null, 100)).toBeNull()
  })

  it('四类异常都登记了；现在只有转化率骤降算得出来，其余三类写明负责的工作包', () => {
    expect([...LISTING_ANOMALY_KINDS]).toEqual(['CONVERSION_DROP', 'OFFER_LOST', 'ISSUE_NEW', 'SUPPRESSED'])
    expect([...LISTING_LIVE_ANOMALIES]).toEqual(['CONVERSION_DROP'])
    expect(LISTING_ANOMALY_INFO.CONVERSION_DROP.pendingWorkPackage).toBeNull()
    expect(LISTING_ANOMALY_INFO.CONVERSION_DROP.basis).toContain('30%')
    expect(LISTING_ANOMALY_INFO.OFFER_LOST.pendingWorkPackage).toBe('P4-11')
    expect(LISTING_ANOMALY_INFO.ISSUE_NEW.pendingWorkPackage).toBe('P4-10')
    expect(LISTING_ANOMALY_INFO.SUPPRESSED.pendingWorkPackage).toBe('P4-10')
  })

  it('没有来源的四列：评分、评分数、刊登问题数、质量分', () => {
    expect(LISTING_PENDING_COLUMNS.map(item => item.key)).toEqual(['rating', 'ratingCount', 'issueCount', 'qualityScore'])
    expect(LISTING_PENDING_COLUMNS.every(item => item.workPackage.startsWith('P4-'))).toBe(true)
  })
})

describe('刊登表现：排序与对比', () => {
  it('排序字段白名单；数值列没有值的永远在最后，升降序都一样', () => {
    expect(isListingSort('sales')).toBe(true)
    expect(isListingSort('password')).toBe(false)
    const rows = [row({ id: 'a', sales: 10 }), row({ id: 'b', sales: null }), row({ id: 'c', sales: 30 })]
    const sorted = (dir: 'asc' | 'desc') => [...rows].sort((x, y) => compareListingRows(x, y, 'sales', dir)).map(item => item.id)
    expect(sorted('desc')).toEqual(['c', 'a', 'b'])
    expect(sorted('asc')).toEqual(['a', 'c', 'b'])
  })

  it('并列按编号稳定；文本列按码点', () => {
    const rows = [row({ id: 'b', sales: 5, asin: 'B0B' }), row({ id: 'a', sales: 5, asin: 'B0C' })]
    expect(rows.sort((x, y) => compareListingRows(x, y, 'sales', 'desc')).map(item => item.id)).toEqual(['a', 'b'])
    expect(rows.sort((x, y) => compareListingRows(x, y, 'asin', 'asc')).map(item => item.id)).toEqual(['b', 'a'])
  })

  it('每个排序字段都有取值方式（不会因白名单多出一项而悄悄不排序）', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })]
    for (const field of LISTING_PERF_SORTS) expect(() => rows.sort((x, y) => compareListingRows(x, y, field, 'asc'))).not.toThrow()
  })

  it('对比表：逐个对象列出，较优只在至少两个对象有值且不全相等时标出；退货率越低越好；价格与可售天数不判优劣', () => {
    const lines = compareLines([
      row({ id: 'a', sales: 100, returnRate: 0.1, price: 5, daysOfSupply: 10 }),
      row({ id: 'b', sales: 300, returnRate: 0.02, price: 9, daysOfSupply: 20 }),
      row({ id: 'c', sales: null, returnRate: null }),
    ])
    const by = (key: string) => lines.find(line => line.key === key)!
    expect(by('sales')).toMatchObject({ values: [100, 300, null], bestIndex: 1, kind: 'money' })
    expect(by('returnRate').bestIndex).toBe(1)
    expect(by('price').bestIndex).toBeNull()
    expect(by('daysOfSupply').bestIndex).toBeNull()
    // 只有一个对象有值：不标较优
    expect(compareLines([row({ id: 'a', adsSales: 5 }), row({ id: 'b', adsSales: null })]).find(line => line.key === 'adsSales')!.bestIndex).toBeNull()
    // 全部相等：不标
    expect(compareLines([row({ id: 'a' }), row({ id: 'b' })]).find(line => line.key === 'sessions')!.bestIndex).toBeNull()
  })
})

describe('刊登表现：请求校验', () => {
  it('默认按销售额从高到低；排序字段不在白名单、配送方式或异常类型不认识都不通过', () => {
    expect(ListingPerfQuerySchema.parse({}).sort).toEqual({ field: 'sales', dir: 'desc' })
    expect(ListingPerfQuerySchema.safeParse({ sort: 'password:asc' }).success).toBe(false)
    expect(ListingPerfQuerySchema.safeParse({ fulfillment: 'OTHER' }).success).toBe(false)
    expect(ListingPerfQuerySchema.safeParse({ anomaly: 'OFFER_LOST' }).success).toBe(false)
    expect(ListingPerfQuerySchema.safeParse({ anomaly: 'CONVERSION_DROP', brand: 'Acme', sort: 'conversion:asc', pageSize: '100' }).success).toBe(true)
  })

  it('没有“有刊登问题”“质量分”筛选：带了就是 422（未知参数一律拒绝）', () => {
    expect(ListingPerfQuerySchema.safeParse({ hasIssues: 'true' }).success).toBe(false)
    expect(ListingPerfQuerySchema.safeParse({ qualityMin: '60' }).success).toBe(false)
  })

  it('范围参数照常校验：只给开始日期不行', () => {
    expect(ListingPerfQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false)
    expect(ListingPerfQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-07' }).success).toBe(true)
  })
})
