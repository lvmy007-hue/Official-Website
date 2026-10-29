import type { ReactNode } from 'react'
import { Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ADS_PORTFOLIO_KIND_LABEL, ADS_PORTFOLIO_PACE_LABEL, type AdsPortfolioPace, type AdsPortfolioPaceVerdict, type AdsPortfolioRow } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'

// 广告组合列表的列与共用的小部件（P3-11，08 章 8.8）：预算上限与周期、已用金额、实际与理想节奏、活动数、所选范围的关键指标。
// 没有数据写“尚无记录”，算不出节奏写原因（不是 0%）；非美元组合的指标不折算，写“非美元不折算”。

const VERDICT_COLOR: Record<AdsPortfolioPaceVerdict, 'warning' | 'success' | 'processing'> = { AHEAD: 'warning', ON_TRACK: 'success', BEHIND: 'processing' }
const BLOCKED_LABEL: Record<Exclude<AdsPortfolioPace['state'], 'OK'>, string> = {
  NO_BUDGET: '未设预算上限',
  UNKNOWN_PERIOD: '周期未知',
  OTHER_CURRENCY: '非美元不计算',
  NO_SPEND_DATA: '尚无花费数据',
  NOT_STARTED: '周期未开始',
}

/** 节奏标签：算出来是偏快、正常、偏慢；算不出来写原因并把详细说明放进悬浮提示。 */
export function PaceTag({ pace }: { pace: AdsPortfolioPace }) {
  if (pace.state === 'OK' && pace.verdict) {
    return (
      <Tooltip title={pace.note}>
        <Tag color={VERDICT_COLOR[pace.verdict]} bordered={false}>
          {ADS_PORTFOLIO_PACE_LABEL[pace.verdict]}
        </Tag>
      </Tooltip>
    )
  }
  if (pace.state === 'OK') return <Muted>理想累计为 0</Muted>
  return (
    <Tooltip title={pace.note}>
      <span>
        <Muted>{BLOCKED_LABEL[pace.state]}</Muted>
      </span>
    </Tooltip>
  )
}

/** 指标格：非美元组合的指标不折算，没有汇总行写“尚无记录”。 */
const metricOf = (row: AdsPortfolioRow, render: () => ReactNode): ReactNode =>
  row.totals === null && row.currency !== 'USD' ? (
    <Tooltip title="广告日汇总只含美元，非美元组合的指标不折算">
      <span>
        <Muted>非美元不折算</Muted>
      </span>
    </Tooltip>
  ) : (
    render()
  )

const roasCell = (value: number | null | undefined): ReactNode => (value === null || value === undefined ? NONE : <span className="erp-num">{value.toFixed(2)}</span>)

export function BudgetCell({ row }: { row: AdsPortfolioRow }) {
  const { budget } = row
  if (budget.cap === null) return NONE
  return (
    <div>
      <div>{moneyCell(budget.cap, row.currency)}</div>
      <Tooltip title={budget.issue}>
        <span style={{ fontSize: 12 }}>
          <Muted>
            {ADS_PORTFOLIO_KIND_LABEL[budget.kind]}
            {budget.from && budget.to ? ` ${budget.from} 至 ${budget.to}` : ''}
          </Muted>
        </span>
      </Tooltip>
    </div>
  )
}

export function SpentCell({ row }: { row: AdsPortfolioRow }) {
  const cap = row.budget.cap
  return (
    <div>
      <div>{moneyCell(row.spent, row.currency)}</div>
      {cap !== null && cap > 0 && row.spent !== null ? (
        <span style={{ fontSize: 12 }}>
          <Muted>占上限 {percentCell(row.spent / cap)}</Muted>
        </span>
      ) : null}
    </div>
  )
}

export function PaceCell({ row }: { row: AdsPortfolioRow }) {
  const { pace } = row
  return (
    <div>
      <PaceTag pace={pace} />
      {pace.state === 'OK' && pace.idealSpent !== null ? (
        <div style={{ fontSize: 12 }}>
          <Muted>
            理想 {moneyCell(pace.idealSpent, row.currency)}
            {pace.ratio !== null ? <>，节奏比 {percentCell(pace.ratio)}</> : null}
          </Muted>
        </div>
      ) : null}
      {pace.state === 'OK' ? (
        <div style={{ fontSize: 12 }}>
          <Muted>
            已过 {pace.elapsedDays} / {pace.totalDays ?? '-'} 天
          </Muted>
        </div>
      ) : null}
    </div>
  )
}

export function portfolioColumns(): ColumnsType<AdsPortfolioRow> {
  return [
    {
      title: '广告组合',
      key: 'name',
      width: 240,
      fixed: 'left',
      render: (_value, row) => (
        <div>
          <AppLink to={`/app/advertising/portfolios/${encodeURIComponent(row.id)}`}>{row.name}</AppLink>
          <div style={{ fontSize: 12 }}>
            <Muted>
              {row.accountName}
              {row.storeName ? ` · ${row.storeName}` : ' · 未绑定店铺'}
            </Muted>
          </div>
        </div>
      ),
    },
    { title: '预算上限与周期', key: 'budget', width: 200, render: (_value, row) => <BudgetCell row={row} /> },
    { title: '已用金额', key: 'spent', width: 130, align: 'right', render: (_value, row) => <SpentCell row={row} /> },
    { title: '预算节奏', key: 'pace', width: 190, render: (_value, row) => <PaceCell row={row} /> },
    {
      title: '活动数',
      key: 'campaigns',
      width: 100,
      align: 'right',
      render: (_value, row) => (
        <Tooltip title="启用中 / 全部活动">
          <span className="erp-num">
            {row.campaigns.enabled} / {row.campaigns.total}
          </span>
        </Tooltip>
      ),
    },
    { title: '范围内花费', key: 'spend', width: 110, align: 'right', render: (_value, row) => metricOf(row, () => moneyCell(row.totals?.spend)) },
    { title: '广告销售额', key: 'sales', width: 110, align: 'right', render: (_value, row) => metricOf(row, () => moneyCell(row.totals?.sales)) },
    { title: '广告成本销售比', key: 'acos', width: 120, align: 'right', render: (_value, row) => metricOf(row, () => percentCell(row.ratios?.acos)) },
    { title: '广告回报率', key: 'roas', width: 100, align: 'right', render: (_value, row) => metricOf(row, () => roasCell(row.ratios?.roas)) },
    { title: '订单', key: 'orders', width: 80, align: 'right', render: (_value, row) => metricOf(row, () => numberCell(row.totals?.orders)) },
  ]
}
