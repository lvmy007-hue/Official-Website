import { useMemo } from 'react'
import { Alert, Card, Descriptions, Space, Tag } from 'antd'
import type { CashflowFunnelResponse, FunnelReserve, FunnelStage } from '@nova/api-contracts'
import { EstimateTag, LocalGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { stageColumns } from './cashflow-columns'

// 回款增强（P6-20）：最近 90 天“入账 → 释放或递延 → 已公布打款 → 已到账或应收”的漏斗、回款率、未退还预留金。
// 没有来源的级别写“尚未接入”，不显示 0；各币种分别看，不换算；预留金没有记录就写“无预留金交易”，不拿 0 充数。

function ReserveBlock({ reserve, currency }: { reserve: FunnelReserve; currency: string }) {
  if (reserve.state !== 'OK') {
    return <Alert type="info" showIcon data-testid="funnel-reserve" message={reserve.state === 'NOT_CONNECTED' ? '预留金：尚未接入' : '预留金：无预留金交易'} description={reserve.note} />
  }
  return (
    <div data-testid="funnel-reserve">
      <Descriptions size="small" column={3} bordered>
        <Descriptions.Item label="未退还预留金">{money(reserve.unreturned ?? 0, currency)}</Descriptions.Item>
        <Descriptions.Item label="已扣留">{money(reserve.held ?? 0, currency)}</Descriptions.Item>
        <Descriptions.Item label="已返还">{money(reserve.returned ?? 0, currency)}</Descriptions.Item>
      </Descriptions>
      <Muted>{`${reserve.note}（${reserve.count} 笔）`}</Muted>
    </div>
  )
}

function FunnelBody({ data }: { data: CashflowFunnelResponse }) {
  const rate = data.payoutRate
  const columns = useMemo(() => stageColumns(data.currency), [data.currency])
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {data.state === 'NO_DATA' && data.note ? <Alert type="info" showIcon message={data.note} data-testid="funnel-empty" /> : null}
      <Space wrap size={12} data-testid="funnel-rate">
        <span>回款率</span>
        {rate.value === null ? (
          <Muted>暂无（{rate.note}）</Muted>
        ) : (
          <>
            <strong className="erp-num">{(rate.value * 100).toFixed(1)}%</strong>
            <Tag bordered={false}>{`已到账 ${money(rate.paid ?? 0, data.currency)} ÷ 已公布 ${money(rate.announced ?? 0, data.currency)}`}</Tag>
          </>
        )}
        <EstimateTag method="按结算单上的打款额与打款日统计，打款日已过的算已到账；实际到账以“到账核对”登记为准" />
      </Space>
      <LocalGrid<FunnelStage>
        gridId="finance.cashflow.funnel"
        columns={columns}
        rows={data.stages}
        getRowId={row => row.key}
        height={260}
        emptyState={{ kind: 'empty', domain: '回款漏斗', prerequisite: '尚无回款数据。' }}
      />
      <ReserveBlock reserve={data.reserve} currency={data.currency} />
      <Muted>
        窗口：<span className="erp-num">{data.from}</span> 至 <span className="erp-num">{data.to}</span>（最近 {data.windowDays} 天）。{data.assumptions.join(' ')}
      </Muted>
    </Space>
  )
}

export function FunnelSection({ currency }: { currency: string | undefined }) {
  const query = useApiQuery<CashflowFunnelResponse>({ domain: 'list', path: '/finance/cashflow/funnel', params: { currency } })
  return (
    <Card size="small" title="回款率与预留金" style={{ marginTop: 16 }} data-testid="cashflow-funnel">
      {query.error ? (
        <Alert type="warning" showIcon message="回款漏斗读取失败" description={describeError(query.error).message} />
      ) : !query.data ? (
        <Muted>读取中…</Muted>
      ) : (
        <FunnelBody data={query.data} />
      )}
    </Card>
  )
}
