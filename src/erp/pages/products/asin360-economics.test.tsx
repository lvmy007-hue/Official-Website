import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { costsFixture, economicsFixture, identityFixture, officialFixture, previewFixture, returnsFixture } from './asin360-economics-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// ASIN 360 利润与成本、退货页签（P2b-17）：每件经济、价格模拟器、官方对照、费用预览、成本版本；退货率、原因、处置、关联赔付。

const pages: LivePages = {
  Asin360Page: { load: () => import('./Asin360Page') },
  ReturnDetailPage: { load: () => import('../returns/ReturnDetailPage') },
  ReimbursementDetailPage: { load: () => import('../reimbursements/ReimbursementDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())
const ok = (data: unknown) => ({ body: { success: true, data } })
const RANGE = { from: '2026-10-01', to: '2026-10-02', days: 2 }
const FULL = ['products.read', 'profit.read', 'field.profit', 'field.cost', 'finance.read', 'costs.read', 'returns.read', 'reimbursements.read']

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = FULL): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/products/p1': () => ok(identityFixture()),
  '/products/p1/overview': () =>
    ok({
      period: RANGE,
      previous: RANGE,
      yoy: RANGE,
      hasRows: false,
      cards: [],
      daily: [],
      table: [],
      attribution: null,
      compare: null,
      defaulted: true,
      currency: 'USD',
      split: { state: 'NO_DATA', note: null },
      profit: { state: 'NO_DATA', note: null },
      refunds: { note: '' },
    }),
  '/products/p1/actions': () => ok({ state: 'NO_DATA', note: null, inventoryId: null, items: [] }),
  '/products/p1/economics': () => ok(economicsFixture()),
  '/products/p1/economics/official': () => ok(officialFixture()),
  '/products/p1/economics/preview': () => ok(previewFixture()),
  '/products/p1/economics/costs': () => ok(costsFixture()),
  '/products/p1/returns': () => ok(returnsFixture()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})
const open = async (_label: string, over: Record<string, Handler> = {}, permissions: string[] = FULL) => {
  const app = mountApp({ url: '/app/products/p1', pages, handlers: handlers(over, permissions) })
  await screen.findByText('示例商品标题')
  return app
}

describe('页签入口', () => {
  it('有利润与退货权限：显示“利润与成本”“退货”；没有权限的不显示', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers() })
    await screen.findByText('示例商品标题')
    expect(screen.getByRole('tab', { name: '利润与成本' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '售后' })).toBeInTheDocument()
  })

  it('没有利润字段权限与退货读权限：两个页签都不出现', async () => {
    mountApp({ url: '/app/products/p1', pages, handlers: handlers({}, ['products.read']) })
    await screen.findByText('示例商品标题')
    expect(screen.queryByRole('tab', { name: '利润与成本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '售后' })).not.toBeInTheDocument()
  })
})

describe('利润与成本页签', () => {
  it('每件经济：平均售价、每件净利润、瀑布图与明细；没有数据的项目写原因，预期获胜价写尚未接入', async () => {
    const app = await open('利润与成本')
    expect(await screen.findByRole('img', { name: '商品每件经济瀑布图' })).toBeInTheDocument()
    const head = screen.getByTestId('asin360-economics-head')
    expect(within(head).getByText('$20.00')).toBeInTheDocument()
    expect(within(head).getByText('$5.67')).toBeInTheDocument()
    expect(within(head).getByText('100.0%')).toBeInTheDocument()
    expect(within(head).getByText('尚未接入')).toBeInTheDocument()
    const table = screen.getByTestId('asin360-unit-table')
    expect(within(table).getByText('平台佣金')).toBeInTheDocument()
    expect(table).toHaveTextContent('尚无记录') // 广告费没有数据：不是 0
    expect(screen.getByRole('img', { name: '商品利润趋势图' })).toBeInTheDocument()
    expect(screen.getByTestId('asin360-bridge')).toHaveTextContent('销售额')
    expect(app.calls.some(call => call.path === '/products/p1/economics')).toBe(true)
  })

  it('价格模拟器：输入目标售价算出每件净利润、净利率、变化与保本价，并写明假设', async () => {
    await open('利润与成本')
    const input = await screen.findByRole('spinbutton', { name: '目标售价' })
    await userEvent.clear(input)
    await userEvent.type(input, '25')
    const result = await screen.findByTestId('asin360-simulation')
    expect(result).toHaveTextContent('$9.58')
    expect(result).toHaveTextContent('38.3%')
    expect(result).toHaveTextContent('+$3.92')
    expect(result).toHaveTextContent('$12.77')
    expect(screen.getByText(/按售价等比例变化，其余费用/)).toBeInTheDocument()
    expect(screen.getByTestId('asin360-win-price')).toHaveTextContent('尚未接入')
  })

  it('有一行缺成本：每件净利润算不出，价格模拟器不可用并说明原因，不拿部分数字代替', async () => {
    await open('利润与成本', {
      '/products/p1/economics': () =>
        ok(
          economicsFixture({ unit: { ...economicsFixture().unit, state: 'INCOMPLETE', netPerUnit: null, proportionalShare: null, note: '有 1 行没有成本，每件净利润暂时算不出' }, costCoverage: 0.6 }),
        ),
    })
    expect(await screen.findByText('每件净利润暂时算不出')).toBeInTheDocument()
    expect(screen.getByText('暂时不能模拟')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: '目标售价' })).not.toBeInTheDocument()
    expect(screen.getByTestId('asin360-economics-head')).toHaveTextContent('算不出')
  })

  it('范围内没有利润数据：写明原因，图表给空状态', async () => {
    await open('利润与成本', {
      '/products/p1/economics': () =>
        ok(
          economicsFixture({
            state: 'NO_DATA',
            note: '所选范围内没有这个商品的利润记录',
            trend: [],
            unit: { state: 'NO_UNITS', note: null, units: 0, avgPrice: null, netPerUnit: null, proportionalShare: null, lines: [] },
            costCoverage: null,
          }),
        ),
    })
    expect(await screen.findByText('所选范围内没有这个商品的利润数据')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '商品利润趋势图' })).not.toBeInTheDocument()
    expect(screen.getByText('暂时不能模拟')).toBeInTheDocument()
  })

  it('官方对照、费用预览、成本版本：没有数据时各写各的原因', async () => {
    await open('利润与成本')
    expect(await screen.findByText(/这个商品在所选范围内没有官方单品经济记录/)).toBeInTheDocument()
    expect(await screen.findByText(/官方最近一次费用预览里没有这个 SKU/)).toBeInTheDocument()
    expect(await screen.findByText(/这个 SKU 还没有任何成本版本/)).toBeInTheDocument()
  })

  it('没有成本字段权限：官方对照与成本版本写明需要的权限，且不请求那两个接口', async () => {
    const app = await open('利润与成本', {}, ['products.read', 'profit.read', 'field.profit', 'finance.read', 'returns.read'])
    expect(await screen.findByTestId('asin360-official')).toHaveTextContent('无权查看')
    expect(screen.getByTestId('asin360-costs')).toHaveTextContent('无权查看')
    expect(await screen.findByText(/官方最近一次费用预览里没有这个 SKU/)).toBeInTheDocument() // 费用预览只要 finance.read
    expect(app.calls.some(call => call.path === '/products/p1/economics/official')).toBe(false)
    expect(app.calls.some(call => call.path === '/products/p1/economics/costs')).toBe(false)
    expect(app.calls.some(call => call.path === '/products/p1/economics/preview')).toBe(true)
  })

  it('读取失败：只这一块报错，其他块照常', async () => {
    await open('利润与成本', { '/products/p1/economics/official': () => ({ status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '官方对照一次最多看 90 天，请缩小日期范围' } } }) })
    expect(await screen.findByText(/官方对照一次最多看 90 天/)).toBeInTheDocument()
    expect(screen.getByTestId('asin360-simulator')).toBeInTheDocument()
  })
})

