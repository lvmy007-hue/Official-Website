import { useMemo } from 'react'
import { Alert, Button, Card, Descriptions, Space, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useSearch } from '@tanstack/react-router'
import {
  ADS_TERM_STATUS_LABEL,
  type AdsBidEffectSide,
  type AdTermBrandShare,
  type AdTermDetailResponse,
  type AdTermHistoryRow,
  type AdTermRelationRow,
  type AdTermTargetingRow,
} from '@nova/api-contracts'
import { ChartPanel, DataState, DetailLayout, stateFromError, SimpleGrid } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDateTime, formatNumber, formatPercent } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { moneyCell, NONE, numberCell, percentCell, TabNote } from './ads-campaigns-ui'
import { buildTermTrendOption } from './ad-terms-options'
import { AnomalyTags, STATUS_COLOR } from './ad-terms-ui'

// 词级分析页（P3-10，08 章 8.7）：一个词在全部活动里的趋势、与投放词的关系、同文字的投放与否定记录、规则建议、历史调价与效果；品牌分析份额只在 P4-04 的数据交付后出现。
// 否定、加词、调价写亚马逊，随“广告写入接入”（P3-17），按钮禁用并说明原因。没有数据的地方写“尚无记录”“尚未接入”。

const KIND_LABEL = { KEYWORD: '关键词', TARGET: '投放对象', NEGATIVE: '否定词' } as const

function effectCell(side: AdsBidEffectSide) {
  if (!side.totals) return <Muted>尚无记录</Muted>
  return (
    <div>
      <div>
        花费 {moneyCell(side.totals.spend)} · 订单 <span className="erp-num">{side.totals.orders}</span>
      </div>
      <div>广告成本销售比 {percentCell(side.ratios?.acos)}</div>
      <Muted>
        {side.days} 天里有 {side.daysWithData} 天有数据
      </Muted>
    </div>
  )
}

const relationColumns: ColumnsType<AdTermRelationRow> = [
  { title: '活动', key: 'campaign', width: 200, render: (_value, row) => row.campaignName ?? <span className="erp-num">{row.externalCampaignId}</span> },
  { title: '广告组', key: 'adGroup', width: 160, render: (_value, row) => row.adGroupName ?? row.adGroupId ?? <Muted>—</Muted> },
  { title: '带来它的投放词', dataIndex: 'targetExpression', width: 180, render: (value: string | null) => value ?? <Muted>—</Muted> },
  { title: '匹配方式', dataIndex: 'matchType', width: 100, render: (value: string | null) => value ?? <Muted>—</Muted> },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (_value, row) => (
      <Tag color={STATUS_COLOR[row.status]} bordered={false}>
        {ADS_TERM_STATUS_LABEL[row.status]}
      </Tag>
    ),
  },
  { title: '花费', key: 'spend', width: 100, align: 'right', render: (_value, row) => moneyCell(row.totals.spend) },
  { title: '广告销售额', key: 'sales', width: 110, align: 'right', render: (_value, row) => moneyCell(row.totals.sales) },
  { title: '订单', key: 'orders', width: 70, align: 'right', render: (_value, row) => numberCell(row.totals.orders) },
  { title: '点击', key: 'clicks', width: 80, align: 'right', render: (_value, row) => numberCell(row.totals.clicks) },
  { title: '广告成本销售比', key: 'acos', width: 120, align: 'right', render: (_value, row) => percentCell(row.ratios.acos) },
]

const targetingColumns: ColumnsType<AdTermTargetingRow> = [
  { title: '类型', dataIndex: 'kind', width: 100, render: (value: AdTermTargetingRow['kind']) => KIND_LABEL[value] },
  { title: '文字', dataIndex: 'expression', width: 200 },
  { title: '匹配方式', dataIndex: 'matchType', width: 120, render: (value: string | null) => value ?? <Muted>—</Muted> },
  { title: '竞价', dataIndex: 'bid', width: 100, align: 'right', render: (value: number | null) => moneyCell(value) },
  { title: '状态', dataIndex: 'state', width: 100, render: (value: string | null) => value ?? <Muted>—</Muted> },
  { title: '活动编号', dataIndex: 'externalCampaignId', width: 160, render: (value: string | null) => (value ? <span className="erp-num">{value}</span> : <Muted>—</Muted>) },
]

