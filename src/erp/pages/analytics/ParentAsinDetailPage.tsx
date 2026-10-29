import type { ReactNode } from 'react'
import { useParams } from '@tanstack/react-router'
import { Space } from 'antd'
import { PARENT_TABS, PARENT_TAB_LABEL, type ParentFigure, type ParentIdentityResponse, type ParentTab } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted, STATE_LABEL } from '../inventory/inventory-ui'
import { AdsTab, ChangesTab, InventoryTab, ReviewsTab } from './parent-tabs-more'
import { MatrixTab, TrafficTab, TrendTab } from './parent-tabs-core'

// 父体详情（P4-03，04 章 4.6）：身份区（子体数、销售额、转化率、净利润、有库存风险的子体数）与七个页签——
// 子体贡献矩阵、子体趋势、流量分布、库存与补货、广告覆盖、评论主题、变体结构变更历史。
// 页签只在被打开时才取数；库存页签要库存读取权限、广告页签要广告读取权限，没有就不显示；净利润与库存风险没有权限写“无权查看”，不是 0。

const BODY: Record<ParentTab, (props: { parentAsin: string }) => JSX.Element> = {
  matrix: MatrixTab,
  trend: TrendTab,
  traffic: TrafficTab,
  inventory: InventoryTab,
  ads: AdsTab,
  reviews: ReviewsTab,
  changes: ChangesTab,
}
const NEEDS: Partial<Record<ParentTab, string>> = { inventory: 'inventory.read', ads: 'ads.read' }

const figure = (item: ParentFigure, show: (value: number) => ReactNode): ReactNode =>
  item.state === 'OK' && item.value !== null ? (
    show(item.value)
  ) : (
    <span title={item.note ?? undefined}>
      <Muted>{STATE_LABEL[item.state] || '尚无记录'}</Muted>
    </span>
  )

export function identityMetrics(data: ParentIdentityResponse): IdentityMetric[] {
  const money = (value: number | null): ReactNode => (value === null ? <Muted>尚无记录</Muted> : formatMoney(value, 'USD', { digits: 2 }))
  return [
    { label: '子体数', value: <span className="erp-num">{formatNumber(data.childCount, { digits: 0 })}</span> },
    { label: '销售额', value: money(data.sales) },
    { label: '转化率', value: data.conversion === null ? <Muted>尚无记录</Muted> : formatPercent(data.conversion, { digits: 1 }) },
    { label: '净利润', value: figure(data.netProfit, value => formatMoney(value, 'USD', { digits: 2 })) },
    { label: '高/中库存风险子体', value: figure(data.riskChildren, value => formatNumber(value, { digits: 0 })) },
  ]
}

export function IdentityExtra({ data }: { data: ParentIdentityResponse }) {
  return (
    <Space size={16} wrap style={{ marginTop: 8 }} data-testid="parent-identity-extra">
      <span>品牌：{data.brand ?? <Muted>目录未给出</Muted>}</span>
      <span>类目：{data.category ?? <Muted>目录未给出</Muted>}</span>
      <span>变体维度：{data.variationTheme ?? <Muted>目录未给出</Muted>}</span>
      <span>店铺：{data.storeNames.length > 0 ? data.storeNames.join('、') : <Muted>尚无记录</Muted>}</span>
      {data.membersTruncated ? <Muted>子体超过上限，只统计销售额最高的部分</Muted> : null}
    </Space>
  )
}

export default function ParentAsinDetailPage() {
  const { parentAsin } = useParams({ strict: false }) as { parentAsin: string }
  const { canPermission } = useSession()
  const identity = useApiQuery<ParentIdentityResponse>({ domain: 'analytics', path: `/analytics/parents/${encodeURIComponent(parentAsin)}` })
  if (identity.error) return <DataState {...stateFromError(describeError(identity.error), { permission: 'analytics.read', onRetry: () => void identity.refetch() })} />
  if (identity.isPending || !identity.data) return <DataState kind="skeleton" rows={6} />
  const data = identity.data
  const statuses: StatusTag[] = data.state === 'NO_DATA' && data.note ? [{ text: '所选范围内没有销售与流量记录', color: 'warning' }] : []
  return (
    <DetailLayout
      title={data.title ?? `父体 ${data.parentAsin}`}
      subtitle={`${data.parentAsin} · ${data.childCount} 个子体`}
      imageUrl={data.imageUrl}
      statuses={statuses}
      metrics={identityMetrics(data)}
      identityExtra={<IdentityExtra data={data} />}
      freshness={{ lastSuccessAt: data.freshness.lastSuccessAt, sources: data.freshness.sources, qualityIssues: data.freshness.qualityIssues }}
      tabs={PARENT_TABS.filter(tab => !NEEDS[tab] || canPermission(NEEDS[tab]!)).map(tab => {
        const Body = BODY[tab]
        return { key: tab, label: PARENT_TAB_LABEL[tab], children: <Body parentAsin={data.parentAsin} /> }
      })}
    />
  )
}
