import { useMemo } from 'react'
import { Alert, Card, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Asin360KpiCard, Asin360OverviewResponse, Asin360TableRow } from '@nova/api-contracts'
import { ChartPanel, Delta, MetricCard, MetricStrip, MetricTreeAttribution, SimpleGrid } from '../../components'
import { formatMoney, formatNumber } from '../../format'
import { Muted, STATE_LABEL, StateBlock } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { buildSalesOption } from './asin360-options'

// 经营表现页签（05 章 5.2）：指标卡（带对比期变化）→ 销售趋势（叠加变更事件）→ 同比环比表 → 变化归因 → 自然与广告拆分 → 利润与退款。
// 利润、转化率、广告占比没接入时写明“尚未接入”与负责的工作包，不显示 0；没有利润字段权限显示“无权查看”。

const GOOD_WHEN: Partial<Record<Asin360KpiCard['key'], 'up' | 'down'>> = { adsShare: 'down' }

function Card1({ card, currency, comparing }: { card: Asin360KpiCard; currency: string; comparing: boolean }) {
  const unavailable = card.state === 'OK' ? undefined : `${STATE_LABEL[card.state]}：${card.note ?? ''}`
  const ratio = card.changeKind === 'ratio'
  return (
    <MetricCard
      label={card.label}
      value={card.state === 'OK' ? card.value : null}
      format={card.format}
      currency={currency}
      mom={card.state === 'OK' && ratio && comparing ? card.change : undefined}
      goodWhen={GOOD_WHEN[card.key]}
      unavailableReason={unavailable}
      estimate={
        card.state === 'OK' && !ratio && comparing ? (
          <Delta label="较对比期（百分点）" ratio={card.change === null ? null : card.change * 100} goodWhen={GOOD_WHEN[card.key]} />
        ) : card.state === 'OK' && card.note ? (
          <Muted>{card.note}</Muted>
        ) : undefined
      }
    />
  )
}

const cell = (row: Asin360TableRow, value: number | null, currency: string) =>
  value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{row.format === 'money' ? formatMoney(value, currency, { digits: 2 }) : formatNumber(value, { digits: 0 })}</span>

function tableColumns(currency: string, data: Asin360OverviewResponse): ColumnsType<Asin360TableRow> {
  const change = (value: number | null) => <Delta label="" ratio={value} />
  return [
    { title: '指标', dataIndex: 'label', key: 'label' },
    { title: `本期（${data.period.from} 至 ${data.period.to}）`, key: 'current', align: 'right', render: (_, row) => cell(row, row.current, currency) },
    { title: `上一期（${data.previous.from} 至 ${data.previous.to}）`, key: 'previous', align: 'right', render: (_, row) => cell(row, row.previous, currency) },
    { title: '环比', key: 'mom', align: 'right', render: (_, row) => change(row.momChange) },
    { title: `去年同期（${data.yoy.from} 至 ${data.yoy.to}）`, key: 'yoy', align: 'right', render: (_, row) => cell(row, row.yoy, currency) },
    { title: '同比', key: 'yoyc', align: 'right', render: (_, row) => change(row.yoyChange) },
  ]
}

function Body({ id, data }: { id: string; data: Asin360OverviewResponse }) {
  const option = useMemo(() => buildSalesOption(data), [data])
  const comparing = data.compare !== null
  const { attribution } = data
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {!data.hasRows ? <Alert type="warning" showIcon message="所选范围内没有这个商品的订单记录" description="可能这段时间没有销售，也可能订单还没同步；下面的指标不会用 0 代替。" /> : null}
      {data.defaulted ? <Typography.Text type="secondary">未选择时间范围：默认显示近 30 天，并与上一期对比。</Typography.Text> : null}
      <MetricStrip>
        {data.cards.map(card => (
          <Card1 key={card.key} card={card} currency={data.currency} comparing={comparing} />
        ))}
      </MetricStrip>
      <ChartPanel
        title="销售趋势"
        ariaLabel="商品销售额趋势图"
        option={option}
        eventSource={{ objectType: 'ASIN', objectId: id }}
        emptyState={data.hasRows ? undefined : { kind: 'empty', domain: '这个商品的销售趋势', prerequisite: '所选范围内需要有订单记录（订单同步后显示）' }}
      />
      <Card size="small" title="环比与同比" data-testid="asin360-table">
        <SimpleGrid<Asin360TableRow>
          gridId="products.overview-tab"
          columns={tableColumns(data.currency, data)}
          rows={data.table}
          rowKey={row => row.key}
          emptyState={{ kind: 'empty', domain: '环比与同比', prerequisite: '需要这个商品有订单记录' }}
        />
      </Card>
      {attribution ? (
        <>
          <MetricTreeAttribution title="销售额" kind="product" factors={attribution.factors} formatTotal={value => formatMoney(value, data.currency, { digits: 2 })} />
          {attribution.unavailable.length ? <Typography.Text type="secondary">{attribution.unavailable.map(item => `${item.label}：${item.reason}`).join('；')}</Typography.Text> : null}
        </>
      ) : (
        <Alert type="info" showIcon message="变化归因" description={comparing ? '本期或对比期没有这个商品的订单记录，无法做变化归因。' : '没有选择对比期，无法做变化归因。'} />
      )}
      <Card size="small" title="自然销售与广告销售" data-testid="asin360-split">
        <StateBlock state={data.split.state} note={data.split.note}>
          <Space size={24} wrap>
            <span>
              广告销售额 <strong className="erp-num">{formatMoney(data.split.adsSales, data.currency, { digits: 2 })}</strong>
            </span>
            <span>
              自然销售额 {data.split.organicSales === null ? <Muted>无法拆分</Muted> : <strong className="erp-num">{formatMoney(data.split.organicSales, data.currency, { digits: 2 })}</strong>}
            </span>
          </Space>
          {data.split.note ? (
            <div>
              <Muted>{data.split.note}</Muted>
            </div>
          ) : null}
        </StateBlock>
      </Card>
      <Card size="small" title="利润与退款" data-testid="asin360-profit">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <StateBlock state={data.profit.state} note={data.profit.note}>
            <Muted>净利润与利润率见上方指标卡。</Muted>
          </StateBlock>
          <Alert type="info" showIcon message="退款趋势：尚未接入" description={data.refunds.note} />
        </Space>
      </Card>
    </Space>
  )
}

export function OverviewTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360OverviewResponse>(id, 'overview', { scoped: true })
  return <QueryBody query={query}>{data => <Body id={id} data={data} />}</QueryBody>
}
