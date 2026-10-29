import { Descriptions, Tabs } from 'antd'
import { ADS_TERM_STATUS_LABEL, ratiosOf, type AdsTermStatus } from '@nova/api-contracts'
import { AppLink } from '../../nav/AppLink'
import { SearchTermsTab, TargetsTab } from './ads-campaign-tabs'
import { TrendTab } from './ads-campaign-tabs-more'
import { moneyCell, NONE, numberCell, percentCell } from './ads-campaigns-ui'
import { TermLink } from './ad-terms-ui'
import { TargetTermsTab } from './ads-target-tabs'
import type { DrillFactories } from './ads-drill-link'

// 活动详情的弹窗下钻层（P6-23）：广告组 → 投放 → 搜索词，每一层都带“打开完整页面”的入口；活动详情本身仍是整页。
// 广告组层：投放对象与搜索词两个页签（沿用广告组详情的同一套列表，点投放继续下钻）；投放层：带来的搜索词与趋势；搜索词层：该词在这个范围内的表现与词级分析入口。

function GroupBody({ id, currency }: { id: string; currency: string }) {
  return (
    <div data-testid="drill-ad-group">
      <div style={{ marginBottom: 8 }}>
        <AppLink to={`/app/advertising/ad-groups/${encodeURIComponent(id)}`}>打开广告组完整页面</AppLink>
      </div>
      <Tabs
        items={[
          { key: 'targets', label: '投放对象', children: <TargetsTab id={id} currency={currency} root="ad-groups" drill={DRILL} /> },
          { key: 'search-terms', label: '搜索词', children: <SearchTermsTab id={id} currency={currency} root="ad-groups" drill={DRILL} /> },
        ]}
      />
    </div>
  )
}

function TargetBody({ id, currency }: { id: string; currency: string }) {
  return (
    <div data-testid="drill-target">
      <div style={{ marginBottom: 8 }}>
        <AppLink to={`/app/advertising/targets/${encodeURIComponent(id)}`}>打开投放对象完整页面</AppLink>
      </div>
      <Tabs
        items={[
          { key: 'search-terms', label: '带来的搜索词', children: <TargetTermsTab id={id} currency={currency} /> },
          { key: 'trend', label: '趋势', children: <TrendTab id={id} path={`/ads/targets/${encodeURIComponent(id)}/trend`} /> },
        ]}
      />
    </div>
  )
}

type TermRow = Parameters<DrillFactories['term']>[0]

function TermBody({ row, currency }: { row: TermRow; currency: string }) {
  const metrics = row.metrics
  const ratios = metrics ? ratiosOf(metrics) : null
  return (
    <div data-testid="drill-term">
      <Descriptions size="small" column={3} bordered>
        <Descriptions.Item label="搜索词">{row.searchTerm}</Descriptions.Item>
        <Descriptions.Item label="状态">{ADS_TERM_STATUS_LABEL[row.status as AdsTermStatus] ?? row.status}</Descriptions.Item>
        <Descriptions.Item label="花费">{metrics ? moneyCell(metrics.spend, currency) : NONE}</Descriptions.Item>
        <Descriptions.Item label="广告销售额">{metrics ? moneyCell(metrics.sales, currency) : NONE}</Descriptions.Item>
        <Descriptions.Item label="订单">{metrics ? numberCell(metrics.orders) : NONE}</Descriptions.Item>
        <Descriptions.Item label="广告成本销售比">{percentCell(ratios?.acos)}</Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 8 }}>
        <TermLink term={row.searchTerm}>打开词级分析（趋势、关联活动与品牌分析份额）</TermLink>
      </div>
    </div>
  )
}

export const DRILL: DrillFactories = {
  adGroup: (row, currency) => ({ key: `ad-group:${row.id}`, title: `广告组 ${row.name}`, render: () => <GroupBody id={row.id} currency={currency} /> }),
  target: (row, currency) => ({ key: `target:${row.id}`, title: `投放 ${row.expression}`, render: () => <TargetBody id={row.id} currency={currency} /> }),
  term: (row, currency) => ({ key: `term:${row.searchTerm}`, title: `搜索词 ${row.searchTerm}`, render: () => <TermBody row={row} currency={currency} /> }),
}