const historyColumns: ColumnsType<AdTermHistoryRow> = [
  { title: '时间', dataIndex: 'at', width: 150, render: (value: string) => formatDateTime(value) },
  { title: '投放词', dataIndex: 'expression', width: 160 },
  { title: '操作人', dataIndex: 'actor', width: 100 },
  {
    title: '竞价',
    key: 'bid',
    width: 150,
    render: (_value, row) => (
      <span>
        {moneyCell(row.beforeBid)} → {moneyCell(row.afterBid)}
      </span>
    ),
  },
  { title: '调价前', key: 'before', width: 220, render: (_value, row) => effectCell(row.before) },
  { title: '调价后', key: 'after', width: 220, render: (_value, row) => effectCell(row.after) },
]

/** 品牌分析份额：只在接口返回数据（P4-04 之后）时才渲染。 */
function BrandBlock({ brand }: { brand: AdTermBrandShare }) {
  const share = (value: number | null) => (value === null ? NONE : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>)
  return (
    <Descriptions size="small" bordered column={{ xs: 1, md: 3 }} data-testid="term-brand">
      <Descriptions.Item label="搜索量">{brand.searchVolume === null ? NONE : <span className="erp-num">{formatNumber(brand.searchVolume, { digits: 0 })}</span>}</Descriptions.Item>
      <Descriptions.Item label="点击份额">{share(brand.clickShare)}</Descriptions.Item>
      <Descriptions.Item label="购买份额">{share(brand.purchaseShare)}</Descriptions.Item>
      <Descriptions.Item label="数据周期">{brand.periodText ?? NONE}</Descriptions.Item>
      <Descriptions.Item label="最近更新">{brand.sourceUpdatedAt ? formatDateTime(brand.sourceUpdatedAt) : NONE}</Descriptions.Item>
    </Descriptions>
  )
}

function TrendBody({ data }: { data: AdTermDetailResponse }) {
  const option = useMemo(() => buildTermTrendOption(data.trend), [data.trend])
  if (data.trend.length === 0) return <TabNote state="NO_DATA" note="所选范围内没有这个词的逐日记录" />
  return (
    <div data-testid="term-trend">
      <ChartPanel title="花费、广告销售额与点击" ariaLabel="词级趋势" option={option} height={300} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        没有报表行的日期断开显示，不当 0。
      </Typography.Paragraph>
    </div>
  )
}

function AdviceBody({ data }: { data: AdTermDetailResponse }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title={`规则建议（${data.advice.length}）`} data-testid="term-advice">
        {data.advice.length === 0 ? (
          <Muted>当前数据没有命中任何建议规则</Muted>
        ) : (
          data.advice.map(item => (
            <div key={item.action} style={{ marginBottom: 6 }}>
              <Typography.Text strong>{item.label}</Typography.Text>
              <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>{item.reason}</div>
            </div>
          ))
        )}
      </Card>
      <Card size="small" title="历史动作与效果" data-testid="term-history">
        <TabNote state={data.history.state} note={data.history.note} />
        <SimpleGrid<AdTermHistoryRow>
          gridId="advertising.ad-term-detail-page"
          columns={historyColumns}
          rows={data.history.items}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '调价记录', prerequisite: data.history.note ?? '本系统内还没有对这个词的投放对象调过价。' }}
        />
        {data.history.truncated ? <Muted>只显示最近的调价记录。</Muted> : null}
        <Alert type="info" showIcon style={{ marginTop: 8 }} message="效果对照不是因果结论：调价前后的季节、预算与竞争可能不同；调价当天不计入任何一边。" />
      </Card>
    </Space>
  )
}

