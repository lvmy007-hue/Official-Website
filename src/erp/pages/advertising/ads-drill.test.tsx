import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import type { AdsTabList, AdsAdGroupRow, AdsTargetRow } from '@nova/api-contracts'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { detailHandlers, detailResponse, termList } from './ads-campaigns-fixtures.test-helper'

// 活动详情的弹窗下钻（P6-23）：广告组、投放、搜索词不再整页跳转，在弹窗里连续下钻，面包屑可以回到任意一层；活动详情本身仍是整页。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsCampaignDetailPage: { load: () => import('./AdsCampaignDetailPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/campaigns/cam-1'
const shell = { state: 'OK' as const, note: null, truncated: false, pageInfo: { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: 1 } }
const metrics = { impressions: 1000, clicks: 50, spend: 20, sales: 80, orders: 4 }
const groupList = (): AdsTabList<AdsAdGroupRow> => ({ ...shell, items: [{ id: 'ag-1', adGroupId: 'AG1', name: '核心词组', state: 'ENABLED', defaultBid: 1.2, metrics }] })
const targetList = (): AdsTabList<AdsTargetRow> => ({
  ...shell,
  items: [
    {
      id: 'kw-1',
      key: 'k1',
      targetId: 'KW1',
      kind: 'KEYWORD',
      expression: 'yoga mat',
      matchType: 'EXACT',
      bid: 1,
      state: 'ENABLED',
      adGroupId: 'AG1',
      adGroupName: '核心词组',
      suggestedBid: null,
      metrics,
    },
  ],
})
const handlers = () => ({
  ...detailHandlers(() => detailResponse()),
  '/ads/campaigns/cam-1/ad-groups': () => ok(groupList()),
  '/ads/ad-groups/ag-1/targets': () => ok(targetList()),
  '/ads/ad-groups/ag-1/search-terms': () => ok(termList()),
  '/ads/targets/kw-1/search-terms': () => ok({ ...shell, items: [], note: null }),
  '/ads/targets/kw-1/trend': () => ok({ state: 'NO_DATA', note: '没有趋势记录', points: [] }),
})

describe('活动详情的弹窗下钻', () => {
  it('广告组：点名称开弹窗（不是链接跳转）；弹窗里投放对象与搜索词两个页签；活动详情本身仍是整页', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ads-campaign-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '广告组' }))
    const name = await within(page).findByRole('button', { name: '核心词组' })
    expect(within(page).queryByRole('link', { name: '核心词组' })).toBeNull()
    fireEvent.click(name)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('drill-ad-group')).toBeInTheDocument()
    expect(within(dialog).getByRole('tab', { name: '投放对象' })).toBeInTheDocument()
    expect(within(dialog).getByRole('tab', { name: '搜索词' })).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: '打开广告组完整页面' })).toHaveAttribute('href', '/app/advertising/ad-groups/ag-1')
    expect(screen.getByTestId('ads-campaign-detail')).toBeInTheDocument()
  })

  it('连续下钻：广告组 → 投放，面包屑显示两层，点上一层回到广告组，后退与前进可用', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ads-campaign-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '广告组' }))
    fireEvent.click(await within(page).findByRole('button', { name: '核心词组' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'yoga mat' }))
    expect(await within(dialog).findByTestId('drill-target')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '广告组 核心词组' })).toBeInTheDocument()
    expect(within(dialog).getByText('投放 yoga mat')).toHaveAttribute('aria-current', 'page')
    expect(within(dialog).getByRole('link', { name: '打开投放对象完整页面' })).toHaveAttribute('href', '/app/advertising/targets/kw-1')
    fireEvent.click(within(dialog).getByRole('button', { name: '广告组 核心词组' }))
    expect(await within(dialog).findByTestId('drill-ad-group')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '前进一层' })).toBeEnabled()
  })

  it('搜索词：从广告组弹窗里的搜索词页签继续下钻，显示该词的表现与词级分析入口', async () => {
    mountApp({ url, pages, handlers: handlers() })
    const page = await screen.findByTestId('ads-campaign-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '广告组' }))
    fireEvent.click(await within(page).findByRole('button', { name: '核心词组' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: '搜索词' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'cheap yoga mat' }))
    const body = await within(dialog).findByTestId('drill-term')
    expect(body).toHaveTextContent('已否定')
    expect(body).toHaveTextContent('$25.00')
    expect(within(body).getByRole('link', { name: /打开词级分析/ })).toHaveAttribute('href', expect.stringContaining('/app/ad-terms/detail'))
  })
})
