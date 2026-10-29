import { describe, expect, it } from 'vitest'
import { RETURN_DISPOSITION_FILTERS, ReturnListQuerySchema, returnReasonLabel } from './returns.js'
import {
  bucketStart,
  bucketsOf,
  chooseBucket,
  daysSince,
  dispositionCodesOf,
  normalizeReason,
  returnDispositionView,
  returnRate,
  returnReceiptState,
  returnReimbursementView,
  trendOf,
} from './returns-math.js'

describe('处置状态', () => {
  it('官方 8 个值归并到分组；原值保留；大小写不敏感', () => {
    expect(returnDispositionView('SELLABLE')).toMatchObject({ group: 'SELLABLE', label: '可售', sellable: true, raw: 'SELLABLE' })
    expect(returnDispositionView('customer_damaged')).toMatchObject({ group: 'DAMAGED', sellable: false, raw: 'customer_damaged' })
    expect(returnDispositionView('DISTRIBUTOR_DAMAGED').group).toBe('DAMAGED')
    expect(returnDispositionView('CARRIER_DAMAGED').group).toBe('CARRIER_DAMAGED')
    expect(returnDispositionView('WAREHOUSE_DAMAGED').group).toBe('WAREHOUSE_DAMAGED')
    expect(returnDispositionView('DEFECTIVE').group).toBe('DEFECTIVE')
    expect(returnDispositionView('EXPIRED').group).toBe('EXPIRED')
  })

  it('官方新增的值归“其他”并保留原值，不猜是否可售', () => {
    expect(returnDispositionView('SOMETHING_NEW')).toMatchObject({ group: 'OTHER', sellable: null, raw: 'SOMETHING_NEW' })
  })

  it('没有处置：处置未知（不是可售也不是损坏）；详细处置为空时回退到旧导入器写的值', () => {
    expect(returnDispositionView(null)).toEqual({ group: 'UNKNOWN', label: '处置未知', sellable: null, raw: null })
    expect(returnDispositionView('  ', null).group).toBe('UNKNOWN')
    expect(returnDispositionView(null, 'DEFECTIVE').group).toBe('DEFECTIVE')
    expect(returnDispositionView('SELLABLE', 'DAMAGED').group).toBe('SELLABLE')
  })

  it('分组对应的原值（用来筛选）；每个可筛选分组都至少有一个原值', () => {
    expect(dispositionCodesOf('DAMAGED').sort()).toEqual(['CUSTOMER_DAMAGED', 'DAMAGED', 'DISTRIBUTOR_DAMAGED'])
    for (const group of RETURN_DISPOSITION_FILTERS) expect(dispositionCodesOf(group).length).toBeGreaterThan(0)
    expect(dispositionCodesOf('UNKNOWN')).toEqual([])
  })
})

describe('退货原因', () => {
  it('已登记的代码显示中文，未登记的原样显示，没有原因为空', () => {
    expect(returnReasonLabel('DEFECTIVE')).toBe('商品有缺陷')
    expect(returnReasonLabel('defective')).toBe('商品有缺陷')
    expect(returnReasonLabel('BRAND_NEW_CODE')).toBe('BRAND_NEW_CODE')
    expect(returnReasonLabel(null)).toBeNull()
    expect(returnReasonLabel('')).toBeNull()
  })

  it('归并键：空原因统一为 UNSPECIFIED', () => {
    expect(normalizeReason(null)).toBe('UNSPECIFIED')
    expect(normalizeReason('  ')).toBe('UNSPECIFIED')
    expect(normalizeReason(' DEFECTIVE ')).toBe('DEFECTIVE')
  })
})

describe('退款后是否收到退货', () => {
  const returnDate = '2026-10-18T10:00:00.000Z'
  it('没有财务交易：待财务交易（不是无退款）', () => {
    expect(returnReceiptState({ state: 'PENDING_DATA' }, null, returnDate).state).toBe('PENDING_DATA')
  })
  it('有交易但没有退款：无退款', () => {
    expect(returnReceiptState({ state: 'NONE' }, null, returnDate).state).toBe('NO_REFUND')
    expect(returnReceiptState({ state: 'FULL' }, null, returnDate).state).toBe('NO_REFUND')
  })
  it('退款在先：退款后已收到；收到在先：收到退货后退款；同一时刻算退款在先', () => {
    expect(returnReceiptState({ state: 'FULL' }, '2026-10-17T00:00:00.000Z', returnDate)).toEqual({ state: 'RECEIVED_AFTER_REFUND', label: '退款后已收到退货' })
    expect(returnReceiptState({ state: 'PARTIAL' }, new Date('2026-10-19T00:00:00.000Z'), returnDate).state).toBe('REFUNDED_AFTER_RECEIPT')
    expect(returnReceiptState({ state: 'FULL' }, returnDate, new Date(returnDate)).state).toBe('RECEIVED_AFTER_REFUND')
  })
})

