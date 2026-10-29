import { describe, expect, it, vi } from 'vitest'
import { AmazonSpApiClient } from './amazon-sp-api'
import { brandReportRequest, SQP_REPORT_TYPE } from './brand-report-options'

// 品牌分析报告的申请参数（P4-04）：reportPeriod 由起止日推出，日期只带日期；搜索查询表现另带 ASIN 列表（空格分隔、最多 200 个）。

const day = (text: string) => new Date(`${text}T00:00:00Z`)
const CATALOG = 'GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT'

describe('brandReportRequest', () => {
  it('不是品牌分析报告返回空', () => {
    expect(brandReportRequest('GET_SALES_AND_TRAFFIC_REPORT', day('2026-10-11'), day('2026-10-17'), [])).toBeNull()
  })

  it('周、月、季各推出对应的 reportPeriod，日期只带日期', () => {
    expect(brandReportRequest(CATALOG, day('2026-10-11'), day('2026-10-17'), [])).toEqual({ reportOptions: { reportPeriod: 'WEEK' }, dataStartTime: '2026-10-11', dataEndTime: '2026-10-17' })
    expect(brandReportRequest(CATALOG, day('2026-09-01'), day('2026-09-30'), [])?.reportOptions.reportPeriod).toBe('MONTH')
    expect(brandReportRequest(CATALOG, day('2026-07-01'), day('2026-09-30'), [])?.reportOptions.reportPeriod).toBe('QUARTER')
  })

  it('窗口不是对齐的周、月、季或缺失：不可重试错误 BA_PERIOD_INVALID', () => {
    for (const [from, to] of [
      [day('2026-10-12'), day('2026-10-18')],
      [day('2026-10-11'), day('2026-10-18')],
      [null, null],
    ] as const)
      expect(() => brandReportRequest(CATALOG, from, to, [])).toThrow(expect.objectContaining({ code: 'BA_PERIOD_INVALID' }))
  })

  it('搜索查询表现带 ASIN：去重、空格分隔、最多 200 个；没有商品时不可重试失败', () => {
    const asins = Array.from({ length: 250 }, (_, index) => `B${String(index).padStart(9, '0')}`)
    const request = brandReportRequest(SQP_REPORT_TYPE, day('2026-10-11'), day('2026-10-17'), [asins[0], ...asins])!
    const list = request.reportOptions.asin.split(' ')
    expect(list).toHaveLength(200)
    expect(new Set(list).size).toBe(200)
    expect(() => brandReportRequest(SQP_REPORT_TYPE, day('2026-10-11'), day('2026-10-17'), [])).toThrow(expect.objectContaining({ code: 'SCOPE_UNAVAILABLE' }))
    expect(brandReportRequest(CATALOG, day('2026-10-11'), day('2026-10-17'), asins)?.reportOptions.asin).toBeUndefined() // 其他四份报告不带 ASIN
  })
})

describe('createReport 申请体', () => {
  const client = () => {
    const sp = new AmazonSpApiClient({ encryptedRefreshToken: null } as never, { openAmazonToken: async () => '' } as never)
    const request = vi.spyOn(sp, 'request').mockResolvedValue({} as never)
    return { sp, body: () => (request.mock.calls[0]![0] as { body: Record<string, unknown> }).body }
  }

  it('品牌分析报告：选项与日期（只有日期）来自周期，覆盖通用的 30 天默认窗口', async () => {
    const { sp, body } = client()
    await sp.createReport(CATALOG, 'ATVPDKIKX0DER', { from: day('2026-10-11'), to: day('2026-10-17') }, brandReportRequest(CATALOG, day('2026-10-11'), day('2026-10-17'), []))
    expect(body()).toMatchObject({ reportType: CATALOG, reportOptions: { reportPeriod: 'WEEK' }, dataStartTime: '2026-10-11', dataEndTime: '2026-10-17' })
  })

  it('不带品牌参数的报告仍走原来的时间格式', async () => {
    const { sp, body } = client()
    await sp.createReport('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', 'ATVPDKIKX0DER', { from: day('2026-10-11'), to: day('2026-10-17') })
    expect(body().dataStartTime).toBe('2026-10-11T00:00:00.000Z')
    expect(body().reportOptions).toBeUndefined()
  })
})
