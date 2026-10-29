import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ADS_ASIN_HALO_NOTE } from '@nova/api-contracts'
import { mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { countsResponse, rowText } from './ads-campaigns-fixtures.test-helper'
import { emptyList, listHandlers, listResponse } from './ads-products-fixtures.test-helper'

// 广告商品页（P3-09；P6-23 迁到统一骨架）：假服务端返回固定数据，验证按“店铺 × ASIN”汇总的指标与占比、自然销售额口径不符的标注、没有来源与没有记录的写法（不写 0）、
// 断货标红与汇总、批量暂停与复制禁用并说明原因、末列分析置灰并写原因、筛选与排序随请求带出、空状态、读取失败。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { AdsProductsPage: { load: () => import('./AdsProductsPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/products'
const withCounts = (handlers: ReturnType<typeof listHandlers>) => ({ ...handlers, '/ads/products/counts': () => ok(countsResponse({ level: 'products' })) })
const open = async (response = () => listResponse()) => {
  const app = mountApp({ url, pages, handlers: withCounts(listHandlers(response)) })
  const page = await screen.findByTestId('ads-products-page')
  await within(page).findByText('B0AAA')
  return { app, page }
}

describe('广告商品', () => {
  it('有数据：一行一个“店铺 × ASIN”，指标、全部销售额、占比、自然销售额、光环、活动数与在投广告数显示', async () => {
    await open()
    const first = rowText('s1|B0AAA')
    for (const text of ['瑜伽垫 加厚', 'Northstar US', '有货', '$40.00', '$160.00', '25.0%', '$400.00', '10.0%', '$240.00', '$15.00', '2 / 3']) expect(first).toContain(text)
    expect(screen.getByText(/未选择日期范围，当前显示 2026-09-23 至 2026-10-22/)).toBeInTheDocument()
  })

  it('广告销售额大于全部销售额：自然销售额不给数，标“口径不符”；光环为 0 如实显示 0', async () => {
    await open()
    const second = rowText('s1|B0BBB')
    for (const text of ['口径不符', '断货', '$0.00', '50.0%']) expect(second).toContain(text)
  })

  it('什么都没有的商品：总销售额、占比、自然销售额、光环、在投广告都写“尚无记录”，不写 0；未绑定店铺与库存未知写明', async () => {
    await open()
    const third = rowText('-|B0CCC')
    for (const text of ['商品资料尚未同步', '未绑定店铺', '库存未知']) expect(third).toContain(text)
    expect(third.split('尚无记录').length - 1).toBeGreaterThanOrEqual(6)
    expect(third).not.toContain('$0.00')
  })

  it('广告分摊后的利润写“尚未接入”；转化商品日报还没有记录时，光环每行写“尚无记录”（不是 0）并在顶部说明', async () => {
    await open(() => listResponse({ halo: { state: 'NOT_CONNECTED', note: ADS_ASIN_HALO_NOTE } }))
    const first = rowText('s1|B0AAA')
    expect(first).toContain('尚未接入')
    expect(first).not.toContain('$15.00')
    expect(screen.getByText(/光环销售额：光环销售来自/)).toBeInTheDocument()
  })

  it('汇总条：商品数、花费、广告销售额；断货商品数与仍在花的钱', async () => {
    await open()
    const summary = await screen.findByTestId('ads-products-summary')
    expect(summary).toHaveTextContent('商品 3 个')
    expect(summary).toHaveTextContent('花费 $69.00')
    expect(summary).toHaveTextContent('广告销售额 $260.00')
    expect(summary).toHaveTextContent('断货商品 1 个，仍花费 $25.00')
  })

  it('汇总行取服务端的汇总请求（pageSize=1），用响应里的 level 字段', async () => {
    const { app } = await open()
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/products' && new URLSearchParams(call.search).get('pageSize') === '1')).toBe(true))
  })

  it('批量暂停、启用、复制到其他广告组禁用（没有批量写入口）', async () => {
    const { page } = await open()
    await userEvent.click(document.querySelector('.ag-row .ag-selection-checkbox input') as HTMLElement)
    const bar = within(await within(page).findByRole('toolbar', { name: '批量操作' }))
    for (const name of ['暂停全部相关广告', '启用全部相关广告', '复制到其他广告组']) expect(bar.getByRole('button', { name })).toBeDisabled()
    expect(bar.getByText('已选 1 个')).toBeInTheDocument()
  })

  it('末列分析：广告商品没有对象级趋势接口，图标置灰', async () => {
    const { page } = await open()
    expect(within(page).getAllByRole('button', { name: '分析（不可用）' }).length).toBeGreaterThan(0)
  })

  it('默认按花费从高到低；地址里的库存筛选随请求带出', async () => {
    const app = mountApp({ url: `${url}?stock=OUT_OF_STOCK`, pages, handlers: withCounts(listHandlers(() => listResponse())) })
    const page = await screen.findByTestId('ads-products-page')
    await within(page).findByText('B0AAA')
    const first = app.calls.find(call => call.path === '/ads/products' && new URLSearchParams(call.search).get('pageSize') !== '1')!
    const params = new URLSearchParams(first.search)
    expect(params.get('sort')).toBe('spend:desc')
    expect(params.get('stock')).toBe('OUT_OF_STOCK')
  })

  it('还没有同步被推广商品：写明原因，不画示例行', async () => {
    mountApp({ url, pages, handlers: withCounts(listHandlers(() => emptyList())) })
    expect((await screen.findAllByText(/被推广商品日报表还没有同步/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('B0AAA')).toBeNull()
    expect(screen.queryByTestId('ads-products-summary')).toBeNull()
  })

  it('读取上限与非美元：如实提示', async () => {
    mountApp({ url, pages, handlers: withCounts(listHandlers(() => listResponse({ truncated: true, metricsTruncated: true, note: '指标只含美元广告账户；非美元的被推广商品行没有并入（不折算）' }))) })
    expect(await screen.findByText(/数量超过读取上限，只处理了前一部分/)).toBeInTheDocument()
    expect(screen.getByText(/报表分组超过读取上限/)).toBeInTheDocument()
    expect(screen.getByText(/非美元的被推广商品行没有并入/)).toBeInTheDocument()
  })

  it('口径说明常驻页面', async () => {
    await open()
    const basis = await screen.findByTestId('ads-products-basis')
    expect(basis).toHaveTextContent('自然销售额 = 该 ASIN 的全部销售额（订单口径）− 广告销售额（广告归因口径）')
    expect(basis).toHaveTextContent('花费为空的报表行')
  })

  it('读取失败：不显示示例数字', async () => {
    mountApp({ url, pages, handlers: { '/ads/products': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    const page = await screen.findByTestId('ads-products-page')
    await vi.waitFor(() => expect(within(page).queryByText('B0AAA')).toBeNull())
  })
})