function Detail({ data }: { data: AdTermDetailResponse }) {
  const none = data.totals === null
  const metrics: IdentityMetric[] = [
    { label: '花费', value: none ? NONE : moneyCell(data.totals?.spend) },
    { label: '广告销售额', value: none ? NONE : moneyCell(data.totals?.sales) },
    { label: '广告成本销售比', value: none ? NONE : percentCell(data.ratios?.acos) },
    { label: '订单', value: none ? NONE : numberCell(data.totals?.orders) },
    { label: '点击', value: none ? NONE : numberCell(data.totals?.clicks) },
    { label: '转化率', value: none ? NONE : percentCell(data.ratios?.cvr) },
  ]
  const tabs = [
    { key: 'trend', label: '趋势', children: <TrendBody data={data} /> },
    {
      key: 'relations',
      label: '投放关系',
      children: (
        <div data-testid="term-relations">
          <SimpleGrid<AdTermRelationRow>
            gridId="advertising.ad-term-detail-page-2"
            columns={relationColumns}
            rows={data.relations.items}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '投放关系', prerequisite: '所选范围内没有这个词的词级报表记录。' }}
          />
          {data.relations.truncated ? <Muted>只显示花费最高的一部分关系。</Muted> : null}
        </div>
      ),
    },
    {
      key: 'targeting',
      label: '投放与否定记录',
      children: (
        <div data-testid="term-targeting">
          <TabNote state={data.targeting.state} note={data.targeting.note} />
          <SimpleGrid<AdTermTargetingRow>
            gridId="advertising.ad-term-detail-page-3"
            columns={targetingColumns}
            rows={data.targeting.items}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '投放与否定记录', prerequisite: data.targeting.note ?? '没有与这个词文字完全相同的关键词、投放表达式或否定词。' }}
          />
        </div>
      ),
    },
    { key: 'advice', label: '建议与历史', children: <AdviceBody data={data} /> },
    ...(data.brand ? [{ key: 'brand', label: '品牌分析', children: <BrandBlock brand={data.brand} /> }] : []),
  ]
  return (
    <div data-testid="ad-term-detail">
      <DetailLayout
        title={data.term}
        subtitle={`词级分析 · 美元账户${data.campaigns.total > 0 ? ` · 在 ${data.campaigns.total} 个活动里出现` : ''}`}
        statuses={data.status ? [{ text: ADS_TERM_STATUS_LABEL[data.status], color: data.status === 'TARGETED' ? 'success' : data.status === 'UNTARGETED' ? 'warning' : 'default' }] : []}
        metrics={metrics}
        identityExtra={
          <Space size={[12, 4]} wrap style={{ marginTop: 8, fontSize: 12 }}>
            <AppLink to="/app/ad-terms">返回词级中心</AppLink>
            <AnomalyTags anomalies={data.anomalies} />
          </Space>
        }
        primaryActions={
          <Tooltip title={data.write.note}>
            <span>
              <Button disabled>加为否定词</Button> <Button disabled>加为关键词</Button> <Button disabled>调整竞价</Button>
            </span>
          </Tooltip>
        }
        tabs={tabs}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }} data-testid="term-basis">
        {data.basis}
      </Typography.Paragraph>
    </div>
  )
}

function Loaded({ term }: { term: string }) {
  const query = useApiQuery<AdTermDetailResponse>({ domain: 'analytics', path: '/ads/terms/detail', params: { term } })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const data = query.data
  if (data.state !== 'OK' && data.totals === null && data.relations.items.length === 0 && data.targeting.items.length === 0) {
    return (
      <div data-testid="ad-term-detail">
        <Typography.Title level={4}>{data.term}</Typography.Title>
        <TabNote state={data.state} note={data.note} />
        <AppLink to="/app/ad-terms">返回词级中心</AppLink>
      </div>
    )
  }
  return <Detail data={data} />
}

export default function AdTermDetailPage() {
  const search = useSearch({ strict: false }) as { term?: string }
  const term = search.term?.trim()
  if (!term) return <DataState kind="empty" domain="词" prerequisite="请从词级中心选择一个词再查看分析。" />
  return <Loaded term={term} />
}
