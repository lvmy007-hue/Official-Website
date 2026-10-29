import { useMemo } from 'react'
import { Alert, Card } from 'antd'
import type { SalesTaxResponse } from '@nova/api-contracts'
import { ChartPanel, DataState, FreshnessBar, PageHeader, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { buildSalesTaxTrendOption } from './sales-tax-options'
import { ReconSection, SourcesSection, StatesSection, StoreStatusSection, TotalsSection } from './sales-tax-sections'

// 销售税（P2b-12，07 章 7.11）：按州汇总平台代收代缴的税额、与订单接口的税额按月对账、月度趋势。
// 报告来自卖家后台“税务文档库”（不能由本系统生成，需要受限角色“税务汇缴”）；订单接口不含收货州，只能对总额。没有报告、没授权、没数据都写明原因，不显示 0。
// 日期范围用页面顶部的全局日期；没选默认最近 90 天，最多显示最近 14 个月。

function Body({ data }: { data: SalesTaxResponse }) {
  const trendOption = useMemo(() => buildSalesTaxTrendOption(data.trend), [data.trend])
  const trendEmpty = data.trend.every(point => point.reportTax === null && point.ordersTax === null)
  return (
    <>
      {data.state === 'NO_DATA' && data.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.note} data-testid="sales-tax-empty" /> : null}
      <p style={{ margin: '0 0 8px', color: 'rgba(0,0,0,0.65)' }} data-testid="sales-tax-range">
        统计范围 <span className="erp-num">{data.range.from}</span> ~ <span className="erp-num">{data.range.to}</span>
        {data.range.defaulted ? '（没选日期，默认最近 90 天）' : ''}
        {data.range.clamped ? '（范围超过 14 个月，只显示最近 14 个月）' : ''}；金额单位 {data.currency}。
      </p>
      <StoreStatusSection stores={data.stores} />
      <TotalsSection data={data} />
      <SourcesSection sources={data.sources} />
      <StatesSection data={data} />
      <ChartPanel
        title="月度趋势"
        ariaLabel="每月销售税合计：税务文档库报告与订单接口对比"
        option={trendOption}
        emptyState={trendEmpty ? { kind: 'empty', domain: '月度趋势', prerequisite: '所选范围内报告与订单接口都没有税额记录。' } : undefined}
      />
      <ReconSection rows={data.reconciliation} />
      <p style={{ marginTop: 8 }} data-testid="sales-tax-basis">
        <Muted>{data.basis}</Muted>
      </p>
    </>
  )
}

export default function SalesTaxPage() {
  const query = useApiQuery<SalesTaxResponse>({ domain: 'list', path: '/finance/sales-tax' })
  const data = query.data
  return (
    <div>
      <PageHeader title="销售税" description="按州查看亚马逊代收代缴的销售税，并与订单上的税额按月核对。报告需要先在卖家后台“税务文档库”生成；订单接口不含收货州，只能核对总额。" />
      <Card size="small">
        <FreshnessBar freshness={data?.freshness} />
        {query.error ? (
          <DataState {...stateFromError(describeError(query.error), { permission: 'finance.tax.read', onRetry: () => void query.refetch() })} />
        ) : !data ? (
          <DataState kind="skeleton" rows={6} />
        ) : (
          <Body data={data} />
        )}
      </Card>
    </div>
  )
}
