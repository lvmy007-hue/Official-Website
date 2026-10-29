import { useParams } from '@tanstack/react-router'
import { type AdsGroupDetailResponse, type AdsGroupTabKey } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { SearchTermsTab, TargetsTab } from './ads-campaign-tabs'
import { ChangesTab, HourlyTab, TrendTab } from './ads-campaign-tabs-more'
import { moneyCell, NONE } from './ads-campaigns-ui'
import { AccountLine, CampaignLine, entityMetrics, IdentityRow, stateTag } from './ads-entity-identity'
import { GroupProductsTab, NegativesTab } from './ads-group-tabs'
import { GroupWrites } from './ads-group-write'

// 广告组详情（P3-08，08 章 8.4）：身份区（所属活动、状态、默认竞价、关键指标带对比）→ 7 个页签（表现趋势、投放对象、搜索词、广告商品、否定投放、分时表现、操作记录）。
// 每个页签自己取数，切到才加载；投放对象与搜索词复用活动详情的页签。修改默认竞价、暂停与启用写亚马逊（P3-17）：先预览再提交（ads-group-write.tsx）；添加否定与关键词在词级详情里做。

function TabBody({ tab, detail }: { tab: AdsGroupTabKey; detail: AdsGroupDetailResponse }) {
  const { id, currency } = detail.identity
  const root = `/ads/ad-groups/${encodeURIComponent(id)}`
  switch (tab) {
    case 'trend':
      return <TrendTab id={id} path={`${root}/trend`} />
    case 'targets':
      return <TargetsTab id={id} currency={currency} root="ad-groups" />
    case 'search-terms':
      return <SearchTermsTab id={id} currency={currency} root="ad-groups" />
    case 'products':
      return <GroupProductsTab id={id} currency={currency} />
    case 'negatives':
      return <NegativesTab id={id} />
    case 'hourly':
      return <HourlyTab id={id} path={`${root}/hourly`} />
    case 'history':
      return <ChangesTab id={id} path={`${root}/history`} subject="广告组" />
  }
}

export default function AdsAdGroupDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<AdsGroupDetailResponse>({ domain: 'analytics', path: `/ads/ad-groups/${encodeURIComponent(id)}` })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { identity } = detail
  return (
    <div data-testid="ads-group-detail">
      <DetailLayout
        title={identity.name}
        subtitle={`广告组 · ${identity.account.name}${identity.account.storeName ? ` · ${identity.account.storeName}` : ''}`}
        statuses={[stateTag(identity.state)]}
        metrics={entityMetrics(detail.metrics, identity.currency, { label: '默认竞价', value: identity.defaultBid === null ? NONE : moneyCell(identity.defaultBid, identity.currency) })}
        freshness={{ lastSuccessAt: identity.syncedAt, sources: ['活动管理接口', '广告指标'], qualityIssues: 0 }}
        identityExtra={
          <IdentityRow>
            <span>
              所属活动：
              <CampaignLine campaign={identity.campaign} />
            </span>
            <AccountLine account={identity.account} />
          </IdentityRow>
        }
        primaryActions={<GroupWrites id={identity.id} state={identity.state} onDone={() => void query.refetch()} />}
        tabs={detail.tabs.map(tab => ({ key: tab.key, label: tab.label, children: <TabBody tab={tab.key} detail={detail} /> }))}
      />
    </div>
  )
}
