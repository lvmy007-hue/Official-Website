import { Button, Space, Tooltip } from 'antd'
import { useParams } from '@tanstack/react-router'
import { type AdsTargetDetailResponse, type AdsTargetTabKey } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { HourlyTab, TrendTab } from './ads-campaign-tabs-more'
import { moneyCell, NONE } from './ads-campaigns-ui'
import { AccountLine, CampaignLine, entityMetrics, IdentityRow, stateTag } from './ads-entity-identity'
import { TargetWrites } from './ads-group-write'
import { BidHistoryTab, BrandAnalyticsTab, TargetPlacementsTab, TargetTermsTab } from './ads-target-tabs'

// 投放对象详情（P3-08，08 章 8.5）：身份区（表达式、类型、匹配方式、竞价与官方建议竞价、所属广告组与活动、关键指标带对比）→ 页签（趋势、带来的搜索词、广告位、分时表现、竞价历史与效果、品牌分析仅关键词类）。
// 调价、暂停与启用写亚马逊（P3-17）：先预览再提交（ads-group-write.tsx）；“设为否定”需要所属广告组的否定入口，请在词级详情里做，这里仍禁用并说明。

function TabBody({ tab, detail }: { tab: AdsTargetTabKey; detail: AdsTargetDetailResponse }) {
  const { id, currency } = detail.identity
  const root = `/ads/targets/${encodeURIComponent(id)}`
  switch (tab) {
    case 'trend':
      return <TrendTab id={id} path={`${root}/trend`} />
    case 'search-terms':
      return <TargetTermsTab id={id} currency={currency} />
    case 'placements':
      return <TargetPlacementsTab id={id} />
    case 'hourly':
      return <HourlyTab id={id} path={`${root}/hourly`} />
    case 'bid-history':
      return <BidHistoryTab id={id} />
    case 'brand-analytics':
      return <BrandAnalyticsTab id={id} />
  }
}

export default function AdsTargetDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<AdsTargetDetailResponse>({ domain: 'analytics', path: `/ads/targets/${encodeURIComponent(id)}` })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { identity } = detail
  return (
    <div data-testid="ads-target-detail">
      <DetailLayout
        title={identity.expression}
        subtitle={`${identity.kindLabel}${identity.matchType ? ` · ${identity.matchType}` : ''} · ${identity.account.name}${identity.account.storeName ? ` · ${identity.account.storeName}` : ''}`}
        statuses={[stateTag(identity.state)]}
        metrics={entityMetrics(detail.metrics, identity.currency, { label: '竞价', value: identity.bid === null ? NONE : moneyCell(identity.bid, identity.currency) })}
        freshness={{ lastSuccessAt: identity.syncedAt, sources: ['活动管理接口', '广告指标'], qualityIssues: 0 }}
        identityExtra={
          <IdentityRow>
            <span>
              所属广告组：
              {identity.adGroup.id ? (
                <AppLink to={`/app/advertising/ad-groups/${encodeURIComponent(identity.adGroup.id)}`}>{identity.adGroup.name ?? identity.adGroup.adGroupId}</AppLink>
              ) : (
                <Muted>广告组尚未同步</Muted>
              )}
            </span>
            <span>
              所属活动：
              <CampaignLine campaign={identity.campaign} />
            </span>
            <AccountLine account={identity.account} />
          </IdentityRow>
        }
        primaryActions={
          <Space wrap>
            <TargetWrites id={identity.id} state={identity.state} onDone={() => void query.refetch()} />
            <Tooltip title={detail.write.note}>
              <span>
                <Button disabled>设为否定</Button>
              </span>
            </Tooltip>
          </Space>
        }
        tabs={detail.tabs.map(tab => ({ key: tab.key, label: tab.label, children: <TabBody tab={tab.key} detail={detail} /> }))}
      />
    </div>
  )
}