describe('赔付状态', () => {
  it('默认尚未核查；报告写明已赔付优先；有案件是已建案件；其他值是处理中', () => {
    expect(returnReimbursementView({ reimbursementStatus: 'NOT_REVIEWED', reportStatus: null, reimbursementCaseId: null })).toEqual({ state: 'NOT_REVIEWED', label: '尚未核查', caseId: null })
    expect(returnReimbursementView({ reimbursementStatus: null, reportStatus: 'Unit returned to inventory', reimbursementCaseId: null }).state).toBe('NOT_REVIEWED')
    expect(returnReimbursementView({ reimbursementStatus: null, reportStatus: 'Reimbursed', reimbursementCaseId: 'c1' }).state).toBe('AMAZON_REIMBURSED')
    expect(returnReimbursementView({ reimbursementStatus: 'NOT_REVIEWED', reportStatus: null, reimbursementCaseId: 'c1' })).toMatchObject({ state: 'CASE_LINKED', caseId: 'c1' })
    expect(returnReimbursementView({ reimbursementStatus: 'FILED', reportStatus: null, reimbursementCaseId: null }).state).toBe('OTHER')
  })
})

describe('退货率', () => {
  it('销售件数没有或为 0：null，不是 0', () => {
    expect(returnRate(5, null)).toBeNull()
    expect(returnRate(5, undefined)).toBeNull()
    expect(returnRate(5, 0)).toBeNull()
    expect(returnRate(0, 100)).toBe(0)
    expect(returnRate(1, 3)).toBe(0.3333)
    expect(returnRate(5, 100)).toBe(0.05)
  })
})

describe('时间分桶与趋势', () => {
  it('不超过 120 天按周，更长按月', () => {
    expect(chooseBucket('2026-07-25', '2026-10-23')).toBe('WEEK')
    expect(chooseBucket('2026-01-01', '2026-04-30')).toBe('WEEK')
    expect(chooseBucket('2026-01-01', '2026-05-01')).toBe('MONTH')
  })

  it('周桶起始日是周一，月桶是 1 日', () => {
    expect(bucketStart('2026-10-23', 'WEEK')).toBe('2026-10-19')
    expect(bucketStart('2026-10-19', 'WEEK')).toBe('2026-10-19')
    expect(bucketStart('2026-10-25', 'WEEK')).toBe('2026-10-19')
    expect(bucketStart('2026-10-23', 'MONTH')).toBe('2026-10-01')
  })

  it('范围内每个桶都出现（含没有数据的周）', () => {
    expect(bucketsOf('2026-10-05', '2026-10-23', 'WEEK')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19'])
    expect(bucketsOf('2026-08-15', '2026-10-23', 'MONTH')).toEqual(['2026-08-01', '2026-09-01', '2026-10-01'])
  })

  it('趋势：有销售汇总才有退货率；某桶没有销售行时销售件数为 null；完全没有汇总全部为 null', () => {
    const returnedByDay = new Map([
      ['2026-10-06', 2],
      ['2026-10-08', 3],
      ['2026-10-14', 4],
    ])
    const soldByDay = new Map([
      ['2026-10-05', 40],
      ['2026-10-09', 60],
    ])
    const points = trendOf({ from: '2026-10-05', to: '2026-10-19', bucket: 'WEEK', returnedByDay, soldByDay })
    expect(points).toEqual([
      { bucket: '2026-10-05', returnedUnits: 5, soldUnits: 100, rate: 0.05 },
      { bucket: '2026-10-12', returnedUnits: 4, soldUnits: null, rate: null },
      { bucket: '2026-10-19', returnedUnits: 0, soldUnits: null, rate: null },
    ])
    const none = trendOf({ from: '2026-10-05', to: '2026-10-19', bucket: 'WEEK', returnedByDay, soldByDay: null })
    expect(none.every(point => point.soldUnits === null && point.rate === null)).toBe(true)
    expect(none[0].returnedUnits).toBe(5)
  })
})

describe('退款至今的天数', () => {
  it('整天数，不足一天为 0，未来时间不为负', () => {
    const now = new Date('2026-10-23T12:00:00.000Z')
    expect(daysSince('2026-10-22T13:00:00.000Z', now)).toBe(0)
    expect(daysSince('2026-10-21T12:00:00.000Z', now)).toBe(2)
    expect(daysSince('2026-10-25T00:00:00.000Z', now)).toBe(0)
  })
})

describe('列表请求参数', () => {
  it('只允许按退货日期排序；处置只接受分组；退款为布尔', () => {
    expect(ReturnListQuerySchema.safeParse({ sort: 'returnDate:asc', disposition: 'SELLABLE', refunded: 'true' }).success).toBe(true)
    expect(ReturnListQuerySchema.safeParse({ disposition: 'UNKNOWN' }).success).toBe(false)
    expect(ReturnListQuerySchema.safeParse({ sort: 'quantity:asc' }).success).toBe(false)
  })
})
