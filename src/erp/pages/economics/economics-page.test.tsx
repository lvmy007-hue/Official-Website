import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { compare, noChangeRow, ok, preview, simulation, unknownQuantityRow } from './economics-fixtures.test-helper'

// 官方经济数据对账页（P2b-11）：双源核对（差异分类、店铺广告核对、无法核对、权限、没有数据、翻页与过滤请求参数）、费用预览（算不出影响的写明原因）、
// 情景模拟（校验、提交、排队中轮询到完成）。页面上不出现拿 0 冒充的金额。

const pages: LivePages = { EconomicsReconciliationPage: { load: () => import('./EconomicsReconciliationPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/finance/economics?storeIds=st1&from=2026-10-01&to=2026-10-10'
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/economics/compare': () => ok(compare()),
  '/finance/economics/preview': () => ok(preview()),
  ...over,
})
const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }, { timeout: 15000 }))
const rowOf = (text: string) => screen.getByText(text).closest('tr, [role=row]') as HTMLElement
const T = { timeout: 30000 }

describe('双源核对', () => {
  it('显示差异分类、店铺广告核对和每行官方与我方的数；无法核对的行写原因，没有的数写“尚无记录”', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    const summary = await screen.findByTestId('economics-summary', {}, { timeout: 15000 })
    expect(summary).toHaveTextContent('可核对行数')
    expect(summary).toHaveTextContent('可核对行数2/ 3')
    expect(summary).toHaveTextContent('-$10.00')

    const classes = screen.getByTestId('economics-classes')
    expect(classes).toHaveTextContent('成本口径：-$2.00（1 行）')
    expect(classes).toHaveTextContent('广告口径：-$8.00（1 行）')
    expect(classes).toHaveTextContent('时间口径')
    expect(classes).toHaveTextContent('未解释')
    expect(screen.getByTestId('economics-ads')).toHaveTextContent('店铺广告核对：官方 $8.00，我方 $5.00，差额（官方−我方）+$3.00')

    const adsRow = rowOf('SKU-ADS')
    expect(adsRow).toHaveTextContent('尚未分摊')
    expect(within(adsRow).getByText('广告口径')).toBeInTheDocument()
    expect(within(adsRow).getByText('-$10.00')).toBeInTheDocument()

    const noneRow = rowOf('SKU-NONE')
    expect(within(noneRow).getByText('无法核对')).toBeInTheDocument()
    expect(noneRow).toHaveTextContent('官方经济数据在所选区间没有这个 SKU 的记录')
    expect(within(noneRow).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(4)
    expect(within(rowOf('SKU-MATCH')).getByText('一致')).toBeInTheDocument()

    expect(screen.getByTestId('economics-notes')).toHaveTextContent('近 14 天会被官方修正后重拉')
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    const params = new URLSearchParams(app.calls.find(call => call.path === '/finance/economics/compare')!.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('recognition')).toBe('ORDERED')
    expect(params.get('verdict')).toBe('ALL')
  })

  it('过滤结论后请求带新参数并回到第一页；有下一页时可翻页', T, async () => {
    const calls: string[] = []
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/economics/compare': url => {
          calls.push(url.search)
          return ok(compare({ pageInfo: { hasMore: url.searchParams.get('cursor') === null, nextCursor: 'c2', approxTotal: 25, pageSize: 20 } }))
        },
      }),
    })
    await screen.findByTestId('economics-summary', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('button', { name: /下一页/ }))
    await waitFor(() => expect(calls.some(search => new URLSearchParams(search).get('cursor') === 'c2')).toBe(true))
    await userEvent.click(await screen.findByText('只看有差异'))
    await waitFor(() => expect(new URLSearchParams(calls[calls.length - 1]).get('verdict')).toBe('DIFF'))
    expect(new URLSearchParams(calls[calls.length - 1]).get('cursor')).toBeNull()
    expect(app.calls.filter(call => call.path === '/finance/economics/compare').length).toBeGreaterThanOrEqual(3)
  })

  it('没有官方数据时显示说明；数据被截断时提示不完整；默认日期范围会写明', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/economics/compare': () =>
          ok(
            compare({
              state: 'NO_DATA',
              note: '官方经济数据尚未拉取，请等待第一次同步完成',
              items: [],
              truncated: true,
              officialCoverage: null,
              range: { from: '2026-09-24', to: '2026-10-23', days: 30, defaulted: true },
            }),
          ),
      }),
    })
    expect(await screen.findByTestId('economics-note', {}, { timeout: 15000 })).toHaveTextContent('官方经济数据尚未拉取')
    expect(screen.getByText('数据行数超过读取上限，核对不完整')).toBeInTheDocument()
    expect(screen.getByText(/未选择日期范围，当前核对 2026-09-24 至 2026-10-23/)).toBeInTheDocument()
  })

  it('没有利润字段与成本字段权限：提示无权查看，不请求核对接口', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers({}, ['finance.read', 'field.profit']) })
    expect(await screen.findByText('无权查看', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/finance/economics/compare')).toBe(false)
  })

  it('接口失败时显示错误并可重试', T, async () => {
    let fail = true
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({ '/finance/economics/compare': () => (fail ? { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: '服务繁忙' } } } : ok(compare())) }),
    })
    expect(await screen.findByText(/服务繁忙/, {}, { timeout: 15000 })).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(await screen.findByTestId('economics-summary', {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('费用预览', () => {
  it('列出费用类型汇总和商品明细；算不出影响的行写明原因而不是 0', T, async () => {
    const app = mountApp({ url: PAGE, pages, handlers: handlers() })
    await openTab('费用预览')
    const summary = await screen.findByTestId('economics-preview-summary', {}, { timeout: 15000 })
    expect(summary).toHaveTextContent('合计对利润的影响')
    expect(summary).toHaveTextContent('-$2.00')
    expect(screen.getByText(/官方预览覆盖 2026-10-24 至 2027-02-20/)).toBeInTheDocument()

    const unknown = rowOf(unknownQuantityRow.msku)
    expect(unknown).toHaveTextContent('官方未给预估数量')
    expect(unknown).toHaveTextContent('官方未提供')
    expect(rowOf(noChangeRow.msku)).toHaveTextContent('官方没有给出费用调整')
    expect(screen.getAllByText('官方未给预估数量').length).toBeGreaterThanOrEqual(2)

    await userEvent.click(screen.getByRole('switch', { name: '只看有费用调整的行' }))
    await waitFor(() => {
      const last = app.calls.filter(call => call.path === '/finance/economics/preview').pop()!
      expect(new URLSearchParams(last.search).get('changedOnly')).toBe('true')
    })
  })

  it('官方预览没有数据时显示说明', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/economics/preview': () =>
          ok(
            preview({
              state: 'NO_DATA',
              note: '官方费用预览尚无记录',
              items: [],
              horizon: null,
              queriedAt: null,
              summary: { products: 0, rows: 0, changedRows: 0, unknownRows: 0, totalImpact: null, byFeeType: [] },
            }),
          ),
      }),
    })
    await openTab('费用预览')
    expect(await screen.findByTestId('economics-note', {}, { timeout: 15000 })).toHaveTextContent('官方费用预览尚无记录')
  })
})

