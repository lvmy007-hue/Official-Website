import { describe, expect, it } from 'vitest'
import { ADS_REPORT_TEMPLATE_KEYS } from './ads-reports'
import { DATASET_FRESHNESS_SOURCES, REPORT_FRESHNESS_SOURCES } from './freshness'
import { ReportCenterCreateBodySchema, ReportCenterListQuerySchema } from './report-center-query'
import { CREATABLE_REPORT_TYPES, REPORT_CATALOG, reportTypesOfDomain, spReportOf } from './report-center-catalog'
import { REPORT_DOMAINS, columnWarnings, reportCanCancel, reportCanRetry, reportFailureText, reportParseState, reportPeriodText } from './report-center'

describe('报表中心目录', () => {
  it('每一项的键在来源内唯一，导入器编号不为空，申请条件写明所需角色', () => {
    const keys = REPORT_CATALOG.map(item => `${item.source}:${item.key}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const item of REPORT_CATALOG) {
      expect(item.importer, item.key).toMatch(/^(R|D|A)-\d{2}$/)
      expect(item.requirement.length, item.key).toBeGreaterThan(8)
    }
  })

  it('覆盖已有导入器的全部报告类型：新鲜度登记的每个报告类型、广告模板、数据中心数据集都在目录里', () => {
    for (const source of REPORT_FRESHNESS_SOURCES) expect(spReportOf(source.reportType), source.reportType).toBeDefined()
    const ads = REPORT_CATALOG.filter(item => item.source === 'ADS').map(item => item.key)
    expect([...ads].sort()).toEqual([...ADS_REPORT_TEMPLATE_KEYS].sort())
    const kiosk = REPORT_CATALOG.filter(item => item.source === 'DATA_KIOSK').map(item => item.key)
    for (const source of DATASET_FRESHNESS_SOURCES) expect(kiosk).toContain(source.dataset)
    expect(kiosk).toContain('dk.economics-simulation')
  })

  it('六个业务域都有内容；只能检索的结算与销售税不在“可创建”里；有周期的类型都不是快照', () => {
    for (const domain of REPORT_DOMAINS)
      expect(
        REPORT_CATALOG.some(item => item.domain === domain),
        domain,
      ).toBe(true)
    expect(CREATABLE_REPORT_TYPES).not.toContain('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2')
    expect(CREATABLE_REPORT_TYPES).not.toContain('GET_FLAT_FILE_SALES_TAX_DATA')
    expect(spReportOf('GET_FLAT_FILE_SALES_TAX_DATA')?.mode).toBe('RETRIEVE')
    expect(CREATABLE_REPORT_TYPES).toContain('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA')
    expect(reportTypesOfDomain('BRAND')).toHaveLength(5)
    expect(spReportOf('GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT')?.period).toBe('BA_PERIOD')
    expect(spReportOf('GET_FBA_MYI_ALL_INVENTORY_DATA')?.period).toBe('SNAPSHOT')
    expect(spReportOf('NOT_A_REPORT')).toBeUndefined()
  })
})

describe('任务状态推导', () => {
  it('解析状态：完成即已解析；下载开始后失败算解析失败，之前失败仍是未开始', () => {
    expect(reportParseState('READY', [])).toBe('DONE')
    expect(reportParseState('FAILED', ['REQUESTED', 'SUBMITTED'])).toBe('NOT_STARTED')
    expect(reportParseState('FAILED', ['SUBMITTED', 'DOWNLOADING'])).toBe('FAILED')
    expect(reportParseState('GENERATING', ['DOWNLOADING'])).toBe('PARSING')
    expect(reportParseState('GENERATING', ['AMAZON_PROCESSING'])).toBe('NOT_STARTED')
    expect(reportParseState('CANCELLED', ['DOWNLOADING'])).toBe('NOT_STARTED')
  })

  it('取消只对没结束的 SP-API 任务；重试只对失败或已取消且没被重试过的 SP-API 任务', () => {
    expect(reportCanCancel('SP_API', 'PENDING')).toBe(true)
    expect(reportCanCancel('SP_API', 'GENERATING')).toBe(true)
    expect(reportCanCancel('SP_API', 'READY')).toBe(false)
    expect(reportCanCancel('ADS', 'PENDING')).toBe(false)
    expect(reportCanRetry('SP_API', 'FAILED', false)).toBe(true)
    expect(reportCanRetry('SP_API', 'CANCELLED', false)).toBe(true)
    expect(reportCanRetry('SP_API', 'FAILED', true)).toBe(false)
    expect(reportCanRetry('SP_API', 'READY', false)).toBe(false)
    expect(reportCanRetry('DATA_KIOSK', 'FAILED', false)).toBe(false)
  })

  it('失败原因：任务自己的说明优先，再查失败码，查不到写“原因未记录”', () => {
    expect(reportFailureText('FATAL', '亚马逊说：X')).toBe('亚马逊说：X')
    expect(reportFailureText('REPORT_ROWS_NOT_IMPORTED')).toContain('列名')
    expect(reportFailureText('AUTH_EXPIRED')).toBeTruthy()
    expect(reportFailureText('SOMETHING_ODD')).toContain('SOMETHING_ODD')
    expect(reportFailureText(null)).toBeNull()
  })

  it('数据周期文字', () => {
    expect(reportPeriodText('RANGE', '2026-10-01', '2026-10-07')).toBe('2026-10-01 至 2026-10-07')
    expect(reportPeriodText('RANGE', '2026-10-01', '2026-10-01')).toBe('2026-10-01')
    expect(reportPeriodText('SNAPSHOT', null, null)).toBe('当前快照')
    expect(reportPeriodText(null, null, null)).toBe('未记录')
  })

  it('字段变化：和上一份同类报告比，新出现与消失的字段各给一条；没有可比的上一份不产生警告', () => {
    expect(columnWarnings(['a', 'b', 'c'], ['a', 'b'])).toEqual([{ code: 'NEW_COLUMN', message: '新出现的字段：c' }])
    expect(columnWarnings(['a'], ['a', 'z'])).toEqual([{ code: 'MISSING_COLUMN', message: '上一份报告有、这一份没有的字段：z' }])
    expect(columnWarnings(['a', 'b'], ['a', 'b'])).toEqual([])
    expect(columnWarnings(['a'], null)).toEqual([])
    expect(columnWarnings([], ['a'])).toEqual([])
  })
})

describe('请求校验', () => {
  it('创建：只认目录里可创建的类型，站点固定美国站，日期格式要对，未知字段拒绝', () => {
    expect(ReportCenterCreateBodySchema.safeParse({ reportType: 'GET_AFN_INVENTORY_DATA' }).success).toBe(true)
    expect(ReportCenterCreateBodySchema.parse({ reportType: 'GET_AFN_INVENTORY_DATA' }).marketplaceId).toBe('ATVPDKIKX0DER')
    expect(ReportCenterCreateBodySchema.safeParse({ reportType: 'X' }).success).toBe(false)
    expect(ReportCenterCreateBodySchema.safeParse({ reportType: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' }).success).toBe(false)
    expect(ReportCenterCreateBodySchema.safeParse({ reportType: 'GET_AFN_INVENTORY_DATA', marketplaceId: 'A2EUQ1WTGCTBG2' }).success).toBe(false)
    expect(ReportCenterCreateBodySchema.safeParse({ reportType: 'GET_LEDGER_DETAIL_VIEW_DATA', from: '2026/10/01' }).success).toBe(false)
    expect(ReportCenterCreateBodySchema.safeParse({ reportType: 'GET_AFN_INVENTORY_DATA', extra: 1 }).success).toBe(false)
  })

  it('列表：业务域、状态、来源是枚举，未知参数拒绝', () => {
    expect(ReportCenterListQuerySchema.safeParse({ domain: 'BRAND', status: 'READY', source: 'SP_API' }).success).toBe(true)
    expect(ReportCenterListQuerySchema.safeParse({ domain: 'NOPE' }).success).toBe(false)
    expect(ReportCenterListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
  })
})
