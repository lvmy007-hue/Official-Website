import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ADS_BUDGET_TIMELINE_PRECISION, budgetTimelineDay, type AdsBudgetTimelineResponse, type AdsConflictsResponse, type AdsDuplicateKeywordsResponse } from '@nova/api-contracts'
import { ok } from './ads-fixtures.test-helper'
import { detailHandlers, detailResponse } from './ads-campaigns-fixtures.test-helper'
import { listHandlers as ruleHandlers } from './ads-rules-fixtures.test-helper'
import { termHandlers } from './ad-terms-fixtures.test-helper'
import { countsResponse } from './ads-campaigns-fixtures.test-helper'

// 广告新增分析与工具（P6-24）：冲突面板与列表上的冲突标记、重复关键词面板、超预算时间条与归因窗口切换、批量加词的请求体。
// 假服务端返回固定数据；没有的值写“尚无记录”，不写 0。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  AdsRulesPage: { load: () => import('./AdsRulesPage') },
  AdsTargetsPage: { load: () => import('./AdsTargetsPage') },
  AdsCampaignDetailPage: { load: () => import('./AdsCampaignDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const info = { hasMore: false, nextCursor: null, approxTotal: 1, pageSize: 50 }
const conflicts = (): AdsConflictsResponse => ({
  state: 'OK',
  note: null,
  ruleNote: '规则没有时间维度，不判断时间重叠。',
  items: [
    {
      key: 'CAMPAIGN|cam-1|state',
      kind: 'RULE_VS_DAYPARTING',
      kindLabel: '规则与分时策略',
      objectLevel: 'CAMPAIGN',
      objectId: 'cam-1',
      objectName: '春季推广',
      field: 'state',
      fieldLabel: '启停状态',
      overlapHours: 3,
      parties: [
        { type: 'DAYPARTING', id: 's-1', name: '夜间暂停', effective: true, effectiveHours: 3, note: '' },
        { type: 'RULE', id: 'r-1', name: '高 ACoS 活动暂停', effective: false, effectiveHours: null, note: '' },
      ],
      reason: '两者都改春季推广的启停状态',
    },
  ],
  pageInfo: info,
  counts: { 'r-1': 1, 's-1': 1 },
  total: 1,
  truncated: false,
})

describe('冲突面板', () => {
  it('规则页：列出冲突与生效方，规则名称旁标出冲突数', async () => {
    mountApp({ url: '/app/advertising/rules', pages, handlers: { ...ruleHandlers(), '/ads/conflicts': () => ok(conflicts()) } })
    const panel = await screen.findByTestId('ads-conflicts-panel')
    expect(await within(panel).findByText(/夜间暂停/)).toBeInTheDocument()
    expect(panel).toHaveTextContent('冲突（1 处）')
    expect(panel).toHaveTextContent('规则与分时策略')
    expect(panel).toHaveTextContent('3 个小时格')
    expect(panel).toHaveTextContent('（被覆盖）')
    expect(await screen.findByTestId('conflict-tag-r-1')).toHaveTextContent('冲突 1')
  })

  it('没有冲突：写明没有，不画示例行', async () => {
    const empty = { ...conflicts(), items: [], counts: {}, total: 0, state: 'NO_DATA' as const, note: '还没有启用的分时策略或自动执行的规则' }
    mountApp({ url: '/app/advertising/rules', pages, handlers: { ...ruleHandlers(), '/ads/conflicts': () => ok(empty) } })
    const panel = await screen.findByTestId('ads-conflicts-panel')
    expect(await within(panel).findByText(/还没有启用的分时策略或自动执行的规则/)).toBeInTheDocument()
    expect(screen.queryByTestId('conflict-tag-r-1')).toBeNull()
  })
})

describe('重复关键词面板', () => {
  it('投放页：展开才读取，列出词、匹配方式与各广告组位置', async () => {
    const duplicates = (): AdsDuplicateKeywordsResponse => ({
      state: 'OK',
      note: null,
      total: 1,
      truncated: false,
      pageInfo: info,
      items: [
        {
          key: 'ap-a|yoga mat|EXACT',
          adsProfileId: 'ap-a',
          text: 'yoga mat',
          matchType: 'EXACT',
          matchLabel: '精确匹配',
          adGroupCount: 2,
          locations: [
            { keywordId: 'k-1', adGroupExternalId: 'AG1', adGroupId: 'ag-1', adGroupName: '广告组一', campaignId: 'cam-1', campaignName: '春季推广', state: 'ENABLED', bid: 1 },
            { keywordId: 'k-2', adGroupExternalId: 'AG2', adGroupId: 'ag-2', adGroupName: '广告组二', campaignId: 'cam-1', campaignName: '春季推广', state: 'ENABLED', bid: null },
          ],
        },
      ],
    })
    const app = mountApp({
      url: '/app/advertising/targets',
      pages,
      handlers: {
        ...termHandlers(),
        '/ads/targets/counts': () => ok(countsResponse({ level: 'targets', total: 0, withoutMetrics: 0, buckets: { CONVERTED: 0, CLICK_NO_ORDER: 0, IMPRESSION_NO_CLICK: 0, NO_IMPRESSION: 0 } })),
        '/ads/duplicate-keywords': () => ok(duplicates()),
      },
    })
    const panel = await screen.findByTestId('ads-duplicates-panel')
    expect(app.calls.some(call => call.path === '/ads/duplicate-keywords')).toBe(false)
    fireEvent.click(within(panel).getByText(/重复关键词/))
    expect(await within(panel).findByText('广告组一')).toBeInTheDocument()
    expect(panel).toHaveTextContent('精确匹配')
    expect(panel).toHaveTextContent('广告组二')
  })
})

describe('活动详情：超预算时间条与归因窗口', () => {
  const timeline = (): AdsBudgetTimelineResponse => {
    const hours = new Map([
      [8, { spend: 6, impressions: 10, clicks: 1 }],
      [9, { spend: 6, impressions: 10, clicks: 1 }],
    ])
    const day = budgetTimelineDay('2026-10-20', 10, hours)
    return {
      state: 'OK',
      note: null,
      precisionNote: ADS_BUDGET_TIMELINE_PRECISION,
      zone: 'Asia/Shanghai',
      currency: 'USD',
      budget: 10,
      budgetNote: null,
      historyDays: 14,
      period: { from: '2026-10-20', to: '2026-10-20' },
      days: [day],
      averageOverBudgetHours: day.overBudgetHours,
      defaultWindow: 7,
      windows: [
        { window: 1, available: false, reason: '范围内只有 0/1 天的报告行带有 sales1d 列', sales: null, orders: null, coveredDays: 0, totalDays: 1 },
        { window: 7, available: true, reason: null, sales: 20, orders: 3, coveredDays: 1, totalDays: 1 },
        { window: 14, available: true, reason: null, sales: 30, orders: 4, coveredDays: 1, totalDays: 1 },
        { window: 30, available: false, reason: '范围内只有 0/1 天的报告行带有 sales30d 列', sales: null, orders: null, coveredDays: 0, totalDays: 1 },
      ],
    }
  }

  it('展开后：精度说明、超预算起点与时长；缺列的窗口置灰，可选窗口切换后显示对应销售额与订单', async () => {
    mountApp({ url: '/app/advertising/campaigns/cam-1', pages, handlers: { ...detailHandlers(() => detailResponse()), '/ads/campaigns/cam-1/budget-timeline': () => ok(timeline()) } })
    const card = await screen.findByTestId('budget-timeline-card')
    fireEvent.click(within(card).getByText(/超预算时间条/))
    const body = await within(card).findByTestId('budget-timeline')
    expect(body).toHaveTextContent('精度说明')
    const day = within(body).getByTestId('timeline-day-2026-10-20')
    expect(day).toHaveTextContent('09:00 起超预算，共 15 小时')
    expect(day.querySelectorAll('[data-over="true"]').length).toBe(15)
    expect(within(body).getByRole('radio', { name: '1 天' })).toBeDisabled()
    expect(within(body).getByRole('radio', { name: '30 天' })).toBeDisabled()
    expect(within(body).getByTestId('attribution-result')).toHaveTextContent('销售额 $20.00，订单 3')
    fireEvent.click(within(body).getByRole('radio', { name: '14 天' }))
    expect(within(body).getByTestId('attribution-result')).toHaveTextContent('销售额 $30.00，订单 4')
  })

  it('数据流没接入：写原因，不画时间条', async () => {
    const off: AdsBudgetTimelineResponse = { ...timeline(), state: 'NOT_CONNECTED', note: '营销数据流尚未接入', days: [], averageOverBudgetHours: null }
    mountApp({ url: '/app/advertising/campaigns/cam-1', pages, handlers: { ...detailHandlers(() => detailResponse()), '/ads/campaigns/cam-1/budget-timeline': () => ok(off) } })
    const card = await screen.findByTestId('budget-timeline-card')
    fireEvent.click(within(card).getByText(/超预算时间条/))
    const body = await within(card).findByTestId('budget-timeline')
    expect(body).toHaveTextContent('营销数据流尚未接入')
    expect(body.querySelector('[data-over]')).toBeNull()
  })
})

describe('批量加词', () => {
  it('活动详情的“批量添加否定投放”：一行一个词，请求体带活动编号、层级与去重后的词', async () => {
    const bodies: Array<Record<string, any>> = []
    mountApp({
      url: '/app/advertising/campaigns/cam-1',
      pages,
      handlers: {
        ...detailHandlers(() => detailResponse()),
        '/ads/keywords/bulk-add': (_url: URL, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)))
          return ok({ state: 'QUEUED', requested: 2, runs: [], skipped: [] })
        },
      },
    })
    const page = await screen.findByTestId('ads-campaign-detail')
    await userEvent.click(await within(page).findByRole('button', { name: '批量添加否定投放' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('否定投放列表'), 'free\nFree \ncheap')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认提交/ }))
    await vi.waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      mode: 'NEGATIVE',
      entityId: 'cam-1',
      level: 'CAMPAIGN',
      source: 'MANUAL',
      items: [
        { text: 'free', matchType: 'NEGATIVE_EXACT' },
        { text: 'cheap', matchType: 'NEGATIVE_EXACT' },
      ],
    })
  })
})
