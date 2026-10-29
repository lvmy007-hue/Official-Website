import type { ReactNode } from 'react'
import { Alert, Button, Descriptions, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import {
  ADS_BID_EFFECT_DAYS,
  type AdsBidChangeRow,
  type AdsBidEffectSide,
  type AdsTargetBidHistoryResponse,
  type AdsTargetBrandResponse,
  type AdsTargetPlacementResponse,
  type AdsTargetTermList,
  type AdsTargetTermRow,
} from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { Searchable } from './ads-campaign-tabs'
import { metricColumns, moneyCell, percentCell, TabNote } from './ads-campaigns-ui'

// 投放对象详情自己的页签（08 章 8.5）：带来的搜索词、广告位（没有投放对象级数据源）、竞价历史与效果（调价前后各 7 天对照）、品牌分析（仅关键词类，同步器随 P4-04）。
// 趋势与分时表现复用活动详情的组件。

const base = (id: string, tab: string) => `/ads/targets/${encodeURIComponent(id)}/${tab}`

export function TargetTermsTab({ id, currency }: { id: string; currency: string }) {
  const columns: ColumnsType<AdsTargetTermRow> = [
    { title: '搜索词', dataIndex: 'searchTerm', width: 260 },
    { title: '命中的投放表达式', dataIndex: 'matchedExpression', width: 220, render: (value: string | null) => value ?? <Muted>词级报表没有给</Muted> },
    ...metricColumns<AdsTargetTermRow>(currency),
  ]
  return (
    <Searchable<AdsTargetTermRow, AdsTargetTermList>
      path={base(id, 'search-terms')}
      columns={columns}
      rowKey={row => `${row.searchTerm}|${row.matchedExpression ?? ''}`}
      domain="搜索词"
      placeholder="搜索词包含"
      scrollX={1000}
    />
  )
}

export function TargetPlacementsTab({ id }: { id: string }) {
  const query = useApiQuery<AdsTargetPlacementResponse>({ domain: 'analytics', path: base(id, 'placements'), scoped: false })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  const data = query.data
  if (!data) return <DataState kind="skeleton" rows={3} />
  return (
    <div data-testid="target-placements">
      <TabNote state={data.state} note={data.note} />
      {data.campaignId ? <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(data.campaignId)}`}>去所属活动查看广告位表现</AppLink> : null}
    </div>
  )
}

/** 调价前后窗口的一格：花费、广告成本销售比、订单，并写明窗口里有指标的天数；没有数据显示“尚无记录”。 */
function effectCell(side: AdsBidEffectSide, currency: string): ReactNode {
  if (!side.totals) return <Muted>尚无记录</Muted>
  return (
    <div>
      <div>
        花费 {moneyCell(side.totals.spend, currency)} · 订单 <span className="erp-num">{side.totals.orders}</span>
      </div>
      <div>广告成本销售比 {percentCell(side.ratios?.acos)}</div>
      <Muted>
        {side.days} 天里有 {side.daysWithData} 天有数据
      </Muted>
    </div>
  )
}

const bidText = (value: number | null, currency: string) => (value === null ? <Muted>—</Muted> : moneyCell(value, currency))

export function BidHistoryTab({ id }: { id: string }) {
  const query = useApiQuery<AdsTargetBidHistoryResponse>({ domain: 'analytics', path: base(id, 'bid-history'), scoped: false })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  const data = query.data
  if (!data) return <DataState kind="skeleton" rows={4} />
  const { currency, bid, suggestedBid } = data.current
  const columns: ColumnsType<AdsBidChangeRow> = [
    { title: '时间', dataIndex: 'at', width: 150, render: (value: string) => formatDateTime(value) },
    { title: '操作人', dataIndex: 'actor', width: 110 },
    {
      title: '竞价',
      key: 'bid',
      width: 150,
      render: (_value, row) => (
        <span>
          {bidText(row.beforeBid, currency)} → {bidText(row.afterBid, currency)}
        </span>
      ),
    },
    { title: `调价前 ${ADS_BID_EFFECT_DAYS} 天`, key: 'before', width: 230, render: (_value, row) => effectCell(row.before, currency) },
    { title: `调价后 ${ADS_BID_EFFECT_DAYS} 天`, key: 'after', width: 230, render: (_value, row) => effectCell(row.after, currency) },
  ]
  return (
    <div data-testid="target-bid-history">
      <Descriptions size="small" bordered column={{ xs: 1, md: 3 }} title="当前竞价（来自最近一次同步）">
        <Descriptions.Item label="当前竞价">{bid === null ? <Muted>尚无记录</Muted> : moneyCell(bid, currency)}</Descriptions.Item>
        <Descriptions.Item label="官方建议竞价">
          {suggestedBid === null ? (
            <Muted>无推荐</Muted>
          ) : (
            <span>
              {suggestedBid.low !== null || suggestedBid.high !== null ? (
                <span>
                  {moneyCell(suggestedBid.low, currency)} ~ {moneyCell(suggestedBid.high, currency)}
                </span>
              ) : null}
              {suggestedBid.point !== null ? <span> 建议 {moneyCell(suggestedBid.point, currency)}</span> : null}
            </span>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="调价">
          <Tooltip title={data.write.note}>
            <span>
              <Button size="small" disabled>
                调整竞价
              </Button>
            </span>
          </Tooltip>
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 12 }}>
        <SimpleGrid<AdsBidChangeRow>
          gridId="advertising.ads-target-tabs"
          columns={columns}
          rows={data.changes.items}
          rowKey={row => row.id}
          loading={query.isFetching}
          emptyState={{ kind: 'empty', domain: '调价记录', prerequisite: data.changes.note ?? '本系统内还没有对这个投放对象调过价。' }}
        />
        {data.changes.truncated ? <Muted>只显示最近的调价记录。</Muted> : null}
      </div>
      <div style={{ marginTop: 8 }}>
        <TabNote state={data.amazonSide.state} note={`亚马逊侧与其他工具的调价：${data.amazonSide.note}`} />
      </div>
      <Alert type="info" showIcon style={{ marginTop: 8 }} message="效果对照不是因果结论：调价前后的季节、预算与竞争可能不同；调价当天不计入任何一边。" />
    </div>
  )
}

export function BrandAnalyticsTab({ id }: { id: string }) {
  const query = useApiQuery<AdsTargetBrandResponse>({ domain: 'analytics', path: base(id, 'brand-analytics'), scoped: false })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  const data = query.data
  if (!data) return <DataState kind="skeleton" rows={3} />
  return (
    <div data-testid="target-brand">
      <TabNote state={data.state} note={data.note} />
    </div>
  )
}
