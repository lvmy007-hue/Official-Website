import { describe, expect, it } from 'vitest'
import { claimWindowOf, discrepancyOf, ReceivingApplyBodySchema, receivingDaysOf } from './receiving.js'

const d = (text: string) => new Date(`${text}T12:00:00Z`)

describe('discrepancyOf', () => {
  it('应发大于已收是少收，小于是多收，相等是没有差异', () => {
    expect(discrepancyOf(10, 7)).toEqual({ kind: 'SHORT', qty: 3 })
    expect(discrepancyOf(5, 6)).toEqual({ kind: 'OVER', qty: 1 })
    expect(discrepancyOf(4, 4)).toBeNull()
  })
  it('缺任何一边数量都不判差异（缺数据不当 0）', () => {
    expect(discrepancyOf(null, 3)).toBeNull()
    expect(discrepancyOf(3, null)).toBeNull()
    expect(discrepancyOf(undefined, undefined)).toBeNull()
    expect(discrepancyOf(0, 0)).toBeNull()
    expect(discrepancyOf(3, 0)).toEqual({ kind: 'SHORT', qty: 3 })
  })
})

describe('claimWindowOf', () => {
  it('等待期内为 WAITING，到期当天起为 OPEN，截止日当天仍可申请，次日起 EXPIRED', () => {
    const closed = d('2026-01-01')
    expect(claimWindowOf(closed, d('2026-02-14'))).toMatchObject({ eligibleFrom: '2026-02-15', state: 'WAITING' })
    expect(claimWindowOf(closed, d('2026-02-15')).state).toBe('OPEN')
    const { deadline } = claimWindowOf(closed, d('2026-02-15'))
    expect(claimWindowOf(closed, d(deadline)).state).toBe('OPEN')
    expect(claimWindowOf(closed, new Date(new Date(`${deadline}T12:00:00Z`).getTime() + 86_400_000)).state).toBe('EXPIRED')
  })
  it('时限可以传入覆盖默认值', () => {
    expect(claimWindowOf(d('2026-01-01'), d('2026-01-12'), 10, 30)).toEqual({ eligibleFrom: '2026-01-11', deadline: '2026-01-31', state: 'OPEN' })
  })
})

describe('receivingDaysOf', () => {
  it('按自然日数算，同一天为 0；缺任何一端或顺序颠倒为 null', () => {
    expect(receivingDaysOf(d('2026-03-01'), d('2026-03-04'))).toBe(3)
    expect(receivingDaysOf(new Date('2026-03-01T01:00:00Z'), new Date('2026-03-01T23:00:00Z'))).toBe(0)
    expect(receivingDaysOf(null, d('2026-03-04'))).toBeNull()
    expect(receivingDaysOf(d('2026-03-04'), undefined)).toBeNull()
    expect(receivingDaysOf(d('2026-03-05'), d('2026-03-04'))).toBeNull()
  })
})

describe('ReceivingApplyBodySchema', () => {
  it('运营中心可以是 null（全部合计），版本号必须是正整数', () => {
    expect(ReceivingApplyBodySchema.safeParse({ destinationFc: null, expectedVersionNo: 1 }).success).toBe(true)
    expect(ReceivingApplyBodySchema.safeParse({ destinationFc: 'ONT8', expectedVersionNo: 0 }).success).toBe(false)
    expect(ReceivingApplyBodySchema.safeParse({ destinationFc: '', expectedVersionNo: 1 }).success).toBe(false)
  })
})
