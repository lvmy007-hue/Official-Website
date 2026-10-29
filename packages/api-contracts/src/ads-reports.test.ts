import { describe, expect, it } from 'vitest'
import { adsReportWindowIssue } from './ads-connector'
import { ADS_BACKFILL_MAX_SLICES, ADS_REPORT_TEMPLATES, ADS_REPORT_TEMPLATE_KEYS, adsReportFailureText, adsReportRetryable, adsReportTemplateOf, backfillWindowsOf, monthsBefore } from './ads-reports'
import { ADS_METRICS_DATASETS } from './ads-metrics'
import { AdsParityRunBodySchema, AdsReportBackfillBodySchema, AdsReportCreateBodySchema, AdsReportListQuerySchema } from './ads-reports-query'

describe('广告报表：模板', () => {
  it('8 个模板，键唯一，维度与指标都不为空，导入后的数据集存在', () => {
    expect(ADS_REPORT_TEMPLATES).toHaveLength(8)
    expect(new Set(ADS_REPORT_TEMPLATES.map(template => template.key)).size).toBe(8)
    expect(ADS_REPORT_TEMPLATES.map(template => template.key)).toEqual([...ADS_REPORT_TEMPLATE_KEYS])
    for (const template of ADS_REPORT_TEMPLATES) {
      expect(template.dimensions.length).toBeGreaterThan(0)
      expect(template.metrics.length).toBeGreaterThan(0)
      expect(ADS_METRICS_DATASETS[template.dataset]).toBeDefined()
    }
  })

  it('小时模板按小时粒度（最多 14 天），其余按日；活动日报与广告组、词级不要求广告账户行', () => {
    expect(adsReportTemplateOf('CAMPAIGN_HOURLY')?.granularity).toBe('HOURLY')
    expect(ADS_REPORT_TEMPLATES.filter(template => template.granularity === 'DAILY')).toHaveLength(7)
    const withoutAccount = ADS_REPORT_TEMPLATES.filter(template => !template.needsAccount).map(template => template.key)
    expect(withoutAccount).toEqual(['CAMPAIGN_DAILY', 'AD_GROUP_DAILY', 'TARGET_DAILY', 'SEARCH_TERM_DAILY'])
  })

  it('不认识的模板键返回 null', () => {
    expect(adsReportTemplateOf('NOPE')).toBeNull()
    expect(adsReportTemplateOf(null)).toBeNull()
  })

  it('各模板在自己的粒度上限内能通过时间范围检查，小时模板超过 14 天被拒绝', () => {
    const today = '2026-10-20'
    expect(adsReportWindowIssue({ granularity: 'DAILY', from: '2026-06-23', to: today, today })).toBeNull()
    expect(adsReportWindowIssue({ granularity: 'HOURLY', from: '2026-10-07', to: today, today })).toBeNull()
    expect(adsReportWindowIssue({ granularity: 'HOURLY', from: '2026-10-01', to: today, today })).toContain('14')
  })
})

describe('广告报表：失败说明与重试规则', () => {
  it('任务自带的原因优先，其次按失败码，最后兜底；没有失败就是 null', () => {
    expect(adsReportFailureText(null, null)).toBeNull()
    expect(adsReportFailureText('ADS_REPORT_WINDOW', '按日的报告单次最多取 120 天')).toBe('按日的报告单次最多取 120 天')
    expect(adsReportFailureText('ADS_ACCOUNT_MISSING', null)).toContain('广告账户编号')
    expect(adsReportFailureText('SOMETHING_ELSE', null)).toBe('任务失败（SOMETHING_ELSE）')
  })

  it('只有新报告接口的失败任务、且没有被重试过，才能重试', () => {
    expect(adsReportRetryable({ source: 'V1', status: 'FAILED' }, false)).toBe(true)
    expect(adsReportRetryable({ source: 'V1', status: 'FAILED' }, true)).toBe(false)
    expect(adsReportRetryable({ source: 'V1', status: 'READY' }, false)).toBe(false)
    expect(adsReportRetryable({ source: 'LEGACY', status: 'FAILED' }, false)).toBe(false)
  })
})

