import { describe, expect, it } from 'vitest'
import type { ListingTrendPoint } from '@nova/api-contracts'
import { buildListingTrendOption, formatTrendValue } from './listing-perf-options'

const points: ListingTrendPoint[] = [
  { date: '2026-10-01', sessions: 100, pageViews: 150, units: 10, sales: 200, conversion: 0.1, buyBox: 0.9 },
  { date: '2026-10-02', sessions: null, pageViews: null, units: null, sales: null, conversion: null, buyBox: null },
]

const seriesOf = (option: ReturnType<typeof buildListingTrendOption>) =>
  (Array.isArray(option.series) ? option.series : [option.series])[0] as { type: string; name: string; data: Array<number | null> }

describe('buildListingTrendOption', () => {
  it('会话、销量、销售额画柱；转化率与购物车获得率画线；没有记录的日子保持 null，不补 0', () => {
    for (const metric of ['sessions', 'pageViews', 'units', 'sales'] as const) expect(seriesOf(buildListingTrendOption(points, metric)).type).toBe('bar')
    for (const metric of ['conversion', 'buyBox'] as const) expect(seriesOf(buildListingTrendOption(points, metric)).type).toBe('line')
    expect(seriesOf(buildListingTrendOption(points, 'sessions')).data).toEqual([100, null])
    expect(seriesOf(buildListingTrendOption(points, 'sales')).name).toBe('销售额')
  })

  it('提示里的数值：销售额带美元符号，比率带百分号，其余是整数', () => {
    expect(formatTrendValue('sales', 200)).toBe('$200.00')
    expect(formatTrendValue('conversion', 0.1)).toBe('10.0%')
    expect(formatTrendValue('sessions', 1234)).toContain('1,234')
  })
})
