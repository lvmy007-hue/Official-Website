import { describe, expect, it } from 'vitest'
import { parseReportRow, zonedHourOf, type ParsedReportRow } from './rows'
import { termRowKey } from './writers'

const parsed = (result: ReturnType<typeof parseReportRow>) => {
  expect('skipped' in result).toBe(false)
  return result as ParsedReportRow
}

describe('新报告接口的行解析：按模板读取', () => {
  it('活动日报：日期取年月日，指标缺了就是空而不是 0，旧版别名也认', () => {
    const row = parsed(
      parseReportRow('CAMPAIGN_DAILY', { date: '2026-10-05T00:00:00Z', adProduct: 'sponsored_products', campaignId: 'C1', impressions: 100, clicks: '5', spend: '$12.50', sales7d: 40 }),
    )
    expect(row.keys).toMatchObject({ day: '2026-10-05', campaignId: 'C1', adProduct: 'SPONSORED_PRODUCTS' })
    expect(row.metrics).toEqual({ impressions: 100, clicks: 5, cost: 12.5, sales: 40, purchases: null, units: null })
  })

  it('缺日期、缺活动编号、指标全为空：整行跳过并说明原因（不猜）', () => {
    expect(parseReportRow('CAMPAIGN_DAILY', { campaignId: 'C1', impressions: 1 })).toEqual({ skipped: 'NO_DATE' })
    expect(parseReportRow('CAMPAIGN_DAILY', { date: '2026-10-05', impressions: 1 })).toEqual({ skipped: 'NO_CAMPAIGN' })
    expect(parseReportRow('CAMPAIGN_DAILY', { date: '2026-10-05', campaignId: 'C1' })).toEqual({ skipped: 'NO_METRICS' })
  })

  it('各模板的必需维度：广告组要广告组编号，搜索词要搜索词，广告位要广告位，转化商品要两个 ASIN，投放对象要编号或表达式', () => {
    const base = { date: '2026-10-05', campaignId: 'C1', clicks: 1 }
    expect(parseReportRow('AD_GROUP_DAILY', base)).toEqual({ skipped: 'NO_KEY' })
    expect(parsed(parseReportRow('AD_GROUP_DAILY', { ...base, adGroupId: 'G1' })).keys.adGroupId).toBe('G1')
    expect(parseReportRow('SEARCH_TERM_DAILY', { ...base, adGroupId: 'G1' })).toEqual({ skipped: 'NO_KEY' })
    expect(parsed(parseReportRow('SEARCH_TERM_DAILY', { ...base, searchTerm: 'yoga mat' })).keys.searchTerm).toBe('yoga mat')
    expect(parseReportRow('PLACEMENT_DAILY', base)).toEqual({ skipped: 'NO_KEY' })
    expect(parseReportRow('ADVERTISED_PRODUCT_DAILY', base)).toEqual({ skipped: 'NO_KEY' })
    expect(parseReportRow('CONVERTED_PRODUCT_DAILY', { ...base, advertisedAsin: 'B0A', units: 1, sales: 2 })).toEqual({ skipped: 'NO_KEY' })
    expect(parseReportRow('TARGET_DAILY', base)).toEqual({ skipped: 'NO_KEY' })
    expect(parsed(parseReportRow('TARGET_DAILY', { ...base, targetingExpression: 'asin="B0X"', matchType: 'exact' })).keys).toMatchObject({ targetText: 'asin="B0X"', matchType: 'EXACT' })
  })

  it('转化商品：件数与销售额缺一个就跳过（库里这两列不允许为空）', () => {
    const base = { date: '2026-10-05', campaignId: 'C1', advertisedAsin: 'B0A', purchasedAsin: 'B0B' }
    expect(parseReportRow('CONVERTED_PRODUCT_DAILY', { ...base, units: 2 })).toEqual({ skipped: 'NO_METRICS' })
    expect(parsed(parseReportRow('CONVERTED_PRODUCT_DAILY', { ...base, units: 2, sales: 9.5 })).metrics).toMatchObject({ units: 2, sales: 9.5 })
  })
})

describe('小时报告：只认带时区的时间', () => {
  it('带 Z 或偏移的 ISO 时间截到整点；没有时区、只有小时数字、乱写的一律不认', () => {
    expect(zonedHourOf('2026-10-05T13:45:10Z')?.toISOString()).toBe('2026-10-05T13:00:00.000Z')
    expect(zonedHourOf('2026-10-05T13:00:00+08:00')?.toISOString()).toBe('2026-10-05T05:00:00.000Z')
    expect(zonedHourOf('2026-10-05T13:00:00')).toBeNull()
    expect(zonedHourOf('13')).toBeNull()
    expect(zonedHourOf('2026-10-05')).toBeNull()
    expect(zonedHourOf('')).toBeNull()
  })

  it('小时模板：没有带时区的小时就跳过；有就按小时起点，不需要日期列', () => {
    expect(parseReportRow('CAMPAIGN_HOURLY', { hour: '9', campaignId: 'C1', clicks: 1 })).toEqual({ skipped: 'NO_HOUR' })
    const row = parsed(parseReportRow('CAMPAIGN_HOURLY', { hour: '2026-10-05T09:30:00Z', campaignId: 'C1', clicks: 3 }))
    expect(row.keys.hourStart?.toISOString()).toBe('2026-10-05T09:00:00.000Z')
    expect(row.keys.day).toBe('')
  })
})

describe('词级指标的行键', () => {
  it('与旧版写入器同一格式（活动|广告组|投放编号|表达式|搜索词），新旧才落在同一行', () => {
    expect(termRowKey({ campaignId: 'C1', adGroupId: 'G1', targetId: 'K1', targetText: 'yoga', searchTerm: 'yoga mat' })).toBe('C1|G1|K1|yoga|yoga mat')
    expect(termRowKey({ campaignId: 'C1', adGroupId: 'G1', targetId: '', targetText: '', searchTerm: '' })).toBe('C1|G1|||')
  })
})
