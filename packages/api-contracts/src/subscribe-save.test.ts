import { describe, expect, it } from 'vitest'
import {
  SNS_CARD_KEYS,
  SNS_CARD_LABEL,
  SNS_FORECAST_MAX_AGE_DAYS,
  SNS_GATE_REASONS,
  SNS_GATE_LABEL,
  SnsAsinListQuerySchema,
  SnsOfferListQuerySchema,
  snsDayDiff,
  snsEligibilityLabel,
  snsEmptyState,
  snsReplenishmentGate,
  type SnsOfferFacts,
  type SnsSync,
} from './index.js'

const TODAY = '2026-10-24'
const offer = (over: Partial<SnsOfferFacts> = {}): SnsOfferFacts => ({ snapshotDate: '2026-10-23', eligibility: 'ELIGIBLE', forecastNext30: 90, shippedUnitsPrevMonth: 60, prevMonthDays: 30, ...over })
const sync = (over: Partial<SnsSync> = {}): SnsSync => ({ status: 'NORMAL', statusLabel: '正常', lastSuccessAt: null, errorCode: null, errorMessage: null, rolePending: false, ...over })

describe('订阅省契约：常量与标签', () => {
  it('八张指标卡都有中文名；原因都有说明；快照有效期是 7 天', () => {
    for (const key of SNS_CARD_KEYS) expect(SNS_CARD_LABEL[key]).toBeTruthy()
    expect(SNS_CARD_KEYS).toHaveLength(8)
    for (const reason of SNS_GATE_REASONS) expect(SNS_GATE_LABEL[reason]).toBeTruthy()
    expect(SNS_FORECAST_MAX_AGE_DAYS).toBe(7)
  })

  it('可订阅状态：已知值写中文，未知值原样，没有写“未提供”', () => {
    expect(snsEligibilityLabel('ELIGIBLE')).toBe('可订阅')
    expect(snsEligibilityLabel('SUSPENDED')).toBe('已暂停')
    expect(snsEligibilityLabel('NEW_STATE')).toBe('NEW_STATE')
    expect(snsEligibilityLabel(null)).toBe('未提供')
  })

  it('日期相差天数按日历日算', () => {
    expect(snsDayDiff('2026-10-17', '2026-10-24')).toBe(7)
    expect(snsDayDiff('2026-10-24', '2026-10-24')).toBe(0)
    expect(snsDayDiff('2026-02-28', '2026-03-01')).toBe(1)
  })
})

describe('补货是否叠加订阅预测（snsReplenishmentGate）', () => {
  it('四条都满足才叠加', () => {
    expect(snsReplenishmentGate(offer(), TODAY)).toEqual({ used: true, reason: null })
  })

  it('快照正好 7 天内算有效，8 天算过期', () => {
    expect(snsReplenishmentGate(offer({ snapshotDate: '2026-10-17' }), TODAY).used).toBe(true)
    expect(snsReplenishmentGate(offer({ snapshotDate: '2026-10-16' }), TODAY)).toEqual({ used: false, reason: 'STALE' })
  })

  it('不可订阅与已暂停不叠加；没有可订阅状态不拦（与补货计算一致）', () => {
    expect(snsReplenishmentGate(offer({ eligibility: 'INELIGIBLE' }), TODAY).reason).toBe('INELIGIBLE')
    expect(snsReplenishmentGate(offer({ eligibility: 'SUSPENDED' }), TODAY).reason).toBe('INELIGIBLE')
    expect(snsReplenishmentGate(offer({ eligibility: null }), TODAY).used).toBe(true)
  })

  it('没有未来 30 天预测、没有上月出货或当月天数，各写各的原因；预测是 0 也算有预测', () => {
    expect(snsReplenishmentGate(offer({ forecastNext30: null }), TODAY).reason).toBe('NO_FORECAST')
    expect(snsReplenishmentGate(offer({ shippedUnitsPrevMonth: null }), TODAY).reason).toBe('NO_PREV_MONTH')
    expect(snsReplenishmentGate(offer({ prevMonthDays: null }), TODAY).reason).toBe('NO_PREV_MONTH')
    expect(snsReplenishmentGate(offer({ forecastNext30: 0, shippedUnitsPrevMonth: 0 }), TODAY).used).toBe(true)
  })
})

describe('整体状态说明（snsEmptyState）', () => {
  it('角色没批给申请方式；没开通写不适用；没同步过写尚未接入；同步正常写尚无记录；失败带原因', () => {
    expect(snsEmptyState(sync({ rolePending: true, status: 'UNAUTHORIZED' })).state).toBe('ROLE_PENDING')
    expect(snsEmptyState(sync({ status: 'NOT_APPLICABLE' })).state).toBe('NOT_APPLICABLE')
    expect(snsEmptyState(sync({ status: 'NO_RECORD' })).state).toBe('NOT_CONNECTED')
    expect(snsEmptyState(sync({ status: 'NORMAL' })).state).toBe('NO_DATA')
    expect(snsEmptyState(sync({ status: 'DELAYED' })).state).toBe('NO_DATA')
    expect(snsEmptyState(sync({ status: 'FAILED', errorMessage: '亚马逊限流' }))).toEqual({ state: 'NOT_CONNECTED', note: '亚马逊限流' })
  })
})

describe('明细查询校验', () => {
  it('缺省按未来 30 天预计出货从大到小；排序字段走白名单', () => {
    expect(SnsAsinListQuerySchema.parse({}).sort).toEqual({ field: 'forecastNext30', dir: 'desc' })
    expect(SnsOfferListQuerySchema.parse({ sort: 'price:asc' }).sort).toEqual({ field: 'price', dir: 'asc' })
    expect(SnsAsinListQuerySchema.safeParse({ sort: 'price:asc' }).success).toBe(false)
    expect(SnsOfferListQuerySchema.safeParse({ sort: 'shippedUnitsPrevMonth' }).success).toBe(false)
  })

  it('可订阅状态筛选只认三个值；每页条数有上限；空搜索词不接受', () => {
    expect(SnsOfferListQuerySchema.parse({ eligibility: 'SUSPENDED' }).eligibility).toBe('SUSPENDED')
    expect(SnsOfferListQuerySchema.safeParse({ eligibility: 'x' }).success).toBe(false)
    expect(SnsAsinListQuerySchema.safeParse({ pageSize: '99999' }).success).toBe(false)
    expect(SnsAsinListQuerySchema.safeParse({ q: '' }).success).toBe(false)
  })
})
