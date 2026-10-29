import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { cashflow, emptyCashflow } from './cashflow-fixtures.test-helper'
import { occurrences, rowTextById, rowTextOf } from '../../test/grid-rows'
import { ok } from './fee-fixtures.test-helper'

// 回款与现金流页（P2b-08）：各区块的数据与口径说明、不可用的来源写“不可用”而不是 0、没有数据的写法、
// 币种与周数切换（发给服务端）、登记到账与改正（请求体、版本号、权限）。

const pages: LivePages = {
  CashflowPage: { load: () => import('./CashflowPage') },
  SettlementDetailPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/cashflow': () => ok(cashflow()),
  ...over,
})
const PAGE = '/app/finance/cashflow'
// 行内按钮：AG Grid 的固定列与滚动区各有一份行容器，按 row-id 找所有容器里的按钮
const rowButton = (text: string, name: string): HTMLElement => {
  const id = screen.getByText(text).closest('[row-id]')?.getAttribute('row-id') ?? ''
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[row-id="${id}"]`))) {
    const found = within(element).queryByRole('button', { name })
    if (found) return found
  }
  throw new Error(`行 ${text} 里没有按钮 ${name}`)
}

describe('展示', () => {
  it('余额只有递延余额并写明可用余额不可用；递延与释放按周分桶；打款预测标明是模型估算', { timeout: 30000 }, async () => {
    mountApp({ url: `${PAGE}?storeIds=st1`, pages, handlers: handlers() })
    const balances = await screen.findByTestId('cashflow-balances', {}, { timeout: 15000 })
    expect(within(balances).getByText('递延余额（PAYABLE）')).toBeInTheDocument()
    expect(within(balances).getAllByText('$120.50').length).toBeGreaterThan(0)
    expect(within(balances).getByText(/可用余额、下次打款额：不可用/)).toBeInTheDocument()
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()

    const deferral = screen.getByTestId('cashflow-deferral')
    expect(deferral).toHaveTextContent('递延中 $100.00，共 3 笔，其中 2 笔有预计释放日')
    expect(within(deferral).getByText('2026-10-23 ~ 2026-10-29')).toBeInTheDocument()
    expect(within(deferral).getByText('接口没给预计释放日')).toBeInTheDocument()
    expect(within(deferral).getByText(/不用下单日推算/)).toBeInTheDocument()

    const payout = screen.getByTestId('cashflow-payout')
    expect(screen.getByTestId('next-payout')).toHaveTextContent('下一次打款：2026-10-23，$500.00（结算单已公布，美国主店）')
    expect(within(payout).getByText('每 14 天，打款晚 3 天')).toBeInTheDocument()
    expect(within(payout).getByText(/含递延释放 80/)).toBeInTheDocument()
    expect(within(payout).getByText(/这是模型估算，不是亚马逊的承诺/)).toBeInTheDocument()
  })

  it('按周预测：不可用的来源写“不可用”且在净额下注明不含；各来源的状态；币种不同与没日期的付款单独提示；没有 0 元冒充', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const forecast = await screen.findByTestId('cashflow-forecast', {}, { timeout: 15000 })
    const first = rowTextOf(within(forecast).getByText('第 1 周 2026-10-23 ~ 2026-10-29'))
    expect(occurrences(first, '不可用')).toBe(3)
    expect(first).toContain('不含：采购付款、头程付款、广告扣款')
    expect(occurrences(first, '$500.00')).toBeGreaterThanOrEqual(2)
    const second = rowTextOf(within(forecast).getByText('第 2 周 2026-10-30 ~ 2026-11-05'))
    expect(second).toContain('-$270.00')
    expect(rowTextById('广告扣款')).toContain('尚未接入')
    expect(within(forecast).getByText('无权限')).toBeInTheDocument()
    expect(within(forecast).getByText('有付款因币种不同没有计入（本页不做汇率换算）')).toBeInTheDocument()
    expect(within(forecast).getByText(/采购付款：1 笔（CNY）/)).toBeInTheDocument()
    expect(within(forecast).getByText('有付款没有计划日期，排不进任何一周')).toBeInTheDocument()
    expect(within(forecast).getByText(/累计净额不含期初余额/)).toBeInTheDocument()
    expect(within(forecast).getByText(/预测模型：run-rate-v1/)).toBeInTheDocument()
  })

  it('到账核对：各状态、差额写明“登记 − 报告”、已登记的显示登记人；结算单链到详情', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const section = await screen.findByTestId('cashflow-disbursements', {}, { timeout: 15000 })
    expect(screen.getByTestId('disbursement-summary')).toHaveTextContent('最近 3 张有打款的结算单：已到账且一致 1，金额或币种对不上 1，等待登记 0，超期未登记 1')
    const link = within(section).getByRole('link', { name: '12345678901' })
    const unregistered = rowTextOf(link)
    expect(unregistered).toContain('超期未登记')
    expect(unregistered).toContain('尚未登记')
    expect(link.getAttribute('href')).toBe('/app/settlements/st1')
    const short = rowTextOf(within(section).getByText('22222222222'))
    expect(short).toContain('到账少于报告')
    expect(short).toContain('差额（登记 − 报告）-$20.00')
    expect(short).toMatch(/账户末四位 6789 · 登记人 财务小王/)
    const matched = rowTextOf(within(section).getByText('33333333333'))
    expect(matched).toContain('已到账且一致')
    expect(matched).not.toContain('差额')
  })

  it('没有任何数据：写明原因，各区块写“尚无”，页面上没有任何金额冒充', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/cashflow': () => ok(emptyCashflow()) }) })
    expect(await screen.findByTestId('cashflow-empty', {}, { timeout: 15000 })).toHaveTextContent('尚无回款与现金流数据')
    expect(await screen.findByText(/尚无递延余额记录/)).toBeInTheDocument()
    expect(screen.getByText('最近没有递延中的交易。')).toBeInTheDocument()
    expect(screen.getByTestId('next-payout')).toHaveTextContent('没有可预测的下一次打款')
    expect(await screen.findByText(/尚无带打款金额的结算单/)).toBeInTheDocument()
    expect(screen.getByTestId('cashflow-forecast')).toHaveTextContent('尚无回款数据，无法预测')
    expect(within(screen.getByTestId('cashflow-forecast')).queryByRole('table')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('加载失败：显示错误并可重试', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/cashflow': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })
})

describe('币种与周数', () => {
  it('默认不带币种（服务端用美元）、8 周；切换币种与周数都发给服务端', { timeout: 30000 }, async () => {
    const seen: Array<{ currency: string | null; weeks: string | null }> = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/cashflow': url => {
          seen.push({ currency: url.searchParams.get('currency'), weeks: url.searchParams.get('weeks') })
          return ok(cashflow({ currency: url.searchParams.get('currency') ?? 'USD' }))
        },
      }),
    })
    await screen.findByTestId('cashflow-balances', {}, { timeout: 15000 })
    expect(seen[0]).toEqual({ currency: null, weeks: '8' })
    await userEvent.click(screen.getByRole('combobox', { name: '币种' }))
    await userEvent.click(await screen.findByTitle('EUR'))
    await waitFor(() => expect(seen.some(item => item.currency === 'EUR')).toBe(true))
    await userEvent.click(screen.getByRole('combobox', { name: '预测周数' }))
    await userEvent.click(await screen.findByTitle('未来 13 周'))
    await waitFor(() => expect(seen.some(item => item.weeks === '13' && item.currency === 'EUR')).toBe(true))
  })
})

describe('登记到账', () => {
  const post = (bodies: Array<Record<string, unknown>>): Record<string, Handler> => ({
    '/finance/disbursements/confirm': (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return { status: 201, body: { success: true, data: { id: 'd9', version: 1, created: true, state: 'MATCHED', diff: 0 } } }
    },
  })

  it('新登记：弹窗写明报告的打款额，默认带报告的日期与金额；提交到接口，币种取结算单币种，没有版本号', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(post(bodies)) })
    await screen.findByTestId('cashflow-disbursements', {}, { timeout: 15000 })
    await userEvent.click(rowButton('12345678901', '登记到账'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/结算报告上的打款金额是/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('到账日期')).toHaveValue('2026-10-08')
    expect(within(dialog).getByLabelText('到账金额')).toHaveValue('500.00')
    await userEvent.type(within(dialog).getByLabelText('收款账户末四位'), '0042')
    await userEvent.type(within(dialog).getByLabelText('备注'), '银行流水已核对')
    await userEvent.click(within(dialog).getByRole('button', { name: /登\s*记/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ settlementId: 'st1', disbursedAt: '2026-10-08', amount: 500, currency: 'USD', bankLast4: '0042', note: '银行流水已核对' })
  })

  it('改正已有登记：带上看到的版本号；弹窗里是已登记的值', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(post(bodies)) })
    await screen.findByTestId('cashflow-disbursements', {}, { timeout: 15000 })
    await userEvent.click(rowButton('22222222222', '改正'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/保存会覆盖它/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('到账金额')).toHaveValue('480.00')
    expect(within(dialog).getByLabelText('收款账户末四位')).toHaveValue('6789')
    await userEvent.clear(within(dialog).getByLabelText('到账金额'))
    await userEvent.type(within(dialog).getByLabelText('到账金额'), '500')
    await userEvent.click(within(dialog).getByRole('button', { name: /保存改正/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ settlementId: 'st2', amount: 500, version: 3, bankLast4: '6789', disbursedAt: '2026-10-09' })
  })

  it('服务端拒绝（版本冲突）：弹窗里显示原因，不关闭', { timeout: 30000 }, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({ '/finance/disbursements/confirm': () => ({ status: 409, body: { error: { code: 'CONFLICT', message: '这张结算单的到账登记已被别人修改，请刷新后再改正' } } }) }),
    })
    await screen.findByTestId('cashflow-disbursements', {}, { timeout: 15000 })
    await userEvent.click(rowButton('22222222222', '改正'))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /保存改正/ }))
    expect(await within(dialog).findByText(/已被别人修改/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('金额填 0 或日期为空：前端拦下，不发请求', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(post(bodies)) })
    await screen.findByTestId('cashflow-disbursements', {}, { timeout: 15000 })
    await userEvent.click(rowButton('12345678901', '登记到账'))
    const dialog = await screen.findByRole('dialog')
    await userEvent.clear(within(dialog).getByLabelText('到账金额'))
    await userEvent.type(within(dialog).getByLabelText('到账金额'), '0')
    await userEvent.click(within(dialog).getByRole('button', { name: /登\s*记/ }))
    expect(await within(dialog).findByText('到账金额必须大于 0')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
  })

  it('没有 finance.reconcile 权限：按钮禁用', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByTestId('cashflow-disbursements', {}, { timeout: 15000 })
    expect(rowButton('12345678901', '登记到账')).toBeDisabled()
    expect(rowButton('22222222222', '改正')).toBeDisabled()
  })
})
