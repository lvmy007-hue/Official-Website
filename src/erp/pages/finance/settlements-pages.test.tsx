import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { occurrences, rowTextOf } from '../../test/grid-rows'
import { ok } from './fee-fixtures.test-helper'
import { disbursementsOf, exceptionRow, exceptionsOf, lineRow, linesOf, pendingRow, reconciliationOf, settlementList, settlementRow, summaryOf } from './settlements-fixtures.test-helper'

// 结算交易与结算详情（P2b-07）：状态与待核对的写法（不把“没数据”写成 0）、各页签按需请求、订单链接、三方核对的金额与核对项、
// 异常分类、打款记录、只读（没有任何写入口）。

const pages: LivePages = {
  SettlementsPage: { load: () => import('./SettlementsPage') },
  SettlementDetailPage: { load: () => import('./SettlementDetailPage') },
  OrderDetailPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/settlements': () => ok(settlementList()),
  '/settlements/st1/summary': () => ok(summaryOf()),
  '/settlements/st1/transactions': () => ok(linesOf()),
  '/settlements/st1/reconciliation': () => ok(reconciliationOf()),
  '/settlements/st1/exceptions': () => ok(exceptionsOf()),
  '/settlements/st1/disbursements': () => ok(disbursementsOf()),
  ...over,
})

