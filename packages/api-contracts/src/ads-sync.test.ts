import { describe, expect, it } from 'vitest'
import { adsReportWindowIssue } from './ads-connector'
import { ADS_REPORT_TEMPLATES } from './ads-reports'
import { adsArchiveDecision, adsReportDue, adsScheduledProducts, adsScheduledTemplates, adsScheduledWindow, ADS_INITIAL_FILL_DAYS } from './ads-sync'
import { REFRESH_DOMAINS } from './enterprise-settings'
import { freshnessSourceOfJobType, freshnessStatusForFailure } from './freshness'

describe('归档判断：只有完整读完、读到了东西、比例不离谱，才把没出现的对象归档', () => {
  it('翻页没翻完一律不归档', () => {
    expect(adsArchiveDecision({ complete: false, read: 100, active: 100, stale: 3 })).toEqual({ archive: false, reason: 'INCOMPLETE' })
  })
  it('没有要归档的：不归档也没有原因', () => {
    expect(adsArchiveDecision({ complete: true, read: 10, active: 10, stale: 0 })).toEqual({ archive: false, reason: null })
  })
  it('一条都没读到而库里有行：多半是接口返回为空，不归档', () => {
    expect(adsArchiveDecision({ complete: true, read: 0, active: 4, stale: 4 })).toEqual({ archive: false, reason: 'EMPTY_RESPONSE' })
  })
  it('一次要归档超过一半（库里至少 20 行）：不归档；不到 20 行的小账户不受这条限制', () => {
    expect(adsArchiveDecision({ complete: true, read: 9, active: 30, stale: 21 })).toEqual({ archive: false, reason: 'TOO_MANY' })
    expect(adsArchiveDecision({ complete: true, read: 15, active: 30, stale: 15 })).toEqual({ archive: true, reason: null })
    expect(adsArchiveDecision({ complete: true, read: 1, active: 3, stale: 2 })).toEqual({ archive: true, reason: null })
  })
})

describe('定时报告的窗口：第一次回看、之后每天重拉最近 3 天', () => {
  it('按日模板第一次取 30 天，之后取最近 3 天（含今天）', () => {
    expect(adsScheduledWindow('DAILY', '2026-10-30', false)).toEqual({ from: '2026-10-01', to: '2026-10-30' })
    expect(adsScheduledWindow('DAILY', '2026-10-30', true)).toEqual({ from: '2026-10-28', to: '2026-10-30' })
    expect(ADS_INITIAL_FILL_DAYS).toBe(30)
  })
  it('按小时模板第一次取 14 天（保留期上限），之后同样 3 天', () => {
    expect(adsScheduledWindow('HOURLY', '2026-10-30', false)).toEqual({ from: '2026-10-17', to: '2026-10-30' })
    expect(adsScheduledWindow('HOURLY', '2026-10-30', true)).toEqual({ from: '2026-10-28', to: '2026-10-30' })
  })
  it('今天的日期不合法返回 null；算出的窗口都通过报告窗口检查（含小时报告的 14 天保留期）', () => {
    expect(adsScheduledWindow('DAILY', '2026-13-45', false)).toBeNull()
    for (const template of ADS_REPORT_TEMPLATES) {
      for (const filled of [false, true]) {
        const window = adsScheduledWindow(template.granularity, '2026-10-30', filled)
        expect(window && adsReportWindowIssue({ granularity: template.granularity, ...window, today: '2026-10-30' }), `${template.key} ${filled}`).toBeNull()
      }
    }
  })
})

describe('定时报告的产品与模板、是否到期', () => {
  it('只取档案下确实有活动的产品；没有任何活动记录时先取商品推广', () => {
    expect(adsScheduledProducts(['SPONSORED_DISPLAY', 'SPONSORED_PRODUCTS', 'UNKNOWN'])).toEqual(['SPONSORED_PRODUCTS', 'SPONSORED_DISPLAY'])
    expect(adsScheduledProducts([])).toEqual(['SPONSORED_PRODUCTS'])
  })
  it('商品推广取全部八个模板，其余产品只取活动日报', () => {
    expect(adsScheduledTemplates('SPONSORED_PRODUCTS')).toHaveLength(ADS_REPORT_TEMPLATES.length)
    expect(adsScheduledTemplates('SPONSORED_BRANDS')).toEqual(['CAMPAIGN_DAILY'])
  })
  it('没有记录、失败的到期；排队中与生成中的不重复排；成功的满 20 小时才再排', () => {
    const now = new Date('2026-10-30T12:00:00Z')
    const at = (hours: number) => new Date(now.getTime() - hours * 3_600_000)
    expect(adsReportDue(null, now)).toBe(true)
    expect(adsReportDue({ status: 'FAILED', createdAt: at(1) }, now)).toBe(true)
    expect(adsReportDue({ status: 'PENDING', createdAt: at(2) }, now)).toBe(false)
    expect(adsReportDue({ status: 'GENERATING', createdAt: at(11) }, now)).toBe(false)
    // 卡了超过 12 小时的任务不再挡路，否则这个模板永远排不上
    expect(adsReportDue({ status: 'PENDING', createdAt: at(30) }, now)).toBe(true)
    expect(adsReportDue({ status: 'GENERATING', createdAt: at(13) }, now)).toBe(true)
    expect(adsReportDue({ status: 'READY', createdAt: at(19) }, now)).toBe(false)
    expect(adsReportDue({ status: 'READY', createdAt: at(21) }, now)).toBe(true)
  })
})

describe('登记：新鲜度来源、刷新数据域、账户缺失属于等待依赖', () => {
  it('实体同步与广告报表各有新鲜度来源与可调整的刷新数据域', () => {
    expect(freshnessSourceOfJobType('ADS_ENTITY_SYNC')).toMatchObject({ key: 'ads.entities-v1', intervalMinutes: 120 })
    expect(freshnessSourceOfJobType('ADS_REPORT_V1')).toMatchObject({ key: 'ads.reports-v1', intervalMinutes: 1440 })
    expect(REFRESH_DOMAINS.find(domain => domain.key === 'ADS_ENTITY_SYNC')?.builtInMinutes).toBe(120)
    expect(REFRESH_DOMAINS.find(domain => domain.key === 'ADS_REPORT_V1')?.builtInMinutes).toBe(1440)
  })
  it('没发现广告账户编号：新鲜度记“等待依赖”，不是同步故障', () => {
    expect(freshnessStatusForFailure('ADS_ACCOUNT_MISSING')).toBe('WAITING_DEPENDENCY')
  })
})
