import type { ValueFormatterParams } from 'ag-grid-community'
import { LineChartOutlined } from '@ant-design/icons'
import { Button, Popover, Tooltip } from 'antd'
import type { AdsRatios, AdsTotals } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { TrendTab } from './ads-campaign-tabs-more'
import { moneyCell, numberCell, percentCell, NONE } from './ads-campaigns-ui'

// 广告层级页共用的指标列与“分析”图标列（P6-23）。指标列读行里的 totals / ratios（美元；没有指标行显示“尚无记录”，不是 0）；
// 每列都带 valueFormatter，汇总行（服务端口径）才能按同样的格式显示。

/** 汇总行的格式：币种固定美元（指标表与日汇总都只统计美元），比率按百分数。 */
export const SUMMARY_FORMAT = {
  money: { valueFormatter: (p: ValueFormatterParams) => formatMoney(p.value as number | null | undefined, 'USD', { digits: 2 }) },
  number: { valueFormatter: (p: ValueFormatterParams) => formatNumber(p.value as number | null | undefined, { digits: 0 }) },
  percent: (digits = 1) => ({ valueFormatter: (p: ValueFormatterParams) => formatPercent(p.value as number | null | undefined, { digits }) }),
  ratio: { valueFormatter: (p: ValueFormatterParams) => (typeof p.value === 'number' ? p.value.toFixed(2) : '—') },
}

export type LevelMetricRow = { totals: AdsTotals | null; ratios: AdsRatios | null; currency?: string }

const right = { ...RIGHT_ALIGNED }

/** 展示、点击、花费、销售额、订单、广告成本销售比、广告回报率、点击率、单次点击成本、转化率，统一放在“表现”分组里。 */
export function levelMetricColumns<T extends LevelMetricRow & object>(): ErpColDef<T>[] {
  const money = (row: T, value: number | null | undefined) => moneyCell(value, row.currency ?? 'USD')
  return [
    renderColumn<T>('展示', 'impressions', row => numberCell(row.totals?.impressions), { group: '表现', width: 100, ...SUMMARY_FORMAT.number, ...right }),
    renderColumn<T>('点击', 'clicks', row => numberCell(row.totals?.clicks), { group: '表现', width: 90, ...SUMMARY_FORMAT.number, ...right }),
    renderColumn<T>('花费', 'spend', row => money(row, row.totals?.spend), { group: '表现', width: 110, metric: 'M-007', ...SUMMARY_FORMAT.money, ...right }),
    renderColumn<T>('广告销售额', 'sales', row => money(row, row.totals?.sales), { group: '表现', width: 120, ...SUMMARY_FORMAT.money, ...right }),
    renderColumn<T>('订单', 'orders', row => numberCell(row.totals?.orders), { group: '表现', width: 90, ...SUMMARY_FORMAT.number, ...right }),
    renderColumn<T>('广告成本销售比', 'acos', row => percentCell(row.ratios?.acos), { group: '表现', width: 130, metric: 'M-501', ...SUMMARY_FORMAT.percent(), ...right }),
    renderColumn<T>('广告回报率', 'roas', row => (row.ratios?.roas == null ? NONE : <span className="erp-num">{row.ratios.roas.toFixed(2)}</span>), {
      group: '表现',
      width: 110,
      metric: 'M-502',
      ...SUMMARY_FORMAT.ratio,
      ...right,
    }),
    renderColumn<T>('点击率', 'ctr', row => percentCell(row.ratios?.ctr, 2), { group: '表现', width: 90, ...SUMMARY_FORMAT.percent(2), ...right }),
    renderColumn<T>('单次点击成本', 'cpc', row => money(row, row.ratios?.cpc), { group: '表现', width: 120, ...SUMMARY_FORMAT.money, ...right }),
    renderColumn<T>('转化率', 'cvr', row => percentCell(row.ratios?.cvr, 2), { group: '表现', width: 90, ...SUMMARY_FORMAT.percent(2), ...right }),
  ]
}

/** 汇总行用的列值：对象合计与比率摊平成列标识 → 数字（没有就是 null，显示“—”）。 */
export function summaryTotals(summary: { totals: AdsTotals; ratios: AdsRatios }): Record<string, number | null> {
  const { totals, ratios } = summary
  return {
    impressions: totals.impressions,
    clicks: totals.clicks,
    spend: totals.spend,
    sales: totals.sales,
    orders: totals.orders,
    acos: ratios.acos,
    roas: ratios.roas,
    ctr: ratios.ctr,
    cpc: ratios.cpc,
    cvr: ratios.cvr,
  }
}

export const ANALYSIS_COL_ID = 'analysis'

/**
 * 末列“分析”图标：点开显示该对象的趋势小窗（花费、广告销售额、点击与对比期）。
 * trendPathOf 返回 null（对象没有可查的编号）或整层不支持时（disabledReason），图标置灰并写明原因。
 */
export function analysisColumn<T extends object>(options: { trendPathOf?: (row: T) => string | null; disabledReason?: string; title?: (row: T) => string }): ErpColDef<T> {
  return renderColumn<T>(
    '分析',
    ANALYSIS_COL_ID,
    row => {
      const path = options.trendPathOf?.(row) ?? null
      if (!path) {
        return (
          <Tooltip title={options.disabledReason ?? '这个对象还没有可查的趋势'}>
            <span>
              <Button size="small" type="text" disabled aria-label="分析（不可用）" icon={<LineChartOutlined />} />
            </span>
          </Tooltip>
        )
      }
      return (
        <Popover
          trigger="click"
          placement="leftTop"
          title={options.title?.(row) ?? '趋势'}
          content={
            <div style={{ width: 620 }}>
              <TrendTab id="" path={path} />
            </div>
          }
          destroyTooltipOnHide
        >
          <Button size="small" type="text" aria-label="查看趋势" icon={<LineChartOutlined />} />
        </Popover>
      )
    },
    { group: '操作', pin: 'right', width: 72, sortable: false },
  )
}