describe('结算列表', () => {
  it('每张结算单一行：周期、打款、各类合计、状态与差额、待处理异常；顶部各状态张数与新鲜度', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/settlements?storeIds=st1', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: '12345678901' }, { timeout: 15000 })
    expect(screen.getByTestId('settlement-summary')).toHaveTextContent('共 5 张结算单：已对平 2，有差异 1，待核对 2')
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    const row = rowTextOf(link)
    expect(row).toContain('有差异')
    expect(row).toContain('2026-09-01 ~ 2026-09-14')
    expect(row).toContain('2026-09-16')
    expect(row).toContain('美国主店')
    expect(row).toContain('$120.00')
    expect(occurrences(row, '-$15.00')).toBe(2)
    const params = new URLSearchParams(app.calls.find(item => item.path === '/settlements')!.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('pageSize')).toBe('100')
    expect(link.getAttribute('href')).toBe('/app/settlements/st1?storeIds=st1')
  })

  it('待核对：报告没到时各类合计、条数写“报告未到”，差额写“待核对”，不出现 0 元', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/settlements', pages, handlers: handlers({ '/settlements': () => ok(settlementList([pendingRow()])) }) })
    const row = rowTextOf(await screen.findByRole('link', { name: '99999999999' }, { timeout: 15000 }))
    expect(occurrences(row, '待核对')).toBeGreaterThan(0)
    expect(row).toContain('等结算报告')
    expect(occurrences(row, '报告未到')).toBeGreaterThanOrEqual(5)
    expect(row).not.toContain('$0.00')
    expect(row).not.toContain('$')
  })

  it('没有结算单：只写原因，没有示例行', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/settlements', pages, handlers: handlers({ '/settlements': () => ok(settlementList([])) }) })
    expect(await screen.findByText(/尚无结算单/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
  })

  it('状态筛选发给服务端并从第一块重新取', { timeout: 30000 }, async () => {
    const seen: Array<{ status: string | null; cursor: string | null }> = []
    mountApp({
      url: '/app/settlements',
      pages,
      handlers: handlers({
        '/settlements': url => {
          seen.push({ status: url.searchParams.get('status'), cursor: url.searchParams.get('cursor') })
          return ok(settlementList([settlementRow()]))
        },
      }),
    })
    await screen.findByRole('link', { name: '12345678901' }, { timeout: 15000 })
    expect(seen[0].cursor).toBeNull()
    await userEvent.click(screen.getByRole('combobox', { name: '核对状态' }))
    await userEvent.click(await screen.findByTitle('已对平'))
    await waitFor(() => expect(seen.some(item => item.status === 'MATCHED')).toBe(true))
    expect(seen.filter(item => item.status === 'MATCHED')[0].cursor).toBeNull()
  })
})
describe('结算详情', () => {
  it('身份区、汇总类别与按科目的汇总；其它页签没打开前不请求', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/settlements/st1', pages, handlers: handlers() })
    expect(await screen.findByText('结算单 12345678901', {}, { timeout: 15000 })).toBeInTheDocument()
    const identity = screen.getByTestId('identity')
    expect(within(identity).getByText('有差异')).toBeInTheDocument()
    expect(within(identity).getByText('2026-09-01 ~ 2026-09-14')).toBeInTheDocument()
    expect(within(identity).getByText('$55.00')).toBeInTheDocument()
    expect(within(identity).getByText('-$50.00', { exact: false })).toBeInTheDocument()
    const categories = screen.getByTestId('summary-categories')
    expect(within(categories).getByText('保留金')).toBeInTheDocument()
    expect(screen.getByText('Commission')).toBeInTheDocument()
    expect(app.calls.map(item => item.path)).not.toContain('/settlements/st1/transactions')
    expect(app.calls.map(item => item.path)).not.toContain('/settlements/st1/reconciliation')
    expect(screen.queryByRole('button', { name: /编辑|删除|标记|提交/ })).toBeNull()
  })

  it('结算报告没到：汇总页签写原因，不显示各类金额', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/settlements/st1',
      pages,
      handlers: handlers({
        '/settlements/st1/summary': () =>
          ok(summaryOf({ settlement: pendingRow({ id: 'st1' }), hasReport: false, note: '结算报告尚未到达：结算周期结束后亚马逊才会生成结算报告', categories: [], breakdown: [] })),
      }),
    })
    expect(await screen.findByTestId('summary-no-report', {}, { timeout: 15000 })).toHaveTextContent('结算报告尚未到达')
    expect(screen.queryByTestId('summary-categories')).toBeNull()
  })

  it('交易明细：订单有链接、我方没有的订单写明、费用事件对应；类别筛选发给服务端', { timeout: 30000 }, async () => {
    const seen: Array<string | null> = []
    mountApp({
      url: '/app/settlements/st1',
      pages,
      handlers: handlers({
        '/settlements/st1/transactions': url => {
          seen.push(url.searchParams.get('category'))
          return ok(
            linesOf([
              lineRow(),
              lineRow({ id: 'l2', lineNo: 3, amazonOrderId: '111-0000002-0000002', orderFound: false, feeEventId: null }),
              lineRow({ id: 'l3', lineNo: 4, amazonOrderId: null, category: 'INCOME', categoryLabel: '收入', feeEventId: null }),
            ]),
          )
        },
      }),
    })
    await screen.findByText('结算单 12345678901', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('tab', { name: '交易明细' }))
    const first = await screen.findByText('111-0000001-0000001')
    expect(
      within(first.closest('[row-id]') as HTMLElement)
        .getByRole('link', { name: '111-0000001-0000001' })
        .getAttribute('href'),
    ).toBe('/app/orders/111-0000001-0000001')
    expect(rowTextOf(first)).toContain('B0TESTASIN1')
    expect(rowTextOf(first)).toContain('已对应')
    const secondText = rowTextOf(screen.getByText('111-0000002-0000002'))
    expect(secondText).toContain('（我方订单里没有）')
    expect(secondText).toContain('未对应')
    expect(rowTextOf(screen.getByText('账户级'))).toContain('账户级')
    await userEvent.click(screen.getByRole('combobox', { name: '类别' }))
    await userEvent.click(await screen.findByTitle('费用'))
    await waitFor(() => expect(seen).toContain('FEE'))
  })

  it('没有订单读取权限：订单号只显示文字，不给链接也不提示“我方没有”', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/settlements/st1',
      pages,
      handlers: handlers({ '/settlements/st1/transactions': () => ok(linesOf([lineRow({ orderFound: false })], { canViewOrders: false })) }, ['finance.read']),
    })
    await screen.findByText('结算单 12345678901', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('tab', { name: '交易明细' }))
    const cell = await screen.findByText('111-0000001-0000001')
    expect(within(cell.closest('[row-id]') as HTMLElement).queryByRole('link')).toBeNull()
    expect(rowTextOf(cell)).not.toContain('（我方订单里没有）')
  })

  it('三方核对：官方金额、系统金额、差额，核对项，差异分类与异常清单', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/settlements/st1', pages, handlers: handlers() })
    await screen.findByText('结算单 12345678901', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('tab', { name: /三方核对/ }))
    const amounts = await screen.findByTestId('recon-amounts')
    expect(within(amounts).getByText('$105.00')).toBeInTheDocument()
    expect(within(amounts).getByText('$120.00')).toBeInTheDocument()
    expect(within(amounts).getByText('-$15.00', { exact: false })).toBeInTheDocument()
    const checks = screen.getByTestId('recon-checks')
    expect(within(checks).getByText('通过')).toBeInTheDocument()
    expect(within(checks).getByText('不通过')).toBeInTheDocument()
    expect(within(checks).getByText('未检查')).toBeInTheDocument()
    expect(within(checks).getByText(/1 组订单对不上/)).toBeInTheDocument()
    expect(screen.getByText(/差异分类（待处理 1 条）/)).toBeInTheDocument()
    const rowText = rowTextOf(await screen.findByText('金额不一致'))
    expect(rowText).toContain('未解释')
    expect(rowText).toContain('待处理')
    expect(screen.getByText(/不是亚马逊公布的/)).toBeInTheDocument()
  })

  it('三方核对待核对：说明原因，两边金额写“尚无记录”，不写 0；没有异常写明', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/settlements/st1',
      pages,
      handlers: handlers({
        '/settlements/st1/reconciliation': () =>
          ok(
            reconciliationOf({
              status: 'PENDING',
              statusLabel: '待核对',
              pendingReason: 'NO_TRANSACTIONS',
              pendingNote: '这张结算单还没有关联的财务接口交易',
              officialAmount: null,
              systemAmount: null,
              diffAmount: null,
              exceptions: [],
              openExceptions: 0,
              checks: [],
            }),
          ),
        '/settlements/st1/exceptions': () => ok(exceptionsOf([])),
      }),
    })
    await screen.findByText('结算单 12345678901', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('tab', { name: /三方核对/ }))
    expect(await screen.findByTestId('recon-pending')).toHaveTextContent('还没有关联的财务接口交易')
    expect(within(screen.getByTestId('recon-amounts')).getAllByText('尚无记录')).toHaveLength(3)
    expect(screen.getByText('没有待处理的差异')).toBeInTheDocument()
    expect(await screen.findByText(/这张结算单没有核对异常/)).toBeInTheDocument()
  })

  it('异常筛选发给服务端；打款记录来自结算报告并说明手工登记尚未接入', { timeout: 30000 }, async () => {
    const seen: Array<string | null> = []
    mountApp({
      url: '/app/settlements/st1',
      pages,
      handlers: handlers({
        '/settlements/st1/exceptions': url => {
          seen.push(url.searchParams.get('category'))
          return ok(
            exceptionsOf([
              exceptionRow(),
              exceptionRow({
                id: 'e2',
                refKey: 'missing:Z',
                kind: 'ORDER_MISSING',
                kindLabel: '订单未同步',
                category: 'SCOPE',
                categoryLabel: '范围',
                note: '我方订单同步的最早订单晚于结算周期开始',
                amazonOrderId: 'Z-1',
                orderFound: false,
              }),
            ]),
          )
        },
      }),
    })
    await screen.findByText('结算单 12345678901', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('tab', { name: /三方核对/ }))
    await screen.findByText('订单未同步')
    expect(screen.getByText('我方订单同步的最早订单晚于结算周期开始')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('combobox', { name: '差异分类' }))
    await userEvent.click(await screen.findByTitle('范围'))
    await waitFor(() => expect(seen).toContain('SCOPE'))
    await userEvent.click(screen.getByRole('tab', { name: '打款记录' }))
    const rowText = rowTextOf(await screen.findByText('结算报告', { selector: '[row-id] *' }))
    expect(rowText).toContain('2026-09-16')
    expect(rowText).toContain('$55.00')
    expect(screen.getByTestId('manual-note')).toHaveTextContent('回款与现金流')
  })

  it('结算单不存在：显示错误状态，不渲染页签', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/settlements/nope',
      pages,
      handlers: handlers({ '/settlements/nope/summary': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '结算单不存在' } } }) }),
    })
    await waitFor(() => expect(screen.queryByTestId('detail-layout')).toBeNull(), { timeout: 15000 })
    expect(await screen.findByText(/结算单不存在|不存在/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})
