import type { ReactNode } from 'react'
import { Button, Space, Tag, Tooltip } from 'antd'
import { useParams } from '@tanstack/react-router'
import { ADS_ADVICE_LABEL, type AdsAdviceHit, type AdsAdviceRule, type AdsCampaignDetailResponse, type AdsCampaignTabKey } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric, StatusTag, Suggestion } from '../../components/detail/DetailLayout'
import { formatDate } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { AdGroupsTab, AudiencesTab, CreativesTab, PlacementsTab, ProductsTab, SearchTermsTab, TargetsTab } from './ads-campaign-tabs'
import { DRILL } from './ads-drill-levels'
import { AdviceTab, ChangesTab, DismissButton, HistoryTab, HourlyTab, TrendTab } from './ads-campaign-tabs-more'
import { BudgetTimelineCard } from './ads-budget-timeline'
import { BulkAddAction } from './ads-bulk-add'
import { MetaAction } from './ads-campaigns-meta-action'
import { moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'

// 广告活动详情（P3-07，08 章 8.3）：身份区（≤6 项关键指标，带对比）→ 建议动作区（规则命中才出现，写明依据、预估影响、风险）→ 12 个页签（创意只有品牌与展示型推广，受众只有展示型推广）。
// 每个页签自己取数，切到才加载。建议里的写入动作（暂停、降价、否定、提高预算、采纳）写亚马逊，随“广告写入接入”（P3-17）提供，这里禁用并说明原因；“忽略官方推荐”是系统内标记，可以用。

const COMPARE_LABEL = { previous: '较上期', yoy: '较去年同期', custom: '较对比期' } as const
const ACTION_LABEL: Record<NonNullable<AdsAdviceHit['action']>, string> = { RAISE_BUDGET: '提高预算', LOWER_BID: '降低竞价或否定', NEGATE: '添加否定', PAUSE_PRODUCT: '暂停该商品广告', ADOPT: '采纳' }

const change = (current: number | null | undefined, previous: number | null | undefined): number | null =>
  current === null || current === undefined || previous === null || previous === undefined || previous === 0 ? null : current / previous - 1

function metricsOf(detail: AdsCampaignDetailResponse): IdentityMetric[] {
  const { metrics, identity } = detail
  const label = metrics.compare ? COMPARE_LABEL[metrics.compare.mode] : null
  const delta = (current: number | null | undefined, previous: number | null | undefined, goodWhen: 'up' | 'down') => (label ? { label, ratio: change(current, previous), goodWhen } : undefined)
  const none = metrics.totals === null
  return [
    { label: '花费', value: none ? NONE : moneyCell(metrics.totals?.spend, identity.currency), delta: delta(metrics.totals?.spend, metrics.previous?.spend, 'down') },
    { label: '广告销售额', value: none ? NONE : moneyCell(metrics.totals?.sales, identity.currency), delta: delta(metrics.totals?.sales, metrics.previous?.sales, 'up') },
    { label: '广告成本销售比', value: none ? NONE : percentCell(metrics.ratios?.acos), delta: delta(metrics.ratios?.acos, metrics.previousRatios?.acos, 'down') },
    { label: '订单', value: none ? NONE : numberCell(metrics.totals?.orders), delta: delta(metrics.totals?.orders, metrics.previous?.orders, 'up') },
    { label: '预算', value: identity.budget === null ? NONE : moneyCell(identity.budget, identity.currency) },
    { label: '广告销售占比', value: percentCell(metrics.adsShare) },
  ]
}

function statusesOf(detail: AdsCampaignDetailResponse): StatusTag[] {
  const { identity } = detail
  const state = identity.state.toUpperCase()
  return [
    {
      text: state === 'ENABLED' ? '启用中' : state === 'PAUSED' ? '已暂停' : state === 'ARCHIVED' ? '已归档' : identity.state,
      color: state === 'ENABLED' ? 'success' : state === 'PAUSED' ? 'warning' : 'default',
    },
    { text: identity.productLabel },
    ...(identity.servingStatus ? [{ text: `投放：${identity.servingStatus}` }] : []),
  ]
}

const ruleTag = (rule: AdsAdviceRule): ReactNode =>
  rule.state === 'HIT' ? (
    <Tag color="warning" bordered={false}>
      命中 {rule.hits.length}
    </Tag>
  ) : rule.state === 'NO_HIT' ? (
    <Tag bordered={false}>未命中</Tag>
  ) : (
    <Tag color="blue" bordered={false}>
      尚未接入
    </Tag>
  )

function actionOf(hit: AdsAdviceHit, writeNote: string): ReactNode {
  return (
    <Space size={4}>
      {hit.action ? (
        <Tooltip title={writeNote}>
          <span>
            <Button size="small" disabled>
              {ACTION_LABEL[hit.action]}
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {hit.recommendationId ? <DismissButton recommendationId={hit.recommendationId} /> : null}
    </Space>
  )
}

function suggestionsOf(detail: AdsCampaignDetailResponse): Suggestion[] {
  return detail.advice.flatMap(rule => rule.hits.map(hit => ({ id: hit.id, rule: hit.title, evidence: hit.evidence, impact: hit.impact, risk: hit.risk, action: actionOf(hit, detail.write.note) })))
}

function IdentityExtra({ detail }: { detail: AdsCampaignDetailResponse }) {
  const { identity, advice } = detail
  const hits = advice.reduce((total, rule) => total + rule.hits.length, 0)
  return (
    <div style={{ marginTop: 8, fontSize: 12 }} data-testid="campaign-identity-extra">
      <Space size={[12, 4]} wrap>
        <span>广告组合：{identity.portfolio ? (identity.portfolio.name ?? identity.portfolio.id) : <Muted>无</Muted>}</span>
        <span>投放方式：{identity.targetingType === 'AUTO' ? '自动' : identity.targetingType === 'MANUAL' ? '手动' : <Muted>未同步</Muted>}</span>
        <span>竞价策略：{identity.bidStrategy ?? <Muted>未同步</Muted>}</span>
        <span>
          起止：{identity.startDate ? formatDate(identity.startDate) : '—'} 至 {identity.endDate ? formatDate(identity.endDate) : '长期'}
        </span>
        <span>
          广告账户：{identity.account.name}（{identity.account.storeName ?? '未绑定店铺'}）
        </span>
        <span>
          <Tooltip title={identity.placementAdjustments.note}>
            <span>
              广告位调整：<Muted>尚未接入</Muted>
            </span>
          </Tooltip>
        </span>
        <span>负责人：{identity.owner ? identity.owner.name : <Muted>未指定</Muted>}</span>
        <span>
          标签：
          {identity.tags.length ? (
            identity.tags.map(tag => (
              <Tag key={tag} bordered={false}>
                {tag}
              </Tag>
            ))
          ) : (
            <Muted>无</Muted>
          )}
        </span>
      </Space>
      <details style={{ marginTop: 6 }} data-testid="advice-rules">
        <summary>建议规则（命中 {hits} 条；阈值是自定默认值，08 章没有给数）</summary>
        {advice.map(rule => (
          <div key={rule.kind} style={{ padding: '2px 0' }}>
            {ruleTag(rule)}
            <span>{rule.rule || ADS_ADVICE_LABEL[rule.kind]}</span>
            {rule.note ? <Muted>：{rule.note}</Muted> : null}
          </div>
        ))}
      </details>
      <BudgetTimelineCard id={identity.id} />
    </div>
  )
}

function TabBody({ tab, detail }: { tab: AdsCampaignTabKey; detail: AdsCampaignDetailResponse }) {
  const { id, currency } = detail.identity
  switch (tab) {
    case 'trend':
      return <TrendTab id={id} />
    case 'hourly':
      return <HourlyTab id={id} />
    case 'ad-groups':
      return <AdGroupsTab id={id} currency={currency} drill={DRILL} />
    case 'targets':
      return <TargetsTab id={id} currency={currency} drill={DRILL} />
    case 'search-terms':
      return <SearchTermsTab id={id} currency={currency} drill={DRILL} />
    case 'products':
      return <ProductsTab id={id} currency={currency} />
    case 'placements':
      return <PlacementsTab id={id} currency={currency} />
    case 'creatives':
      return <CreativesTab id={id} currency={currency} />
    case 'audiences':
      return <AudiencesTab id={id} currency={currency} />
    case 'history':
      return <HistoryTab id={id} />
    case 'advice':
      return <AdviceTab id={id} currency={currency} />
    case 'changes':
      return <ChangesTab id={id} />
  }
}

export default function AdsCampaignDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<AdsCampaignDetailResponse>({ domain: 'analytics', path: `/ads/campaigns/${encodeURIComponent(id)}` })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'ads.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { identity } = detail
  return (
    <div data-testid="ads-campaign-detail">
      <DetailLayout
        title={identity.name}
        subtitle={`${identity.productLabel} · ${identity.account.name}${identity.account.storeName ? ` · ${identity.account.storeName}` : ''}`}
        statuses={statusesOf(detail)}
        metrics={metricsOf(detail)}
        freshness={{ lastSuccessAt: identity.syncedAt, sources: ['活动管理接口', '广告日汇总'], qualityIssues: 0 }}
        identityExtra={<IdentityExtra detail={detail} />}
        primaryActions={
          <Space>
            <BulkAddAction mode="NEGATIVE" entityId={identity.id} level="CAMPAIGN" />
            <MetaAction targets={[{ id: identity.id, version: identity.version }]} members={detail.members} label="编辑标签与负责人" />
          </Space>
        }
        suggestions={suggestionsOf(detail)}
        tabs={detail.tabs.map(tab => ({ key: tab.key, label: tab.label, children: <TabBody tab={tab.key} detail={detail} /> }))}
      />
    </div>
  )
}
