import { describe, expect, it } from 'vitest'
import { RATINGS_TEMPLATE_EXAMPLE, RATINGS_TEMPLATE_HEADER, parseRatingsFile } from '@nova/api-contracts'
import { buildReturnTrendOption, buildTopicTrendOption, distributionBars, ratingTrendText, topicTrendCount } from './reviews-options'
import { batchIssue, improvementAction, improvementDetail, improvementTitle, pairValue, ratingSourceText, ratingsTemplateCsv, signedNumber, solicitResultText, splitPair, tabOf } from './reviews-state'
import { improvementRow, ratingRow, returnsResponse, topicsResponse } from './reviews-fixtures.test-helper'

// 评价与反馈的纯函数：图表配置（没有记录的月份保持为空，不补 0）、星级分布、模板、批量请求的前置条件与结果文字、待办标题与说明。

type SeriesItem = { name?: string; data?: Array<number | null>; lineStyle?: { type?: string } }
const seriesOf = (option: { series?: unknown }) => option.series as SeriesItem[]

describe('评论主题趋势图', () => {
  const selected = topicsResponse().selected!

  it('只画所选情感的主题；全部商品画实线、前 25% 画虚线；缺的月份是 null', () => {
    const series = seriesOf(buildTopicTrendOption(selected.trend, selected.trendMonths, 'NEGATIVE'))
    expect(series.map(item => item.name)).toEqual(['Zipper broke（类目全部商品）', 'Zipper broke（类目前 25% 商品）'])
    expect(series[0].data).toEqual([0.1, 0.12])
    expect(series[1].data).toEqual([null, 0.08])
    expect(series[0].lineStyle?.type).toBeUndefined()
    expect(series[1].lineStyle?.type).toBe('dashed')
  })

  it('另一种情感没有趋势线：条数为 0，图里没有线', () => {
    expect(topicTrendCount(selected.trend, 'POSITIVE')).toBe(0)
    expect(topicTrendCount(selected.trend, 'NEGATIVE')).toBe(2)
    expect(seriesOf(buildTopicTrendOption(selected.trend, selected.trendMonths, 'POSITIVE'))).toEqual([])
  })

  it('横轴按月份显示年月', () => {
    const option = buildTopicTrendOption(selected.trend, selected.trendMonths, 'NEGATIVE') as { xAxis: { data: string[] } }
    expect(option.xAxis.data).toEqual(['2026-09', '2026-10'])
  })
})

describe('退货主题趋势图', () => {
  const node = returnsResponse().selectedNode!

  it('按档位取占比：全部商品有值，前 25% 没有记录时保持为空', () => {
    expect(seriesOf(buildReturnTrendOption(node.topics, node.months, 'ALL'))[0].data).toEqual([0.1, 0.15])
    expect(seriesOf(buildReturnTrendOption(node.topics, node.months, 'TOP25'))[0].data).toEqual([null, null])
  })
})

describe('星级分布与最近趋势', () => {
  it('5 星在上，占比按总人数算；没有导入返回空', () => {
    const bars = distributionBars({ '1': 40, '2': 30, '3': 80, '4': 250, '5': 880 })
    expect(bars.map(bar => bar.star)).toEqual([5, 4, 3, 2, 1])
    expect(bars[0].share).toBeCloseTo(0.6875, 4)
    expect(distributionBars(null)).toEqual([])
  })

  it('缺的星级不补 0 人；总人数为 0 时占比为 null', () => {
    expect(distributionBars({ '5': 10, '1': 10 }).map(bar => bar.star)).toEqual([5, 1])
    expect(distributionBars({ '5': 0 })[0].share).toBeNull()
  })

  it('趋势文字：旧到新，跳过没有星级的点，全没有返回 null', () => {
    const points = [
      { date: '2026-10-01', avgRating: 4.4, ratingCount: 1 },
      { date: '2026-10-08', avgRating: null, ratingCount: 2 },
      { date: '2026-10-15', avgRating: 4.25, ratingCount: 3 },
    ]
    expect(ratingTrendText(points)).toBe('4.40 → 4.25')
    expect(ratingTrendText([{ date: '2026-10-01', avgRating: null, ratingCount: 2 }])).toBeNull()
  })
})

