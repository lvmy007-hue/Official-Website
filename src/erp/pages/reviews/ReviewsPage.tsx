import type { ReactElement } from 'react'
import { Card, Tabs } from 'antd'
import { useRouter, useSearch } from '@tanstack/react-router'
import { REVIEWS_TABS, REVIEWS_TAB_LABEL, type ReviewsTab } from '@nova/api-contracts'
import { PageHeader } from '../../components'
import { RatingsPanel } from './RatingsPanel'
import { ReturnsPanel } from './ReturnsPanel'
import { SolicitPanel } from './SolicitPanel'
import { TopicsPanel } from './TopicsPanel'
import { tabOf, type SearchPatch, type SelectionProps } from './reviews-state'

// 评价与反馈（P4-13，05 章 5.7）：评分概况（文件导入）、评论主题、退货主题与产品改进清单、请求评价。
// 数据来源：客户反馈接口、请求评价接口与评分文件导入；没有数据写“尚无记录”，没有权限写“无权限”，来源没接上写“尚未接入”，永远不显示成 0。
// 页签与选择（店铺、ASIN、类目节点）放在地址栏里，刷新不丢；买家信息不在本页出现。

export default function ReviewsPage() {
  const router = useRouter()
  const search = useSearch({ strict: false }) as { tab?: string; storeId?: string; asin?: string; nodeId?: string }
  const tab = tabOf(search.tab)

  const update = (patch: SearchPatch, replace: boolean) => {
    void router.navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never, replace })
  }
  const selection: SelectionProps = { storeId: search.storeId, asin: search.asin, nodeId: search.nodeId, onSelect: patch => update(patch, true) }
  const body: Record<ReviewsTab, ReactElement> = {
    ratings: <RatingsPanel />,
    topics: <TopicsPanel {...selection} />,
    returns: <ReturnsPanel {...selection} />,
    solicit: <SolicitPanel {...selection} />,
  }

  return (
    <div data-testid="reviews-page">
      <PageHeader
        title="评价与反馈"
        description="商品的评分、评论主题、类目退货主题与请求评价。评分来自你导入的文件，评论与退货主题来自亚马逊客户反馈接口（需要品牌备案与品牌分析角色），请求评价通过亚马逊请求评价接口发出；不抓取亚马逊前台页面，也不显示任何买家信息。"
      />
      <Card size="small" style={{ marginTop: 8 }}>
        <Tabs
          activeKey={tab}
          onChange={key => update({ tab: key, storeId: undefined, asin: undefined, nodeId: undefined }, false)}
          items={REVIEWS_TABS.map(key => ({ key, label: REVIEWS_TAB_LABEL[key], children: body[key] }))}
        />
      </Card>
    </div>
  )
}