describe('广告报表：历史回补时间片', () => {
  it('往前推月数按日历月，月末落在当月最后一天内', () => {
    expect(monthsBefore('2026-10-20', 24)).toBe('2024-10-20')
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28')
    expect(monthsBefore('2026-13-01', 1)).toBeNull()
  })

  it('按 120 天切片，最近的片在前，片与片首尾相接、不重叠，最后一片从起点开始', () => {
    const windows = backfillWindowsOf('2026-10-20', 24)
    expect(windows.length).toBeGreaterThan(5)
    expect(windows.length).toBeLessThanOrEqual(ADS_BACKFILL_MAX_SLICES)
    expect(windows[0].to).toBe('2026-10-20')
    expect(windows[windows.length - 1].from).toBe('2024-10-20')
    for (let index = 1; index < windows.length; index += 1) {
      const nextDay = new Date(Date.parse(`${windows[index].to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      expect(nextDay).toBe(windows[index - 1].from)
    }
    for (const window of windows) expect(adsReportWindowIssue({ granularity: 'DAILY', ...window, today: '2026-10-20' })).toBeNull()
  })

  it('月数不合法返回空数组；25 个月不超过上限的片数', () => {
    expect(backfillWindowsOf('2026-10-20', 0)).toEqual([])
    expect(backfillWindowsOf('2026-10-20', 26)).toEqual([])
    expect(backfillWindowsOf('2026-10-20', 25).length).toBeLessThanOrEqual(ADS_BACKFILL_MAX_SLICES)
  })
})

describe('广告报表：请求校验', () => {
  it('创建：模板、日期格式必填，广告产品默认商品推广；多余字段拒绝', () => {
    const ok = AdsReportCreateBodySchema.parse({ profileId: 'p-1', templateKey: 'CAMPAIGN_DAILY', from: '2026-10-01', to: '2026-10-10' })
    expect(ok.adProduct).toBe('SPONSORED_PRODUCTS')
    expect(AdsReportCreateBodySchema.safeParse({ profileId: 'p-1', templateKey: 'NOPE', from: '2026-10-01', to: '2026-10-10' }).success).toBe(false)
    expect(AdsReportCreateBodySchema.safeParse({ profileId: 'p-1', templateKey: 'CAMPAIGN_DAILY', from: '10/01', to: '2026-10-10' }).success).toBe(false)
    expect(AdsReportCreateBodySchema.safeParse({ profileId: 'p-1', templateKey: 'CAMPAIGN_DAILY', from: '2026-10-01', to: '2026-10-10', reportType: 'x' }).success).toBe(false)
    expect(AdsReportCreateBodySchema.safeParse({ profileId: 'a b', templateKey: 'CAMPAIGN_DAILY', from: '2026-10-01', to: '2026-10-10' }).success).toBe(false)
  })

  it('回补：月数默认 24，最大 25；核对触发只要广告档案编号', () => {
    expect(AdsReportBackfillBodySchema.parse({ profileId: 'p-1' }).months).toBe(24)
    expect(AdsReportBackfillBodySchema.safeParse({ profileId: 'p-1', months: 26 }).success).toBe(false)
    expect(AdsParityRunBodySchema.safeParse({ profileId: 'p-1' }).success).toBe(true)
    expect(AdsParityRunBodySchema.safeParse({}).success).toBe(false)
  })

  it('列表：状态、来源、模板筛选；未知参数拒绝；只能按创建时间排序', () => {
    expect(AdsReportListQuerySchema.safeParse({ status: 'FAILED', source: 'V1', templateKey: 'PLACEMENT_DAILY' }).success).toBe(true)
    expect(AdsReportListQuerySchema.safeParse({ status: 'DONE' }).success).toBe(false)
    expect(AdsReportListQuerySchema.safeParse({ sort: 'status:asc' }).success).toBe(false)
    expect(AdsReportListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
  })
})