describe('退货页签', () => {
  it('汇总、退货率、趋势、原因与处置分布、最近退货链接与关联赔付', async () => {
    const app = await open('退货')
    const totals = await screen.findByTestId('asin360-return-totals')
    expect(totals).toHaveTextContent('10.00%')
    expect(totals).toHaveTextContent('30')
    expect(screen.getByRole('img', { name: '商品退货趋势图' })).toBeInTheDocument()
    expect(screen.getByTestId('asin360-return-reasons')).toHaveTextContent('商品有缺陷')
    expect(screen.getByTestId('asin360-return-dispositions')).toHaveTextContent('承运人损坏')
    const recent = screen.getByTestId('asin360-return-recent')
    expect(within(recent).getByRole('link', { name: '111-r1' })).toHaveAttribute('href', '/app/returns/r1')
    expect(within(recent).getByText('未提供原因')).toBeInTheDocument()
    const reimbursement = screen.getByTestId('asin360-return-reimbursements')
    expect(within(reimbursement).getByRole('link', { name: 'RC-1' })).toHaveAttribute('href', '/app/reimbursements/case-1')
    expect(screen.getByTestId('asin360-category-themes')).toHaveTextContent('尚未接入')
    expect(app.calls.some(call => call.path === '/products/p1/returns')).toBe(true)
  })

  it('没有退货记录：说明原因；没有销售汇总时退货率写“尚无记录”，不是 0%', async () => {
    await open('退货', {
      '/products/p1/returns': () =>
        ok(
          returnsFixture({
            state: 'NO_DATA',
            note: '所选范围内这个 ASIN 没有退货记录',
            totals: { returnedUnits: 0, soldUnits: null, rate: null },
            trend: [],
            reasons: [],
            dispositions: [],
            recent: [],
            reimbursements: { state: 'NO_DATA', note: '这个 ASIN 目前没有退货类的赔付机会', items: [] },
          }),
        ),
    })
    expect(await screen.findByText('所选范围内没有这个 ASIN 的退货记录')).toBeInTheDocument()
    expect(screen.getByTestId('asin360-return-totals')).toHaveTextContent('尚无记录')
    expect(screen.getByTestId('asin360-return-totals')).not.toHaveTextContent('0.00%')
    expect(screen.queryByRole('img', { name: '商品退货趋势图' })).not.toBeInTheDocument()
  })

  it('没有赔付读取权限：赔付块写“无权查看”，退货数据照常', async () => {
    await open('退货', { '/products/p1/returns': () => ok(returnsFixture({ reimbursements: { state: 'RESTRICTED', note: '需要赔付读取权限（reimbursements.read）', items: [] } })) })
    const block = await screen.findByTestId('asin360-return-reimbursements')
    expect(block).toHaveTextContent('无权查看')
    expect(block).toHaveTextContent('reimbursements.read')
    expect(screen.getByTestId('asin360-return-reasons')).toHaveTextContent('商品有缺陷')
  })
})
