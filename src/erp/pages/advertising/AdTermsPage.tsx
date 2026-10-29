import { useState } from 'react'
import { Card, Tabs } from 'antd'
import { AD_TERM_PAGE_TABS, type AdTermPageTab } from '@nova/api-contracts'
import { PageHeader } from '../../components'
import { TermFilters, TermViews } from './ad-terms-filters'
import { initialState, switchTab, type TermsState } from './ad-terms-state'
import { NegativesTab, QuadrantTab, RootsTab, SearchTermsTab, TargetsTab, type TabProps } from './ad-terms-tabs'

// 词级中心（P3-10，08 章 8.7）：投放对象、搜索词、否定词库、四象限、词根分析 5 个页签，聚合都在数据库里做，不再截断。
// 异常分组、搜索、筛选、排序与保存视图在这里；点词进入词级分析页。否定、加词、调价写亚马逊，随“广告写入接入”（P3-17），按钮禁用并说明原因。

function Body({ tab, ...props }: TabProps & { tab: AdTermPageTab }) {
  switch (tab) {
    case 'targets':
      return <TargetsTab {...props} />
    case 'search-terms':
      return <SearchTermsTab {...props} />
    case 'negatives':
      return <NegativesTab {...props} />
    case 'quadrant':
      return <QuadrantTab {...props} />
    case 'roots':
      return <RootsTab {...props} />
  }
}

export default function AdTermsPage() {
  const [state, setState] = useState<TermsState>(() => initialState())
  const patch = (value: Partial<TermsState>) => setState(current => ({ ...current, ...value }))
  return (
    <div data-testid="ad-terms-page">
      <PageHeader
        title="词级中心"
        description="按词汇总全部活动与店铺的花费、广告销售额与订单，找出该否定、该加词、可扩量的词。指标是所选日期范围内的合计（美元账户）；否定与加词请到广告组详情添加，调价请到投放对象详情（这里的按钮暂未提供入口）。"
      />
      <Card size="small">
        <TermViews state={state} onApply={setState} />
        <Tabs activeKey={state.tab} onChange={key => setState(current => switchTab(current, key as AdTermPageTab))} items={AD_TERM_PAGE_TABS.map(item => ({ key: item.key, label: item.label }))} />
        <TermFilters state={state} onChange={patch} />
        <Body tab={state.tab} state={state} onChange={patch} />
      </Card>
    </div>
  )
}
