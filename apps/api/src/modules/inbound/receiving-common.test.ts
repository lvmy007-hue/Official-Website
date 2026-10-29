import { describe, expect, it } from 'vitest'
import { claimStateOf } from './receiving-common'

describe('claimStateOf：货件列表上的赔付状态', () => {
  it('货件没关闭不判断，哪怕已有机会', () => {
    expect(claimStateOf({ closed: false, openShort: true, opportunityStatuses: ['PENDING'] })).toBe('NOT_JUDGED')
  })
  it('关闭后没有少收：无需赔付；有少收但机会还没产出：等待期内', () => {
    expect(claimStateOf({ closed: true, openShort: false, opportunityStatuses: [] })).toBe('NONE')
    expect(claimStateOf({ closed: true, openShort: true, opportunityStatuses: [] })).toBe('WAITING')
  })
  it('多个 SKU 的机会并存：待处理 > 已生成案件 > 已过期 > 已忽略 > 差异已消除', () => {
    expect(claimStateOf({ closed: true, openShort: true, opportunityStatuses: ['IGNORED', 'PENDING', 'EXPIRED'] })).toBe('PENDING')
    expect(claimStateOf({ closed: true, openShort: true, opportunityStatuses: ['EXPIRED', 'CASE_CREATED'] })).toBe('CASE_CREATED')
    expect(claimStateOf({ closed: true, openShort: false, opportunityStatuses: ['RESOLVED', 'IGNORED'] })).toBe('IGNORED')
    expect(claimStateOf({ closed: true, openShort: false, opportunityStatuses: ['RESOLVED'] })).toBe('RESOLVED')
  })
  it('不认识的状态值被忽略', () => {
    expect(claimStateOf({ closed: true, openShort: false, opportunityStatuses: ['WHATEVER'] })).toBe('NONE')
  })
})
