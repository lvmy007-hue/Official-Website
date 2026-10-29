import { useMemo, useState } from 'react'
import { Alert, Card, Descriptions, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  BA_PERIOD_LABEL,
  type Asin360CompetitorSlot,
  type Asin360CompetitorsResponse,
  type Asin360CompetitorTerm,
  type Asin360IdentityResponse,
  type Asin360PricingResponse,
} from '@nova/api-contracts'
import { ChartPanel, SimpleGrid } from '../../components'
import { formatDateTime, formatMoney } from '../../format'
import { countText, percentText } from '../analytics/brand-options'
import { Muted, StateBlock } from '../inventory/inventory-ui'
import { ShareTrendPanel } from '../analytics/share-trend-panel'
import { QueryBody, useProductQuery } from './asin360-hooks'
import { PendingSections, PeriodPicker, type PeriodChoice } from './asin360-panels'
import { buildPricingOption } from './asin360-traffic-options'

// ASIN 360 价格与推荐报价、竞品页签（05 章 5.2，P4-08）。
// 价格页签只有我方自己的数据：成交均价（订单口径）、购物车获得率、最近一次标价；推荐报价价格、竞争报价、价格历史要等定价接口（P4-11）。
// 竞品页签只对照品牌分析“热门搜索词”里这个 ASIN 核心搜索词点击份额前三的商品；关注竞品监控要等 P4-12。

function PricingBody({ data }: { data: Asin360PricingResponse }) {
  const option = useMemo(() => buildPricingOption(data.daily.points, data.currency), [data.daily.points, data.currency])
  const { listPrice, daily } = data
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Muted>
        统计范围：{data.range.from} 至 {data.range.to}
        {data.range.defaulted ? '（默认最近 30 天）' : ''}
      </Muted>
      <Descriptions size="small" bordered column={{ xs: 1, md: 3 }} data-testid="asin360-pricing-summary">
        <Descriptions.Item label="当前标价">
          {listPrice.value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(listPrice.value, listPrice.currency, { digits: 2 })}</span>}
          {listPrice.updatedAt ? <Muted>（{formatDateTime(listPrice.updatedAt)} 同步）</Muted> : null}
        </Descriptions.Item>
        <Descriptions.Item label="成交均价（范围内）">
          {daily.avgPrice === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(daily.avgPrice, data.currency, { digits: 2 })}</span>}
        </Descriptions.Item>
        <Descriptions.Item label="购物车获得率（范围内）">{percentText(daily.buyBoxPct)}</Descriptions.Item>
      </Descriptions>
      <StateBlock state={daily.state} note={daily.note}>
        <ChartPanel title="成交均价与购物车获得率" ariaLabel="商品价格趋势图" option={option} />
      </StateBlock>
      <PendingSections sections={data.pending} />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function PricingTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360PricingResponse>(id, 'pricing', { scoped: true })
  return <QueryBody query={query}>{data => <PricingBody data={data} />}</QueryBody>
}

function SlotCell({ slot }: { slot: Asin360CompetitorSlot | undefined }) {
  if (!slot || !slot.asin) return <Muted>尚无记录</Muted>
  return (
    <Space direction="vertical" size={0}>
      <span>
        <span className="erp-num">{slot.asin}</span>
        {slot.isSelf ? (
          <Tag color="green" bordered={false} style={{ marginInlineStart: 4 }}>
            本品
          </Tag>
        ) : slot.isOwn ? (
          <Tag color="blue" bordered={false} style={{ marginInlineStart: 4 }}>
            我方
          </Tag>
        ) : null}
      </span>
      <Muted>
        点击 {percentText(slot.clickShare)} · 转化 {percentText(slot.conversionShare)}
      </Muted>
      {slot.title ? <Muted>{slot.title}</Muted> : null}
    </Space>
  )
}

const competitorColumns: ColumnsType<Asin360CompetitorTerm> = [
  { title: '搜索词', dataIndex: 'searchTerm', key: 'term', width: 160 },
  { title: '搜索频率排名', key: 'rank', width: 110, align: 'right', render: (_value, row) => countText(row.frequencyRank) },
  ...([1, 2, 3] as const).map(rank => ({
    title: `点击第 ${rank} 名`,
    key: `slot-${rank}`,
    render: (_value: unknown, row: Asin360CompetitorTerm) => <SlotCell slot={row.slots.find(slot => slot.rank === rank)} />,
  })),
  {
    title: '本品名次',
    key: 'self',
    width: 100,
    render: (_value: unknown, row: Asin360CompetitorTerm) => (row.selfRank ? <Tag color="green">第 {row.selfRank} 名</Tag> : <Muted>不在前三</Muted>),
  },
]

function CompetitorsBody({ data, asin, choice, onChoice }: { data: Asin360CompetitorsResponse; asin?: string; choice: PeriodChoice; onChoice: (next: PeriodChoice) => void }) {
  const { terms } = data
  const period = terms.period
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Card
        size="small"
        title="核心搜索词的点击前三商品（品牌分析热门搜索词）"
        extra={<PeriodPicker value={{ period: period?.kind ?? choice.period, periodStart: choice.periodStart }} available={period?.available ?? []} onChange={onChoice} />}
        data-testid="asin360-competitor-terms"
      >
        <StateBlock state={terms.state} note={terms.note}>
          {period ? (
            <Muted>
              {BA_PERIOD_LABEL[period.kind]}周期：{period.start}
            </Muted>
          ) : null}
          {terms.state === 'OK' && terms.note ? <Alert type="info" showIcon message={terms.note} style={{ marginBottom: 8 }} /> : null}
          <SimpleGrid<Asin360CompetitorTerm>
            gridId="products.asin360-market"
            columns={competitorColumns}
            rows={terms.rows}
            rowKey={row => row.searchTerm}
            emptyState={{ kind: 'empty', domain: '热门搜索词', prerequisite: terms.note ?? '核心搜索词都不在热门搜索词里。' }}
          />
        </StateBlock>
      </Card>
      <ShareTrendPanel asin={asin} />
      <PendingSections sections={data.pending} />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function CompetitorsTab({ id }: { id: string }) {
  const [choice, setChoice] = useState<PeriodChoice>({ period: 'WEEK', periodStart: undefined })
  const identity = useProductQuery<Asin360IdentityResponse>(id, '')
  const query = useProductQuery<Asin360CompetitorsResponse>(id, 'competitors', { params: { period: choice.period, periodStart: choice.periodStart } })
  return <QueryBody query={query}>{data => <CompetitorsBody data={data} asin={identity.data?.product.asin} choice={choice} onChoice={setChoice} />}</QueryBody>
}
