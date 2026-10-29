import { describe, expect, it } from 'vitest'
import { aggregateFreshness, FRESHNESS_SOURCES } from './freshness.js'
import { buildSourceHealth, SOURCE_HEALTH_LAYOUT } from './overview.js'

describe('数据源健康表布局', () => {
  it('已登记的新鲜度来源都在表里（新增来源必须决定它排在哪一行）', () => {
    const live = SOURCE_HEALTH_LAYOUT.flatMap(entry => ('live' in entry ? [entry.live] : []))
    expect([...live].sort()).toEqual(FRESHNESS_SOURCES.map(item => item.key).sort())
  })

  it('没有同步记录时如实显示“尚无记录”；未交付的来源显示“尚未接入”；推送类显示“未接入”', () => {
    const rows = buildSourceHealth(aggregateFreshness([], ['s1'], new Date('2026-10-22T08:00:00Z')).sources)
    expect(rows.map(row => row.label)).toEqual(['订单', '库存', '入仓计划', '财务交易', '报告', '数据中心', '广告', '营销数据流', '品牌分析', '消息推送'])
    expect(rows[0]).toMatchObject({ state: 'LIVE', status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null })
    expect(rows.find(row => row.sourceKey === 'ads')).toMatchObject({ state: 'NOT_DELIVERED', statusLabel: '尚未接入', lastSuccessAt: null, coverage: null })
    expect(rows.find(row => row.sourceKey === 'notifications-push')).toMatchObject({ state: 'NOT_CONNECTED', statusLabel: '未接入' })
    // 没有任何一行带示例时间或数字
    expect(rows.filter(row => row.lastSuccessAt !== null)).toEqual([])
  })
})
