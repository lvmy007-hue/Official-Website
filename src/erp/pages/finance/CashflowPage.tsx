import { useState } from 'react'
import { Alert, Card, Select, Space } from 'antd'
import { CASHFLOW_WEEKS_DEFAULT, CASHFLOW_WEEKS_MAX, type CashflowResponse } from '@nova/api-contracts'
import { DataState, FreshnessBar, PageHeader, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { FunnelSection } from './cashflow-funnel'
import { DisbursementsSection } from './cashflow-disbursements'
import { ForecastSection } from './cashflow-forecast'
import { BalancesSection, DeferralSection, PayoutSection } from './cashflow-sections'

// 回款与现金流（P2b-08，07 章 7.8）：账户余额（只有递延余额）、递延与释放、打款预测、按周现金流预测、到账核对。
// 数据口径：官方没有通用的账户余额接口，所以没有“可用余额”；预测是模型估算（近期日均净入账 × 结算周期 + 递延释放），不是亚马逊的承诺。
// 不同币种分别看，不做汇率换算；某个来源看不了或还没接入，就写明原因，不显示 0。

const WEEK_OPTIONS = [4, CASHFLOW_WEEKS_DEFAULT, CASHFLOW_WEEKS_MAX].map(value => ({ value, label: `未来 ${value} 周` }))

export default function CashflowPage() {
  const [currency, setCurrency] = useState<string | undefined>()
  const [weeks, setWeeks] = useState<number>(CASHFLOW_WEEKS_DEFAULT)
  const query = useApiQuery<CashflowResponse>({ domain: 'list', path: '/finance/cashflow', params: { currency, weeks } })
  const data = query.data
  const shown = data?.currency ?? currency ?? 'USD'
  const currencies = Array.from(new Set([...(data?.currencies ?? []), shown])).sort()

  return (
    <div>
      <PageHeader
        title="回款与现金流"
        description="看亚马逊欠你多少、什么时候打款、未来几周资金怎么进出，并核对实际到账。预测是按近期数据估算的，不是承诺；官方没有可用余额接口，这里只有递延余额。"
        actions={
          <Space wrap>
            <Select style={{ width: 110 }} aria-label="币种" value={shown} options={currencies.map(value => ({ value, label: value }))} onChange={value => setCurrency(value)} />
            <Select style={{ width: 120 }} aria-label="预测周数" value={weeks} options={WEEK_OPTIONS} onChange={value => setWeeks(value)} />
          </Space>
        }
      />
      <Card size="small">
        <FreshnessBar freshness={data?.freshness} />
        {query.error ? (
          <DataState {...stateFromError(describeError(query.error), { permission: 'finance.read', onRetry: () => void query.refetch() })} />
        ) : !data ? (
          <DataState kind="skeleton" rows={6} />
        ) : (
          <>
            {data.state === 'NO_DATA' && data.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.note} data-testid="cashflow-empty" /> : null}
            <p style={{ margin: '0 0 8px', color: 'rgba(0,0,0,0.65)' }}>
              数据截至 <span className="erp-num">{data.asOf}</span>（企业时区的今天）；金额单位 {data.currency}，其他币种请在右上角切换，不同币种不相加。
            </p>
            <BalancesSection balances={data.balances} />
            <DeferralSection deferral={data.deferral} currency={data.currency} />
            <PayoutSection payout={data.payout} currency={data.currency} />
            <FunnelSection currency={data.currency} />
            <ForecastSection forecast={data.forecast} noData={data.state === 'NO_DATA'} />
            <DisbursementsSection data={data.disbursements} onChanged={() => void query.refetch()} />
          </>
        )}
      </Card>
    </div>
  )
}
