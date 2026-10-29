import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import type { Asin360ActionsResponse, Asin360IdentityResponse, Asin360OverviewResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, EntityCollaboration, stateFromError } from '../../components'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { usePageObjectName } from '../../shell/page-title'
import { useProductQuery } from './asin360-hooks'
import { IdentityExtra, identityMetrics, statusTags, suggestionsOf } from './asin360-identity'
import { visibleSections } from './asin360-sections'

// ASIN 360（P2a-14；P6-21 改成锚点长页，16 章 3.1）：身份区（图片、品牌、类目、父体、排名、6 项关键指标）→ 建议动作 → 吸顶导航（日期与对比方式放在同一行，全页共用）→ 13 个板块。
// 板块只显示已上线且当前成员有权限的；没有来源的区块逐项写明“尚未接入”。板块进入视口前 200px 才挂载并取数，首屏只请求视口内的区块。
// 建议动作与关键指标在页面级取数（与板块共用同一份缓存）；头部关键指标仍跟随顶部全局范围栏。

export default function Asin360Page() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { canPermission } = useSession()
  const identity = useProductQuery<Asin360IdentityResponse>(id, '')
  const overview = useProductQuery<Asin360OverviewResponse>(id, 'overview', { scoped: true, enabled: identity.isSuccess })
  const actions = useProductQuery<Asin360ActionsResponse>(id, 'actions', { enabled: identity.isSuccess })
  // 页签标题显示“ASIN 360 · 商品名”（P6-01）
  usePageObjectName(identity.data?.product.title)
  const sections = useMemo(() => visibleSections(id, canPermission), [id, canPermission])

  if (identity.error) return <DataState {...stateFromError(describeError(identity.error), { permission: 'products.read', onRetry: () => void identity.refetch() })} />
  if (identity.isPending || !identity.data) return <DataState kind="skeleton" rows={6} />

  const data = identity.data
  const { product } = data
  return (
    <DetailLayout
      title={product.title}
      subtitle={`${product.sku} · ${product.asin}${product.fnsku ? ` · ${product.fnsku}` : ''} · ${product.storeName}`}
      imageUrl={product.imageUrl}
      statuses={statusTags(data)}
      metrics={identityMetrics(data, overview.data)}
      identityExtra={<IdentityExtra identity={data} rules={actions.data?.rules} />}
      freshness={{ lastSuccessAt: data.freshness.lastSuccessAt, sources: data.freshness.sources, qualityIssues: data.freshness.qualityIssues }}
      suggestions={suggestionsOf(actions.data)}
      sections={sections}
      sharedFilter
      rail={[{ key: 'collab', title: '评论与协作', children: <EntityCollaboration entityType="ASIN" entityId={id} /> }]}
    />
  )
}
