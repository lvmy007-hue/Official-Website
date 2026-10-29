import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { emptyViewConfig } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { occurrences, rowTextOf } from '../../test/grid-rows'
import { dropRow, emptyPerf, noTrafficRow, ok, perfHandlers, perfResponse, perfRow } from './listing-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 刊登表现（P4-09）：假服务端返回固定数据，验证列的真实数字与“尚无记录 / 无权限 / 尚未接入”（不写 0）、筛选与排序随请求带出、
// 异常分布（转化率骤降可点击筛选，其余尚未接入）、对比模式、保存视图与列配置、空状态与读取失败。

const pages: LivePages = { ListingPerformancePage: { load: () => import('./ListingPerformancePage') } }
const url = '/app/listings'
beforeEach(() => window.localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

const open = async (response = () => perfResponse(), extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url, pages, me, handlers: { ...perfHandlers(response), ...extra } })
  const page = within(await screen.findByTestId('listing-performance-page'))
  await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
  return { app, page }
}
const paramsOf = (app: { calls: Array<{ path: string; search: string }> }, test: (params: URLSearchParams) => boolean) =>
  app.calls.filter(call => call.path === '/listings/performance' && test(new URLSearchParams(call.search)))

describe('刊登表现：表格', () => {
  it('有数据：标题链到 ASIN 360，流量、销售、转化率（含上期）、广告、退货、可售天数都显示；共用销售标“共用”', async () => {
    const { page } = await open()
    const link = page.getByRole('link', { name: '玻璃保鲜盒套装' })
    expect(link).toHaveAttribute('href', '/app/products/p1')
    const first = rowTextOf(link)
    for (const text of ['B0TEST0001 · SKU-1', '$400.00', '共用', '10.0%', '上期 20.0%', '80.0%', '$100.00', '5.0%', '10.0 天', '在售', '林然']) expect(first).toContain(text)
  })

  it('没有记录的列写“尚无记录”，不写 0；评分、评分数、刊登问题数、质量分写“尚未接入”', async () => {
    const { page } = await open()
    const row = rowTextOf(page.getByText('没有流量的商品'))
    expect(occurrences(row, '尚无记录')).toBeGreaterThanOrEqual(8)
    expect(row).not.toContain('$0.00')
    expect(row).toContain('未指定')
    expect(occurrences(row, '尚未接入')).toBe(4)
    expect(page.getAllByText('尚未接入').length).toBeGreaterThanOrEqual(4)
  })

  it('没有广告、退货、库存权限：对应列写“无权限”并说明原因，其余照常', async () => {
    const need = (text: string) => ({ state: 'RESTRICTED' as const, note: text })
    const { page } = await open(() =>
      perfResponse({
        gates: {
          traffic: { state: 'OK', note: null },
          ads: need('需要“广告”读取权限才能查看广告销售'),
          returns: need('需要“退货”读取权限才能查看退货率'),
          stock: need('需要“库存”读取权限才能查看可售天数'),
        },
        items: [perfRow({ adsSales: null, returnRate: null, daysOfSupply: null })],
      }),
    )
    const row = rowTextOf(page.getByText('玻璃保鲜盒套装'))
    expect(occurrences(row, '无权限')).toBe(3)
    expect(row).toContain('$400.00')
    expect(page.getByText(/需要“广告”读取权限/)).toBeInTheDocument()
    expect(page.getByText(/需要“退货”读取权限/)).toBeInTheDocument()
    expect(page.getByText(/需要“库存”读取权限/)).toBeInTheDocument()
  })

  it('没有流量记录：销售与流量列整体写“尚无记录”，并写出原因', async () => {
    const note = '所选日期范围内没有销售与流量记录：数据中心的销售与流量每天同步一次'
    const { page } = await open(() => perfResponse({ gates: { ...perfResponse().gates, traffic: { state: 'NO_DATA', note } }, items: [noTrafficRow({ title: '玻璃保鲜盒套装' })] }))
    expect(page.getByText(/销售与流量：所选日期范围内没有销售与流量记录/)).toBeInTheDocument()
    const row = rowTextOf(page.getByText('玻璃保鲜盒套装'))
    expect(row).not.toContain('$0.00')
    expect(occurrences(row, '尚无记录')).toBeGreaterThanOrEqual(5)
  })

  it('商品超过读取上限：如实提示', async () => {
    mountApp({ url, pages, handlers: perfHandlers(() => perfResponse({ truncated: true })) })
    expect(await screen.findByText(/商品数量超过读取上限/, {}, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('还没有同步到商品：写明原因，不画示例行', async () => {
    mountApp({ url, pages, handlers: perfHandlers(() => emptyPerf()) })
    expect(await screen.findByText(/还没有同步到商品/, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '玻璃保鲜盒套装' })).toBeNull()
  })

  it('读取失败：显示错误，不显示示例数字', async () => {
    mountApp({
      url,
      pages,
      handlers: {
        '/listings/performance': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }),
        '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
      },
    })
    await screen.findByTestId('listing-performance-page')
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 20_000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('玻璃保鲜盒套装')).toBeNull()
  }, 30_000)
})
describe('刊登表现：趋势与异常', () => {
  it('趋势图出现并可切换指标', async () => {
    const { page } = await open()
    expect(page.getByRole('img', { name: '刊登表现趋势图' })).toBeInTheDocument()
    expect(page.getByText(/的销售额$/)).toBeInTheDocument()
    fireEvent.click(page.getByRole('radio', { name: '转化率' }))
    expect(await page.findByText(/的转化率$/)).toBeInTheDocument()
  })

  it('没有趋势数据：写明原因，不画 0', async () => {
    mountApp({ url, pages, handlers: perfHandlers(() => emptyPerf()) })
    expect(await screen.findByText(/所选日期范围内没有销售与流量记录/, {}, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('异常分布：转化率骤降显示计数且可点击筛选；其余三类写“尚未接入”，没有计数', async () => {
    const { app, page } = await open(() => perfResponse({ items: [dropRow(), perfRow()] }))
    const cards = within(page.getByTestId('listing-anomalies'))
    const drop = cards.getByRole('button', { name: /转化率骤降/ })
    expect(drop).toHaveTextContent('1')
    for (const label of ['推荐报价丢失', '刊登问题新增', '被搜索抑制']) {
      const card = cards.getByText(label).closest('.ant-card') as HTMLElement
      expect(card).toHaveTextContent('尚未接入')
      expect(within(card).queryByRole('button')).toBeNull()
    }
    fireEvent.click(drop)
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('anomaly') === 'CONVERSION_DROP')).not.toHaveLength(0))
    expect(cards.getByRole('button', { name: /转化率骤降/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(cards.getByRole('button', { name: /转化率骤降/ }))
    await vi.waitFor(() => expect(cards.getByRole('button', { name: /转化率骤降/ })).toHaveAttribute('aria-pressed', 'false'))
  })

  it('没有可比较的商品：转化率骤降写“尚无记录”', async () => {
    const { page } = await open(() => perfResponse({ anomalies: emptyPerf().anomalies }))
    const card = within(page.getByTestId('listing-anomalies')).getByText('转化率骤降').closest('.ant-card') as HTMLElement
    expect(card).toHaveTextContent('尚无记录')
  })
})

describe('刊登表现：筛选与排序', () => {
  it('默认按销售额从高到低；搜索随请求带出，并从第一块重新取', async () => {
    const { app, page } = await open()
    expect(paramsOf(app, params => params.get('sort') === 'sales:desc' && !params.has('cursor'))).not.toHaveLength(0)
    const search = page.getByRole('searchbox', { name: '搜索商品' })
    fireEvent.change(search, { target: { value: 'B0TEST' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 })
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('q') === 'B0TEST' && !params.has('cursor'))).not.toHaveLength(0))
  })

  it('游标无限滚动：每块 100 行，请求不带页码；表头给出“约 N 行”', async () => {
    const { app, page } = await open(() => perfResponse({ pageInfo: { hasMore: true, nextCursor: 'c2', approxTotal: 3 } as never }))
    expect(await page.findByText('约 3 行')).toBeInTheDocument()
    const first = paramsOf(app, () => true)[0]!
    expect(new URLSearchParams(first.search).get('pageSize')).toBe('100')
    expect(new URLSearchParams(first.search).has('page')).toBe(false)
  })
})

describe('刊登表现：对比、列设置与视图', () => {
  const pick = async (ids: string[]) => {
    for (const id of ids) {
      const box = await waitFor(() => {
        const found = document.querySelector(`[row-id="${id}"] input[type="checkbox"]`) as HTMLInputElement | null
        if (!found) throw new Error(`row ${id} not ready`)
        return found
      })
      fireEvent.click(box)
    }
  }

  it('对比：选 2 个商品才能点；并排显示各自数字，较优的标出，没有记录写“尚无记录”', async () => {
    const { page } = await open(() =>
      perfResponse({ items: [perfRow(), noTrafficRow(), perfRow({ id: 'p2', sku: 'SKU-2', title: '另一个商品', sales: 100, units: 5, conversion: 0.05, returnRate: 0.2 })] }),
    )
    expect(page.getByRole('button', { name: /对比所选/ })).toBeDisabled()
    await pick(['p1'])
    expect(page.getByRole('button', { name: /对比所选/ })).toBeDisabled()
    await pick(['p2'])
    await waitFor(() => expect(page.getByRole('button', { name: /对比所选/ })).toBeEnabled())
    await userEvent.click(page.getByRole('button', { name: /对比所选/ }))
    const drawer = within(await screen.findByRole('dialog'))
    expect(drawer.getByText('对比 2 个商品')).toBeInTheDocument()
    const sales = rowTextOf(await drawer.findByText('销售额'))
    expect(sales).toContain('$400.00')
    expect(sales).toContain('$100.00')
    expect(occurrences(sales, '较优')).toBe(1)
    // 退货率越低越好：商品 1（5%）优于商品 2（20%）
    expect(occurrences(rowTextOf(drawer.getByText('退货率')), '较优')).toBe(1)
    expect(rowTextOf(drawer.getByText('价格'))).not.toContain('较优')
  })

  it('列设置：取消勾选的列从表格里去掉（列设置与视图由表格自带）', async () => {
    const { page } = await open()
    expect(page.getByRole('columnheader', { name: '品牌' })).toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: /列设置/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: '品牌' }))
    await waitFor(() => expect(page.queryByRole('columnheader', { name: '品牌' })).toBeNull())
  })

  it('默认视图带筛选：套用后筛选随请求发出；认不出的字段丢掉并提示“有 N 个条件已失效”', async () => {
    const saved = {
      id: 'v1',
      gridId: 'listings.performance',
      kind: 'VIEW',
      scope: 'USER',
      name: '看 Zeta',
      config: { ...emptyViewConfig(), filters: { brand: 'Zeta', fulfillment: 'BAD', secret: 'x' } },
      isDefault: true,
      version: 1,
      mine: true,
      canEdit: true,
      owner: { id: 'u1', name: '林然' },
      updatedAt: '2026-10-26T08:00:00.000Z',
    }
    const { app } = await open(() => perfResponse(), { '/grid-views': () => ok({ items: [saved], canShare: false, limits: { user: 20, team: 30 } }) })
    await vi.waitFor(() => expect(paramsOf(app, params => params.get('brand') === 'Zeta')).not.toHaveLength(0))
    expect(paramsOf(app, params => params.has('fulfillment') || params.has('secret'))).toHaveLength(0)
    expect(await screen.findByText('有 2 个条件已失效，已忽略')).toBeInTheDocument()
  })
})
