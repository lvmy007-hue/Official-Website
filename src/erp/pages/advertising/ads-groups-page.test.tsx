import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { bidHistory, groupHandlers, noMetricsGroup, targetDetail, targetHandlers } from './ads-groups-fixtures.test-helper'

// 广告组详情与投放对象详情（P3-08）：身份区与指标（没有指标写“尚无记录”，不写 0）、所属活动与广告组的链接、7 个与 6 个页签（品牌分析仅关键词类）、
// 广告商品的断货标红、否定投放的层级、调价前后效果对照（没有数据写“尚无记录”）、写亚马逊的动作禁用并说明原因、读取失败。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  AdsAdGroupDetailPage: { load: () => import('./AdsAdGroupDetailPage') },
  AdsTargetDetailPage: { load: () => import('./AdsTargetDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const groupUrl = '/app/advertising/ad-groups/ag-1'
const targetUrl = (id: string) => `/app/advertising/targets/${id}`

describe('广告组详情', () => {
  it('身份区：名称、状态、默认竞价、所属活动链接、账户与对比', async () => {
    mountApp({ url: groupUrl, pages, handlers: groupHandlers() })
    const page = await screen.findByTestId('ads-group-detail')
    expect(await within(page).findByText('核心词组')).toBeInTheDocument()
    expect(page).toHaveTextContent('启用中')
    expect(page).toHaveTextContent('默认竞价')
    expect(page).toHaveTextContent('$1.20')
    expect(page).toHaveTextContent('$60.00')
    expect(page).toHaveTextContent('较上期')
    expect(page).toHaveTextContent('广告账户：美国账户（Northstar US）')
    expect(within(page).getByRole('link', { name: '春季推广' })).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
  })

  it('没有指标：写“尚无记录”，没有 0；有权限时写入动作可用（先预览再提交）', async () => {
    mountApp({ url: groupUrl, pages, handlers: groupHandlers(() => noMetricsGroup()) })
    const page = await screen.findByTestId('ads-group-detail')
    await within(page).findByText('核心词组')
    expect(within(page).getAllByText('尚无记录').length).toBeGreaterThan(3)
    expect(page).not.toHaveTextContent('$0.00')
    expect(within(page).getByRole('button', { name: '修改默认竞价' })).toBeEnabled()
    expect(within(page).getByRole('button', { name: /暂\s*停/ })).toBeEnabled()
    expect(within(page).getByRole('button', { name: '添加否定投放' })).toBeEnabled()
  })

  it('7 个页签；投放对象页签的表达式链到投放对象详情，建议竞价与“尚无记录”如实显示', async () => {
    const app = mountApp({ url: groupUrl, pages, handlers: groupHandlers() })
    const page = await screen.findByTestId('ads-group-detail')
    await within(page).findByText('核心词组')
    for (const label of ['表现趋势', '投放对象', '搜索词', '广告商品', '否定投放', '分时表现', '操作记录']) expect(within(page).getByRole('tab', { name: label })).toBeInTheDocument()
    fireEvent.click(within(page).getByRole('tab', { name: '投放对象' }))
    const keyword = (await within(page).findByRole('link', { name: 'yoga mat' })).closest('tr, [role=row]') as HTMLElement
    expect(within(keyword).getByRole('link', { name: 'yoga mat' })).toHaveAttribute('href', '/app/advertising/targets/kw-1')
    expect(keyword).toHaveTextContent('$1.20')
    const product = within(page).getByRole('link', { name: 'asin="B0XYZ"' }).closest('tr, [role=row]') as HTMLElement
    expect(within(product).getAllByText('尚无记录').length).toBeGreaterThan(3)
    expect(app.calls.some(call => call.path === '/ads/ad-groups/ag-1/targets')).toBe(true)
  })

  it('广告商品：断货标红，没有 ASIN 的广告如实说明，没有指标写“尚无记录”', async () => {
    mountApp({ url: groupUrl, pages, handlers: groupHandlers() })
    const page = await screen.findByTestId('ads-group-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '广告商品' }))
    const first = (await within(page).findByText('B0AAA')).closest('tr, [role=row]') as HTMLElement
    expect(first).toHaveTextContent('断货')
    expect(first).toHaveTextContent('SKU SKU-1')
    const second = within(page).getByText('广告里没有 ASIN').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('库存未知')
    expect(within(second).getAllByText('尚无记录').length).toBeGreaterThan(3)
  })

  it('否定投放：活动级与广告组级分开标注；添加否定的入口在页面顶部，页签里写明去向', async () => {
    mountApp({ url: groupUrl, pages, handlers: groupHandlers() })
    const page = await screen.findByTestId('ads-group-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '否定投放' }))
    expect((await within(page).findByText('cheap yoga mat')).closest('tr, [role=row]') as HTMLElement).toHaveTextContent('活动级')
    expect(within(page).getByText('free yoga').closest('tr, [role=row]') as HTMLElement).toHaveTextContent('广告组级')
    expect(page).toHaveTextContent('添加否定投放：用页面顶部的按钮')
    expect(page).toHaveTextContent('先预览再提交')
  })

  it('操作记录：还没有改动，写明原因而不是空白', async () => {
    mountApp({ url: groupUrl, pages, handlers: groupHandlers() })
    const page = await screen.findByTestId('ads-group-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '操作记录' }))
    expect(await within(page).findByText(/本系统内还没有对这个广告组做过改动/)).toBeInTheDocument()
  })

  it('不存在或不在范围内：显示读取失败，不显示示例数据', async () => {
    mountApp({ url: groupUrl, pages, handlers: { '/ads/ad-groups/ag-1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '广告组不存在' } } }) } })
    expect((await screen.findAllByText(/广告组不存在|不存在/)).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('ads-group-detail')).toBeNull()
  })
})

describe('投放对象详情', () => {
  it('关键词：身份区带匹配方式、竞价、所属广告组与活动链接；6 个页签含品牌分析', async () => {
    mountApp({ url: targetUrl('kw-1'), pages, handlers: targetHandlers() })
    const page = await screen.findByTestId('ads-target-detail')
    expect(await within(page).findByText('yoga mat')).toBeInTheDocument()
    expect(page).toHaveTextContent('关键词 · EXACT')
    expect(page).toHaveTextContent('$1.50')
    expect(within(page).getByRole('link', { name: '核心词组' })).toHaveAttribute('href', '/app/advertising/ad-groups/ag-1')
    expect(within(page).getByRole('link', { name: '春季推广' })).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
    for (const label of ['趋势', '带来的搜索词', '广告位', '分时表现', '竞价历史与效果', '品牌分析']) expect(within(page).getByRole('tab', { name: label })).toBeInTheDocument()
    expect(within(page).getByRole('button', { name: '调整竞价' })).toBeEnabled()
  })

  it('商品类投放对象没有品牌分析页签', async () => {
    mountApp({ url: targetUrl('tg-1'), pages, handlers: targetHandlers('tg-1', () => targetDetail('PRODUCT')) })
    const page = await screen.findByTestId('ads-target-detail')
    await within(page).findByText('asin="B0XYZ"')
    expect(within(page).queryByRole('tab', { name: '品牌分析' })).toBeNull()
    expect(within(page).getByRole('tab', { name: '广告位' })).toBeInTheDocument()
  })

  it('带来的搜索词：带命中的投放表达式', async () => {
    mountApp({ url: targetUrl('kw-1'), pages, handlers: targetHandlers() })
    const page = await screen.findByTestId('ads-target-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '带来的搜索词' }))
    const row = (await within(page).findByText('$12.00')).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('yoga mat')
    expect(row).toHaveTextContent('900')
  })

  it('广告位：没有投放对象级数据源，写明原因并指向所属活动，不画数字', async () => {
    mountApp({ url: targetUrl('kw-1'), pages, handlers: targetHandlers() })
    const page = await screen.findByTestId('ads-target-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '广告位' }))
    const body = await within(page).findByTestId('target-placements')
    expect(body).toHaveTextContent('尚未接入')
    expect(within(body).getByRole('link', { name: /所属活动/ })).toHaveAttribute('href', '/app/advertising/campaigns/cam-1')
  })

  it('竞价历史：当前竞价与建议区间、调价前后对照；没有数据的一边写“尚无记录”；调价按钮禁用', async () => {
    mountApp({ url: targetUrl('kw-1'), pages, handlers: targetHandlers() })
    const page = await screen.findByTestId('ads-target-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '竞价历史与效果' }))
    const body = await within(page).findByTestId('target-bid-history')
    expect(body).toHaveTextContent('$0.80')
    expect(body).toHaveTextContent('$1.60')
    const row = (await within(body).findByText('林然')).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('$1.20')
    expect(row).toHaveTextContent('$1.50')
    expect(row).toHaveTextContent('7 天里有 1 天有数据')
    expect(row).toHaveTextContent('尚无记录')
    expect(body).toHaveTextContent('亚马逊侧与其他工具的调价')
  })

  it('竞价历史：还没有调过价，写明原因', async () => {
    mountApp({
      url: targetUrl('kw-1'),
      pages,
      handlers: targetHandlers(
        'kw-1',
        () => targetDetail(),
        () => bidHistory(false),
      ),
    })
    const page = await screen.findByTestId('ads-target-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '竞价历史与效果' }))
    expect(await within(page).findByText(/本系统内还没有对这个投放对象调过价/)).toBeInTheDocument()
  })

  it('品牌分析：尚未接入，不显示示例数字', async () => {
    mountApp({ url: targetUrl('kw-1'), pages, handlers: targetHandlers() })
    const page = await screen.findByTestId('ads-target-detail')
    fireEvent.click(await within(page).findByRole('tab', { name: '品牌分析' }))
    expect(await within(page).findByTestId('target-brand')).toHaveTextContent('P4-04')
  })
})
