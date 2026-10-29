import { describe, expect, it } from 'vitest'
import {
  SUPPORT_ROLE_GUIDE,
  SUPPORT_ROLE_PENDING,
  SupportCaseListQuerySchema,
  freshnessStatusForFailure,
  shipmentRefsOfSubject,
  supportChannelLabel,
  supportListState,
  supportStatusLabel,
  type SupportSync,
} from './index.js'

// 支持案件契约（P2b-04）：标签、列表查询、主题里的货件编号、列表整体状态、受限角色未获批的新鲜度状态。

const sync = (over: Partial<SupportSync> = {}): SupportSync => ({
  status: 'NORMAL',
  statusLabel: '正常',
  lastSuccessAt: '2026-10-23T00:00:00.000Z',
  errorCode: null,
  errorMessage: null,
  rolePending: false,
  ...over,
})

describe('标签', () => {
  it('已知状态给中文，亚马逊新增的状态显示原值', () => {
    expect(supportStatusLabel('PENDING_MERCHANT_ACTION')).toBe('等待卖家处理')
    expect(supportStatusLabel('SOMETHING_NEW')).toBe('其他状态（SOMETHING_NEW）')
    expect(supportChannelLabel('PHONE')).toBe('电话')
    expect(supportChannelLabel('SMS')).toBe('SMS')
  })
})

describe('列表查询', () => {
  it('默认按最近更新新到旧，支持按创建时间排序和状态筛选；非法状态与排序字段被拒绝', () => {
    expect(SupportCaseListQuerySchema.parse({}).sort).toEqual({ field: 'amazonUpdatedAt', dir: 'desc' })
    expect(SupportCaseListQuerySchema.parse({ sort: 'amazonCreatedAt:asc', status: 'RESOLVED' })).toMatchObject({ status: 'RESOLVED' })
    expect(() => SupportCaseListQuerySchema.parse({ status: 'WHATEVER' })).toThrow()
    expect(() => SupportCaseListQuerySchema.parse({ sort: 'subject:asc' })).toThrow()
  })
})

describe('主题里的货件编号', () => {
  it('取 FBA 开头的编号，去重、转大写、最多 5 个；不是货件编号的不取', () => {
    expect(shipmentRefsOfSubject('货件 fba15abcde 少收，同 FBA15ABCDE 以及 FBA16ZZZZZ1')).toEqual(['FBA15ABCDE', 'FBA16ZZZZZ1'])
    expect(shipmentRefsOfSubject('FBAB 太短，FBAFOOTBALLCLUB1234567 太长，没有货件')).toEqual([])
    expect(shipmentRefsOfSubject('FBA1AAAAAA FBA2AAAAAA FBA3AAAAAA FBA4AAAAAA FBA5AAAAAA FBA6AAAAAA')).toHaveLength(5)
  })
})

describe('列表整体状态', () => {
  it('有行就是 OK；没行时按同步状态区分，不把“没同步”说成“没有案件”', () => {
    expect(supportListState(sync(), true)).toEqual({ state: 'OK', note: null })
    expect(supportListState(sync(), false).state).toBe('NO_DATA')
    expect(supportListState(sync(), false).note).toContain('尚无记录')
    expect(supportListState(sync({ status: 'NO_RECORD', lastSuccessAt: null }), false).state).toBe('NOT_CONNECTED')
    expect(supportListState(sync({ status: 'UNAUTHORIZED', rolePending: true, errorCode: SUPPORT_ROLE_PENDING }), false)).toEqual({ state: 'ROLE_PENDING', note: SUPPORT_ROLE_GUIDE })
    expect(supportListState(sync({ status: 'FAILED', errorMessage: '同步失败' }), false)).toEqual({ state: 'NOT_CONNECTED', note: '同步失败' })
  })

  it('受限角色未获批算“未授权”，不是“失败”', () => {
    expect(freshnessStatusForFailure(SUPPORT_ROLE_PENDING)).toBe('UNAUTHORIZED')
  })
})
