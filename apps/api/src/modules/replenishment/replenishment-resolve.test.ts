import type { ReplenishPolicy } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { policy } from '../inventory/inventory-fixtures.test-helper'
import { indexPolicies, latestEffective, pickPolicy } from './replenishment-resolve'
import { batchStatusOf } from './replenishment-status'

const version = (over: Partial<ReplenishPolicy>): ReplenishPolicy => ({
  ...policy(),
  level: 'TENANT',
  levelRef: 'ALL',
  productionDays: null,
  domesticDays: null,
  receivingDays: null,
  serviceLevel: null,
  transportPreference: null,
  transportOptions: [],
  casePackQty: null,
  moq: null,
  minOrderValue: null,
  includeUnavoidableShortage: false,
  ...over,
})

describe('三级策略解析', () => {
  const versions = [
    version({ versionNo: 1, effectiveFrom: '2026-01-01' }),
    version({ versionNo: 2, effectiveFrom: '2026-10-01' }),
    version({ versionNo: 3, effectiveFrom: '2026-12-01' }),
    version({ level: 'CATEGORY', levelRef: '耳机', versionNo: 1, effectiveFrom: '2026-10-01', coverageDays: 90 }),
    version({ level: 'SKU', levelRef: 'SKU-A', versionNo: 2, effectiveFrom: '2026-10-22', coverageDays: 120 }),
    version({ level: 'SKU', levelRef: 'SKU-A', versionNo: 1, effectiveFrom: '2026-10-01', coverageDays: 100 }),
    version({ level: 'SKU', levelRef: 'SKU-B', versionNo: 1, effectiveFrom: '2026-11-01' }),
  ]
  const index = indexPolicies(latestEffective(versions, '2026-10-22'))

  it('每个对象只取今天生效的最大版本；未来生效的版本不算', () => {
    const effective = latestEffective(versions, '2026-10-22')
    expect(effective.find(item => item.level === 'TENANT')?.versionNo).toBe(2)
    expect(effective.find(item => item.levelRef === 'SKU-A')?.versionNo).toBe(2)
    expect(effective.some(item => item.levelRef === 'SKU-B')).toBe(false)
  })

  it('SKU 级 > 品类级 > 企业级，下级整行覆盖', () => {
    expect(pickPolicy(index, 'SKU-A', '耳机')).toMatchObject({ level: 'SKU', coverageDays: 120 })
    expect(pickPolicy(index, 'SKU-C', '耳机')).toMatchObject({ level: 'CATEGORY', coverageDays: 90 })
    expect(pickPolicy(index, 'SKU-C', '键盘')).toMatchObject({ level: 'TENANT', versionNo: 2 })
    expect(pickPolicy(index, 'SKU-B', null)).toMatchObject({ level: 'TENANT' })
  })

  it('没有任何策略时返回 null', () => {
    expect(pickPolicy(indexPolicies([]), 'SKU-A', '耳机')).toBeNull()
  })
})

describe('批次状态', () => {
  const ids = ['r1', 'r2', 'r3']
  it('没有动作：待审；只有采纳或调整：已确认；有草稿：已生成草稿', () => {
    expect(batchStatusOf(ids, [])).toBe('PENDING_REVIEW')
    expect(batchStatusOf(ids, [{ recommendationId: 'r1', action: 'ADOPT' }])).toBe('CONFIRMED')
    expect(batchStatusOf(ids, [{ recommendationId: 'r1', action: 'ADJUST' }])).toBe('CONFIRMED')
    expect(
      batchStatusOf(ids, [
        { recommendationId: 'r1', action: 'ADOPT' },
        { recommendationId: 'r2', action: 'PURCHASE_DRAFT' },
      ]),
    ).toBe('DRAFTED')
  })

  it('只有忽略不算确认，但每条都有动作时已结束', () => {
    expect(batchStatusOf(ids, [{ recommendationId: 'r1', action: 'IGNORE' }])).toBe('PENDING_REVIEW')
    expect(
      batchStatusOf(
        ids,
        ids.map(id => ({ recommendationId: id, action: 'IGNORE' })),
      ),
    ).toBe('CLOSED')
  })

  it('空批次不会被当成已结束', () => {
    expect(batchStatusOf([], [])).toBe('PENDING_REVIEW')
  })
})
