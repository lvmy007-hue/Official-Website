import { describe, expect, it } from 'vitest'
import {
  ADS_PARITY_CATEGORIES,
  ADS_STREAM_NO_SINK,
  ADS_PARITY_CATEGORY_LABEL,
  ADS_RECOMMENDATION_STATUSES,
  ADS_RECOMMENDATION_STATUS_LABEL,
  adsReportWindowIssue,
  adsStreamState,
  dayStamp,
  inRefetchWindow,
  inclusiveDays,
  sliceReportWindows,
} from './ads-connector.js'

const TODAY = '2026-10-23'
const check = (granularity: 'HOURLY' | 'DAILY' | 'MONTHLY', from: string, to: string) => adsReportWindowIssue({ granularity, from, to, today: TODAY })

describe('日期工具', () => {
  it('只认真实存在的日历日期', () => {
    expect(dayStamp('2026-02-28')).not.toBeNull()
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '', '20261001', '2026-10-23T00:00:00Z']) expect(dayStamp(bad), bad).toBeNull()
  })

  it('天数含起止两天，跨月跨年按日历算', () => {
    expect(inclusiveDays('2026-10-01', '2026-10-01')).toBe(1)
    expect(inclusiveDays('2026-02-01', '2026-03-01')).toBe(29)
    expect(inclusiveDays('2025-12-31', '2026-01-01')).toBe(2)
    expect(inclusiveDays('2026-10-02', '2026-10-01')).toBe(0)
    expect(inclusiveDays('bad', '2026-10-01')).toBeNull()
  })

  it('近 3 天回补区间只含今天与前两天', () => {
    expect(['2026-10-23', '2026-10-22', '2026-10-21'].map(day => inRefetchWindow(day, TODAY))).toEqual([true, true, true])
    expect(['2026-10-20', '2026-10-24', 'bad'].map(day => inRefetchWindow(day, TODAY))).toEqual([false, false, false])
  })
})

describe('报告时间范围检查（ADS_REPORT_WINDOW，前端先拦截）', () => {
  it('按日：120 天可以，121 天不行', () => {
    expect(check('DAILY', '2026-06-26', '2026-10-23')).toBeNull() // 120 天
    expect(check('DAILY', '2026-06-25', '2026-10-23')).toContain('最多取 120 天')
  })

  it('按小时：最多 14 天，而且只保留最近 14 天', () => {
    expect(check('HOURLY', '2026-10-10', '2026-10-23')).toBeNull()
    expect(check('HOURLY', '2026-10-09', '2026-10-23')).toContain('最多取 14 天')
    expect(check('HOURLY', '2026-10-01', '2026-10-05')).toContain('只保留最近 14 天')
  })

  it('按月：最多 25 个月（按日历月份，起止月都算）', () => {
    expect(check('MONTHLY', '2024-10-01', '2026-10-23')).toBeNull() // 25 个月
    expect(check('MONTHLY', '2024-09-30', '2026-10-23')).toContain('最多取 25 个月')
  })

  it('结束日期不能晚于今天，也不能早于开始日期，格式不对要说明', () => {
    expect(check('DAILY', '2026-10-01', '2026-10-24')).toContain('晚于今天')
    expect(check('DAILY', '2026-10-05', '2026-10-01')).toContain('早于开始日期')
    expect(check('DAILY', '10/01/2026', '2026-10-05')).toContain('YYYY-MM-DD')
  })
})

describe('历史回补切片', () => {
  it('按 120 天切片，相邻片首尾相接不重叠，最后一片到结束日', () => {
    const slices = sliceReportWindows('2026-01-01', '2026-10-23')
    expect(slices).toEqual([
      { from: '2026-01-01', to: '2026-04-30' },
      { from: '2026-05-01', to: '2026-08-28' },
      { from: '2026-08-29', to: '2026-10-23' },
    ])
    for (const slice of slices) expect(adsReportWindowIssue({ granularity: 'DAILY', ...slice, today: TODAY })).toBeNull()
  })

  it('一天与恰好一片都只有一片；范围不合法返回空', () => {
    expect(sliceReportWindows('2026-10-01', '2026-10-01')).toEqual([{ from: '2026-10-01', to: '2026-10-01' }])
    expect(sliceReportWindows('2026-06-26', '2026-10-23')).toHaveLength(1)
    expect(sliceReportWindows('2026-10-02', '2026-10-01')).toEqual([])
    expect(sliceReportWindows('bad', '2026-10-01')).toEqual([])
    expect(sliceReportWindows('2026-10-01', '2026-10-05', 0)).toEqual([])
  })
})

describe('状态与口径的标签', () => {
  it('每种推荐状态与核对差异类别都有中文名', () => {
    for (const status of ADS_RECOMMENDATION_STATUSES) expect(ADS_RECOMMENDATION_STATUS_LABEL[status]).toBeTruthy()
    expect(ADS_PARITY_CATEGORIES.map(category => ADS_PARITY_CATEGORY_LABEL[category])).toEqual(['时间口径', '归因口径', '范围', '未解释'])
  })
})

describe('adsStreamState', () => {
  it('没配置接收端就明说未接入，配置了才算已连接', () => {
    expect(adsStreamState({ sinkConfigured: true })).toEqual({ connected: true })
    const off = adsStreamState({ sinkConfigured: false })
    expect(off).toMatchObject({ connected: false, code: ADS_STREAM_NO_SINK })
    expect(JSON.stringify(off)).toContain('未接入')
  })
})