describe('评分导入模板与文字', () => {
  it('模板是 UTF-8 带 BOM、CRLF 换行，表头与示例行来自契约，示例能通过导入校验', () => {
    const csv = ratingsTemplateCsv()
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1)).toBe(`${RATINGS_TEMPLATE_HEADER.join(',')}\r\n${RATINGS_TEMPLATE_EXAMPLE.join(',')}\r\n`)
    expect(parseRatingsFile(csv, '2026-10-24').errors).toEqual([])
  })

  it('来源文字与带正负号的变化', () => {
    expect(ratingSourceText(ratingRow())).toBe('文件导入 · ratings-1024.csv · 林然')
    expect(ratingSourceText(ratingRow({ importedBy: null }))).toBe('文件导入 · ratings-1024.csv · 导入人尚无记录')
    expect(signedNumber(0.1, 2)).toBe('+0.10')
    expect(signedNumber(-0.1, 2)).toBe('-0.10')
    expect(signedNumber(0, 0)).toBe('±0')
  })

  it('地址栏的页签参数：不认识的值回到评分概况；选择值可拆回店铺与对象', () => {
    expect(tabOf('solicit')).toBe('solicit')
    expect(tabOf('nope')).toBe('ratings')
    expect(tabOf(undefined)).toBe('ratings')
    expect(splitPair(pairValue('st1', 'B0RATE0001'))).toEqual(['st1', 'B0RATE0001'])
    expect(splitPair('')).toBeNull()
  })
})

describe('批量请求评价', () => {
  it('前置条件：1 到 50 单且同一店铺', () => {
    expect(batchIssue([])).toContain('勾选')
    expect(batchIssue([{ storeId: 'a' }, { storeId: 'b' }])).toContain('同一个店铺')
    expect(batchIssue(Array.from({ length: 51 }, () => ({ storeId: 'a' })))).toContain('最多')
    expect(batchIssue([{ storeId: 'a' }])).toBeNull()
    expect(batchIssue(Array.from({ length: 50 }, () => ({ storeId: 'a' })))).toBeNull()
  })

  it('结果文字：已受理几个，跳过几个并按原因分组', () => {
    expect(solicitResultText({ accepted: 3, skipped: [] })).toBe('已受理 3 个订单')
    const text = solicitResultText({
      accepted: 1,
      skipped: [
        { amazonOrderId: 'a', reason: 'ALREADY_REQUESTED' },
        { amazonOrderId: 'b', reason: 'ALREADY_REQUESTED' },
        { amazonOrderId: 'c', reason: 'OUT_OF_WINDOW' },
      ],
    })
    expect(text).toContain('已受理 1 个订单，跳过 3 个')
    expect(text).toContain('已经请求过 2 个')
    expect(text).toContain('不在可请求期内')
  })
})

describe('改进清单生成的待办', () => {
  const row = improvementRow()

  it('标题：改进评价问题：<ASIN> <首个负面主题>；没有负面主题时不留多余空格', () => {
    expect(improvementTitle(row)).toBe('改进评价问题：B0RATE0001 Zipper broke')
    expect(improvementTitle(improvementRow({ negativeTopics: [] }))).toBe('改进评价问题：B0RATE0001')
  })

  it('说明包含建议、主题、退货原因与数据口径，且不超过 2000 字', () => {
    const detail = improvementDetail(row, 90)
    expect(detail).toContain(`建议：${row.suggestion}`)
    expect(detail).toContain('Zipper broke（提及量 100-200）')
    expect(detail).toContain('近 90 天退货：18 件；商品有缺陷 10 件；与描述不符 5 件')
    expect(detail).toContain('数据口径：')
    expect(detail.length).toBeLessThanOrEqual(2000)
    expect(improvementAction(improvementRow({ suggestion: 'x'.repeat(900) })).length).toBe(500)
  })

  it('没有退货记录写“尚无记录”，不写 0 件', () => {
    expect(improvementDetail(improvementRow({ returnUnits: 0, returnReasons: [] }), 90)).toContain('近 90 天退货：尚无记录')
  })
})
