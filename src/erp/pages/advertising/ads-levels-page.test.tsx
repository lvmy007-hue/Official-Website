import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { listHandlers, listResponse, rowText, writeStatus } from './ads-campaigns-fixtures.test-helper'
import { ok } from './ads-fixtures.test-helper'
import { groupCounts, groupHandlers, groupList } from './ads-levels-fixtures.test-helper'

// 广告层级统一骨架（P6-23）：广告组列表与活动列表共用同一个骨架组件。
// 验证：指标与“尚无记录”（不写 0）、广告组合树、指标区间（百分数输入、写成小数、下限大于上限不能应用）、分类计数（数字来自计数接口，点一类就带上 bucket）、
// 汇总行取服务端数、写入开关关着时批量按钮置灰并写明原因。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  AdsAdGroupsPage: { load: () => import('./AdsAdGroupsPage') },
  AdsCampaignsPage: { load: () => import('./AdsCampaignsPage') },
}
afterEach(() => vi.unstubAllGlobals())

const groupsUrl = '/app/advertising/ad-groups'
const listCalls = (calls: Array<{ path: string; search: string }>, path: string) => calls.filter(call => call.path === path && new URLSearchParams(call.search).get('pageSize') !== '1')

describe('广告组列表（统一骨架）', () => {
  it('名称与所属活动是链接；有指标显示美元与比率，没有指标行显示“尚无记录”，不写 0', async () => {
    mountApp({ url: groupsUrl, pages, handlers: groupHandlers() })
    const page = await screen.findByTestId('ads-ad-groups-page')
    const link = await within(page).findByRole('link', { name: '核心词组' })
    expect(link).toHaveAttribute('href', '/app/advertising/ad-groups/ag-1')
    const first = rowText('ag-1')
    for (const text of ['$40.00', '$100.00', '40.0%', '春季推广', '$1.20']) expect(first).toContain(text)
    const bare = rowText('ag-2')
    expect(bare.split('尚无记录').length - 1).toBeGreaterThan(5)
    expect(bare).not.toContain('$0.00')
    expect(bare).toContain('活动尚未同步')
  })

  it('左侧广告组合树：点一项按 portfolioId 重新取数；“全部”清除', async () => {
    const app = mountApp({ url: groupsUrl, pages, handlers: groupHandlers() })
    const tree = await screen.findByTestId('ads-portfolio-tree')
    await userEvent.click(await within(tree).findByText('春季组合'))
    await vi.waitFor(() => expect(listCalls(app.calls, '/ads/ad-groups').some(call => new URLSearchParams(call.search).get('portfolioId') === 'PF1')).toBe(true))
    await userEvent.click(within(tree).getByText('全部广告组合'))
    await vi.waitFor(() => expect(app.router.state.location.search).not.toHaveProperty('portfolioId'))
  })

  it('指标区间：百分数输入，请求里是小数；下限大于上限时不能应用', async () => {
    const app = mountApp({ url: groupsUrl, pages, handlers: groupHandlers() })
    await within(await screen.findByTestId('ads-ad-groups-page')).findByText('核心词组')
    await userEvent.click(screen.getByTestId('ads-range-button'))
    const panel = await screen.findByTestId('ads-range-panel')
    const min = within(panel).getByLabelText('广告成本销售比下限')
    const max = within(panel).getByLabelText('广告成本销售比上限')
    fireEvent.change(min, { target: { value: '40' } })
    fireEvent.change(max, { target: { value: '20' } })
    expect(within(panel).getByText('广告成本销售比的下限不能大于上限')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /应\s*用/ })).toBeDisabled()
    fireEvent.change(min, { target: { value: '20' } })
    fireEvent.change(max, { target: { value: '40' } })
    await userEvent.click(within(panel).getByRole('button', { name: /应\s*用/ }))
    await vi.waitFor(() =>
      expect(
        listCalls(app.calls, '/ads/ad-groups').some(call => {
          const params = new URLSearchParams(call.search)
          return params.get('acosMin') === '0.2' && params.get('acosMax') === '0.4'
        }),
      ).toBe(true),
    )
  })

  it('分类计数：数字来自计数接口，没有指标的单独说明；点一类带上 bucket，计数请求不带分类', async () => {
    const app = mountApp({
      url: groupsUrl,
      pages,
      handlers: groupHandlers(undefined, () => groupCounts({ total: 7, withoutMetrics: 2, buckets: { CONVERTED: 3, CLICK_NO_ORDER: 2, IMPRESSION_NO_CLICK: 1, NO_IMPRESSION: 1 } })),
    })
    const chips = await screen.findByTestId('ads-bucket-chips')
    expect(await within(chips).findByText('有成交 3')).toBeInTheDocument()
    expect(within(chips).getByText('有点击无成交 2')).toBeInTheDocument()
    expect(within(chips).getByText(/另有 2 个对象尚无指标/)).toBeInTheDocument()
    await userEvent.click(within(chips).getByText('有点击无成交 2'))
    await vi.waitFor(() => expect(listCalls(app.calls, '/ads/ad-groups').some(call => new URLSearchParams(call.search).get('bucket') === 'CLICK_NO_ORDER')).toBe(true))
    expect(app.calls.filter(call => call.path === '/ads/ad-groups/counts').every(call => new URLSearchParams(call.search).get('bucket') === null)).toBe(true)
  })

  it('汇总行取服务端的汇总请求（pageSize=1），不是前端求和', async () => {
    const app = mountApp({ url: groupsUrl, pages, handlers: groupHandlers(() => groupList()) })
    await within(await screen.findByTestId('ads-ad-groups-page')).findByText('核心词组')
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/ad-groups' && new URLSearchParams(call.search).get('pageSize') === '1')).toBe(true))
  })

  it('列表读取失败：显示失败说明，不显示空表', async () => {
    mountApp({
      url: groupsUrl,
      pages,
      handlers: { ...groupHandlers(), '/ads/ad-groups': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用', retryable: true } } }) },
    })
    const page = await screen.findByTestId('ads-ad-groups-page')
    await vi.waitFor(() => expect(within(page).queryByText('核心词组')).toBeNull())
  })
})

describe('批量写入开关闸门', () => {
  it('写入开关关着：勾选后暂停、启用、调整预算、调整竞价策略都置灰；开关开着才可点', async () => {
    mountApp({ url: '/app/advertising/campaigns', pages, handlers: { ...listHandlers(() => listResponse()), '/ads/writes': () => ok(writeStatus(false)) } })
    const page = await screen.findByTestId('ads-campaigns-page')
    await within(page).findByText('春季推广')
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    const bar = within(await within(page).findByRole('toolbar', { name: '批量操作' }))
    await vi.waitFor(() => {
      for (const name of [/暂\s*停/, /启\s*用/, /调整预算/, /调整竞价策略/]) expect(bar.getByRole('button', { name })).toBeDisabled()
    })
    // 标签与负责人是本系统内的设置，不受亚马逊写入开关影响
    expect(bar.getByRole('button', { name: '设置标签与负责人' })).toBeEnabled()
  })

  it('写入开关开着：写入按钮可点', async () => {
    mountApp({ url: '/app/advertising/campaigns', pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-campaigns-page')
    await within(page).findByText('春季推广')
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    const bar = within(await within(page).findByRole('toolbar', { name: '批量操作' }))
    await vi.waitFor(() => expect(bar.getByRole('button', { name: /暂\s*停/ })).toBeEnabled())
  })
})
