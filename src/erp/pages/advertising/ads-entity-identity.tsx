import type { ReactNode } from 'react'
import { Space } from 'antd'
import type { AdsEntityAccount, AdsEntityMetricsBlock, AdsParentCampaign } from '@nova/api-contracts'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'

// 广告组详情与投放对象详情共用的身份区部件（P3-08）：关键指标（花费、广告销售额、广告成本销售比、订单、点击，带对比）、状态标签、所属活动与账户行。
// 没有指标行时一律写“尚无记录”，不补 0。

const COMPARE_LABEL = { previous: '较上期', yoy: '较去年同期', custom: '较对比期' } as const

const change = (current: number | null | undefined, previous: number | null | undefined): number | null =>
  current === null || current === undefined || previous === null || previous === undefined || previous === 0 ? null : current / previous - 1

/** 5 项共同的指标；调用方再补 1 项自己的（默认竞价、竞价），一共不超过 6 项。 */
export function entityMetrics(block: AdsEntityMetricsBlock, currency: string, extra: IdentityMetric): IdentityMetric[] {
  const label = block.compare ? COMPARE_LABEL[block.compare.mode] : null
  const delta = (current: number | null | undefined, previous: number | null | undefined, goodWhen: 'up' | 'down') => (label ? { label, ratio: change(current, previous), goodWhen } : undefined)
  const none = block.totals === null
  return [
    { label: '花费', value: none ? NONE : moneyCell(block.totals?.spend, currency), delta: delta(block.totals?.spend, block.previous?.spend, 'down') },
    { label: '广告销售额', value: none ? NONE : moneyCell(block.totals?.sales, currency), delta: delta(block.totals?.sales, block.previous?.sales, 'up') },
    { label: '广告成本销售比', value: none ? NONE : percentCell(block.ratios?.acos), delta: delta(block.ratios?.acos, block.previousRatios?.acos, 'down') },
    { label: '订单', value: none ? NONE : numberCell(block.totals?.orders), delta: delta(block.totals?.orders, block.previous?.orders, 'up') },
    { label: '点击', value: none ? NONE : numberCell(block.totals?.clicks), delta: delta(block.totals?.clicks, block.previous?.clicks, 'up') },
    extra,
  ]
}

export function stateTag(state: string): StatusTag {
  const upper = state.toUpperCase()
  return {
    text: upper === 'ENABLED' ? '启用中' : upper === 'PAUSED' ? '已暂停' : upper === 'ARCHIVED' ? '已归档' : state,
    color: upper === 'ENABLED' ? 'success' : upper === 'PAUSED' ? 'warning' : 'default',
  }
}

/** 所属活动：已同步的链到活动详情，没同步的只写外部编号。 */
export function CampaignLine({ campaign }: { campaign: AdsParentCampaign }) {
  return campaign.id ? (
    <AppLink to={`/app/advertising/campaigns/${encodeURIComponent(campaign.id)}`}>{campaign.name ?? campaign.externalCampaignId}</AppLink>
  ) : (
    <span>
      <span className="erp-num">{campaign.externalCampaignId}</span> <Muted>（活动尚未同步）</Muted>
    </span>
  )
}

export function AccountLine({ account }: { account: AdsEntityAccount }) {
  return (
    <span>
      广告账户：{account.name}（{account.storeName ?? '未绑定店铺'}）
    </span>
  )
}

export function IdentityRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <Space size={[12, 4]} wrap>
        {children}
      </Space>
    </div>
  )
}