describe('情景模拟', () => {
  const fillStoreAndSku = async () => {
    await userEvent.click(await screen.findByRole('combobox', { name: '模拟店铺' }, { timeout: 15000 }))
    const options = await screen.findAllByTitle('Northstar US')
    await userEvent.click(options[options.length - 1]!)
    await userEvent.type(screen.getByRole('textbox', { name: 'SKU' }), 'SKU-ADS')
  }

  it('发往上游仓储必须填数量；提交后先显示排队中，轮询到完成后显示官方估算', { timeout: 40000 }, async () => {
    let body: Record<string, unknown> | null = null
    let polls = 0
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/economics/simulate': (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return { status: 201, body: { success: true, data: simulation() } }
        },
        '/finance/economics/simulations/r1': () => {
          polls += 1
          if (polls === 1) return ok(simulation())
          return ok(simulation({ status: 'DONE', note: null, result: { currency: 'USD', sales: 500, fees: 120, netProceeds: 380, units: 50, rows: 1 } }))
        },
      }),
    })
    await openTab('情景模拟')
    await fillStoreAndSku()
    await userEvent.click(screen.getByRole('button', { name: /提交模拟/ }))
    expect(await screen.findByText('发往上游仓储需要填写数量')).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/finance/economics/simulate')).toBe(false)

    await userEvent.type(screen.getByRole('spinbutton', { name: '数量' }), '50')
    await userEvent.click(screen.getByRole('button', { name: /提交模拟/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toMatchObject({ sellerAccountId: 'st1', sku: 'SKU-ADS', actionType: 'AWD', quantity: 50, endInDays: 30 })
    expect(await screen.findByText('排队中')).toBeInTheDocument()

    const result = await screen.findByTestId('economics-run-result', {}, { timeout: 15000 })
    expect(result).toHaveTextContent('$500.00')
    expect(result).toHaveTextContent('$380.00')
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(polls).toBeGreaterThanOrEqual(1)
  })

  it('失败的模拟显示官方给出的原因', { timeout: 40000 }, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/economics/simulate': () => ({
          status: 201,
          body: { success: true, data: simulation({ status: 'FAILED', note: '亚马逊数据中心拒绝了这次查询：SKU 不存在', input: { ...simulation().input, actionType: 'SIPP', quantity: null } }) },
        }),
      }),
    })
    await openTab('情景模拟')
    await fillStoreAndSku()
    await userEvent.click(screen.getByText(/原包装发货/))
    expect(screen.queryByRole('spinbutton', { name: '数量' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /提交模拟/ }))
    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(screen.getByText('亚马逊数据中心拒绝了这次查询：SKU 不存在')).toBeInTheDocument()
    expect(screen.queryByTestId('economics-run-result')).not.toBeInTheDocument()
  })
})
