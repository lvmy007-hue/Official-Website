import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { detailHandlers, detailResponse, emptyList, emptyMetricsDetail, listHandlers, listResponse, noAdviceDetail, rowText } from './ads-campaigns-fixtures.test-helper'

// 广告活动列表与详情（P3-07）：假服务端返回固定数据，验证列表的指标与“尚无记录”（不写 0）、筛选与排序随请求带出、写亚马逊的动作禁用并说明原因；
// 详情的身份区与建议动作（规则命中才出现、写入动作禁用、忽略推荐可用）、页签按广告产品出现、读取失败与空状态?
vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  AdsCampaignsPage: { load: () => import('./AdsCampaignsPage') },
  AdsCampaignDetailPage: { load: () => import('./AdsCampaignDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const listUrl = '/app/advertising/campaigns'
const detailUrl = '/app/advertising/campaigns/cam-1'

describe('广告活动列表', () => {
  it('有数据：名称链到详情，指标与比率显示；没有汇总的活动显示“尚无记录”，不写 0', async () => {
    mountApp({ url: listUrl, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-campaigns-page')
    const link = await within(page).findByRole('link', { name: '春季推广' })
    expect(link).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
    const first = rowText('cam-1')
    for (const text of ['$60.00', '$200.00', '30.0%', '春季组合', '主推', '林然', '尚未接入']) expect(first).toContain(text)
    const brand = rowText('cam-sb')
    expect(brand.split('尚无记录').length - 1).toBeGreaterThan(3)
    expect(brand).not.toContain('$0.00')
    expect(screen.getByText(/未选择日期范围，当前显示 2026-09-23 至 2026-10-22/)).toBeInTheDocument()
  })

  it('写亚马逊的动作（暂停、启用、调整预算与竞价策略）与设置标签、负责人都要先勾选活动；勾选后写入动作才可点', async () => {
    mountApp({ url: listUrl, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-campaigns-page')
    await within(page).findByText('春季推广')
    expect(within(page).queryByRole('toolbar', { name: '批量操作' })).toBeNull()
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    const bar = within(await within(page).findByRole('toolbar', { name: '批量操作' }))
    expect(bar.getByText('已选 1 项')).toBeInTheDocument()
    expect(bar.getByRole('button', { name: '设置标签与负责人' })).toBeEnabled()
    for (const name of [/暂\s*停/, /启\s*用/, /调整预算/, /调整竞价策略/]) expect(bar.getByRole('button', { name })).toBeEnabled()
  })

  it('筛选与排序随请求带出：默认按花费降序；名称搜索与筛选写进地址栏，刷新后恢复', async () => {
    const app = mountApp({ url: listUrl, pages, handlers: listHandlers(() => listResponse()) })
    const page = await screen.findByTestId('ads-campaigns-page')
    await within(page).findByText('春季推广')
    const first = app.calls.find(call => call.path === '/ads/campaigns' && new URLSearchParams(call.search).get('pageSize') !== '1')!
    expect(new URLSearchParams(first.search).get('sort')).toBe('spend:desc')
    expect(new URLSearchParams(first.search).get('cursor')).toBeNull()
    const search = within(page).getByRole('searchbox', { name: '搜索名称包含' })
    fireEvent.change(search, { target: { value: '春季' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(app.calls.some(call => new URLSearchParams(call.search).get('q') === '春季')).toBe(true))
    expect(app.router.state.location.search).toMatchObject({ q: '春季' })
    app.unmount()

    const again = mountApp({ url: `${listUrl}?q=春季&qMode=excludes&state=ENABLED&tag=主推`, pages, handlers: listHandlers(() => listResponse()) })
    await within(await screen.findByTestId('ads-campaigns-page')).findByText('春季推广')
    // 第一次挂载留下的请求也在 calls 里，只看带着地址栏条件的那次
    const params = new URLSearchParams(
      again.calls.find(call => call.path === '/ads/campaigns' && new URLSearchParams(call.search).get('pageSize') !== '1' && new URLSearchParams(call.search).get('state') === 'ENABLED')!.search,
    )
    expect(params.get('q')).toBe('春季')
    expect(params.get('qMode')).toBe('excludes')
    expect(params.get('state')).toBe('ENABLED')
    expect(params.get('tag')).toBe('主推')
    expect(screen.getByRole('list', { name: '已生效的条件' })).toHaveTextContent('名称不包含')
    expect(screen.getByRole('combobox', { name: '搜索方式' })).toBeInTheDocument()
  })
  it('还没有同步到活动：写明原因，不画示例行', async () => {
    mountApp({ url: listUrl, pages, handlers: listHandlers(() => emptyList()) })
    expect(await screen.findByText(/还没有同步到广告活动/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '春季推广' })).toBeNull()
  })

  it('活动或指标超过读取上限：如实提示', async () => {
    mountApp({ url: listUrl, pages, handlers: listHandlers(() => listResponse({ truncated: true, metricsTruncated: true })) })
    expect(await screen.findByText(/活动数量超过读取上限/)).toBeInTheDocument()
    expect(screen.getByText(/指标聚合超过读取上限/)).toBeInTheDocument()
  })

  it('读取失败：显示错误，不显示示例数字', async () => {
    mountApp({ url: listUrl, pages, handlers: { '/ads/campaigns': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    await screen.findByTestId('ads-campaigns-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('春季推广')).toBeNull()
  }, 30_000)
})

describe('广告活动详情', () => {
  it('身份区：名称、状态、关键指标与对比、广告组合、账户、标签与负责人', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse()) })
    const page = await screen.findByTestId('ads-campaign-detail')
    expect(await within(page).findByText('春季推广')).toBeInTheDocument()
    expect(page).toHaveTextContent('启用中')
    expect(page).toHaveTextContent('商品推广')
    expect(page).toHaveTextContent('$60.00')
    expect(page).toHaveTextContent('$200.00')
    expect(page).toHaveTextContent('较上期')
    const extra = within(page).getByTestId('campaign-identity-extra')
    expect(extra).toHaveTextContent('广告组合：春季组合')
    expect(extra).toHaveTextContent('投放方式：手动')
    expect(extra).toHaveTextContent('广告账户：美国账户（Northstar US）')
    expect(extra).toHaveTextContent('广告位调整：尚未接入')
    expect(extra).toHaveTextContent('负责人：林然')
    expect(extra).toHaveTextContent('主推')
  })

  it('没有汇总：指标写“尚无记录”，没有 0', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => emptyMetricsDetail()) })
    const page = await screen.findByTestId('ads-campaign-detail')
    await within(page).findByText('春季推广')
    expect(within(page).getAllByText('尚无记录').length).toBeGreaterThan(2)
    expect(page).not.toHaveTextContent('$0.00')
  })

  it('建议动作：规则命中才出现；写入动作禁用并说明；官方推荐可以忽略', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse()) })
    const page = await screen.findByTestId('ads-campaign-detail')
    expect(await within(page).findByText(/投放词“yoga mat”（EXACT）花费高但没有订单/)).toBeInTheDocument()
    expect(page).toHaveTextContent('近 30 天花费 USD 30.00')
    expect(page).toHaveTextContent('最多可省约 USD 30.00')
    expect(within(page).getByRole('button', { name: '降低竞价或否定' })).toBeDisabled()
    expect(within(page).getByRole('button', { name: /采\s*纳/ })).toBeDisabled()
    expect(within(page).getByRole('button', { name: /忽\s*略/ })).toBeEnabled()
    expect(within(page).queryByText(/广告商品已断货但仍在花钱/)).toBeNull()
    expect(within(page).getByTestId('advice-rules')).toHaveTextContent('命中 2 条')
  })

  it('规则都没命中：不出现建议区；规则明细仍写明各条规则的状态（未命中、尚未接入）', async () => {
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => noAdviceDetail()) })
    const page = await screen.findByTestId('ads-campaign-detail')
    await within(page).findByText('春季推广')
    expect(within(page).queryByRole('button', { name: /采\s*纳/ })).toBeNull()
    const rules = within(page).getByTestId('advice-rules')
    expect(rules).toHaveTextContent('命中 0 条')
    expect(rules).toHaveTextContent('尚未接入')
    expect(rules).toHaveTextContent('未命中')
  })

  it('页签：商品推广没有创意与受众；品牌推广有创意，没有受众；默认打开“表现趋势”并如实写没有记录', async () => {
    const app = mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse()) })
    const page = await screen.findByTestId('ads-campaign-detail')
    await within(page).findByText('春季推广')
    for (const label of ['表现趋势', '分时表现', '广告组', '投放对象', '搜索词', '广告商品', '广告位', '预算与竞价历史', '预测与推荐', '操作记录']) {
      expect(within(page).getByRole('tab', { name: label })).toBeInTheDocument()
    }
    expect(within(page).queryByRole('tab', { name: '创意与着陆页' })).toBeNull()
    expect(within(page).queryByRole('tab', { name: '受众' })).toBeNull()
    expect(await within(page).findByText(/所选范围内尚无这个活动的广告汇总记录/)).toBeInTheDocument()
    app.unmount()
    mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse({}, 'SPONSORED_BRANDS')) })
    const brand = await screen.findByTestId('ads-campaign-detail')
    await within(brand).findByText('春季推广')
    expect(within(brand).getByRole('tab', { name: '创意与着陆页' })).toBeInTheDocument()
    expect(within(brand).queryByRole('tab', { name: '受众' })).toBeNull()
  })

  it('搜索词页签：状态标签、花费无转化标记、写入按钮禁用；状态筛选随请求带出', async () => {
    const app = mountApp({ url: detailUrl, pages, handlers: detailHandlers(() => detailResponse()) })
    const page = await screen.findByTestId('ads-campaign-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '搜索词' }))
    const row = (await within(page).findByText('cheap yoga mat')).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('已否定')
    expect(row).toHaveTextContent('花费无转化')
    expect(within(page).getByText('yoga mat').closest('tr, [role=row]') as HTMLElement).toHaveTextContent('已投放')
    const block = within(page).getByText('yoga block').closest('tr, [role=row]') as HTMLElement
    expect(block).toHaveTextContent('未投放')
    expect(block).not.toHaveTextContent('花费无转化')
    expect(within(page).getByTestId('term-basis')).toHaveTextContent('完全相同')
    expect(within(page).getByRole('button', { name: '添加为关键词' })).toBeDisabled()
    expect(within(page).getByRole('button', { name: '添加否定' })).toBeDisabled()
    expect(app.calls.some(call => call.path === '/ads/campaigns/cam-1/search-terms')).toBe(true)
  })

  it('活动不存在或不在范围内：显示读取失败，不显示示例数据', async () => {
    mountApp({ url: detailUrl, pages, handlers: { '/ads/campaigns/cam-1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '广告活动不存在' } } }) } })
    expect((await screen.findAllByText(/广告活动不存在|不存在/)).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('ads-campaign-detail')).toBeNull()
  })
})
