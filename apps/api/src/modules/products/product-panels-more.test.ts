import { describe, expect, it } from 'vitest'
import { categoryRows, distributionOf } from './product-panels-more'

describe('星级分布', () => {
  it('只认 1 到 5 星的非负整数，其余当作没有', () => {
    expect(distributionOf({ '1': 2, '5': 10, '6': 3, '3': -1, '4': 1.5 })).toEqual({ '1': 2, '5': 10 })
    expect(distributionOf(null)).toBeNull()
    expect(distributionOf([1, 2])).toBeNull()
    expect(distributionOf({ x: 1 })).toBeNull()
  })
})

describe('类目主题对比', () => {
  const topics = [
    { topicKey: 'Battery', sentiment: 'NEGATIVE', rank: 1 },
    { topicKey: 'Easy', sentiment: 'POSITIVE', rank: 1 },
  ]
  const trends = [
    { month: '2026-09-01', scope: 'ALL', topicKey: 'Easy', sentiment: 'POSITIVE', rate: 0.12 },
    { month: '2026-08-01', scope: 'ALL', topicKey: 'Easy', sentiment: 'POSITIVE', rate: 0.1 },
    { month: '2026-09-01', scope: 'TOP25', topicKey: 'Easy', sentiment: 'POSITIVE', rate: 0.2 },
  ]

  it('正面在前；类目里没有的月份与主题是空，不是 0', () => {
    const rows = categoryRows(topics, trends, '2026-09-01', '2026-08-01')
    expect(rows.map(row => row.topicKey)).toEqual(['Easy', 'Battery'])
    expect(rows[0]).toMatchObject({ allRate: 0.12, allPrevious: 0.1, top25Rate: 0.2, top25Previous: null, productRank: 1 })
    expect(rows[1]).toMatchObject({ allRate: null, allPrevious: null, top25Rate: null })
  })

  it('只有一个月的数据：上月列全是空', () => {
    const rows = categoryRows(topics, trends, '2026-09-01', null)
    expect(rows[0]!.allPrevious).toBeNull()
  })
})
