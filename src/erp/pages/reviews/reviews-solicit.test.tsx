import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SolicitTabResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import { callsOf, eligibleRow, lastParams, ok, ratingsResponse, reviewsHandlers, reviewsPages, solicitResponse } from './reviews-fixtures.test-helper'

// 评价与反馈：请求评价页签（P4-13）与页签、地址栏。覆盖率与评分增长、可请求订单勾选与批量请求（确认弹窗、受理与跳过提示）、
// 无权限与开关关闭时禁用并写原因、翻页、没有数据与来源没接上。不显示任何买家信息。

// 页签测试会切到有图表的页签：jsdom 里没有画布，图表容器换成占位
vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

afterEach(() => vi.unstubAllGlobals())

const ORDER_1 = '111-0000001-0000001'
const ORDER_2 = '111-0000002-0000002'

const openSolicit = async (response: () => SolicitTabResponse = () => solicitResponse(), extra: Record<string, Handler> = {}, me = defaultMe, url = '/app/reviews?tab=solicit') => {
  const app = mountApp({ url, pages: reviewsPages, me, handlers: reviewsHandlers({ solicit: response }, extra) })
  const panel = within(await screen.findByTestId('solicit-panel', {}, { timeout: 15_000 }))
  await panel.findByText(ORDER_1, {}, { timeout: 15_000 })
  return { app, panel }
}
const rowOf = (panel: ReturnType<typeof within>, order: string) => panel.getByText(order).closest('tr, [role=row]') as HTMLElement
const batchButton = (panel: ReturnType<typeof within>) => panel.getByRole('button', { name: /批量请求评价/ })

describe('评价与反馈：请求评价', () => {
  it('请求覆盖率：每个店铺一行（已送达、已请求、覆盖率、当前可请求）；没有已送达订单写“尚无已送达订单”', async () => {
    const { panel } = await openSolicit(() =>
      solicitResponse({
        coverage: [
          { storeId: 'st1', storeName: 'Northstar US', deliveredOrders: 200, requestedOrders: 50, coverage: 0.25, eligibleNow: 2 },
          { storeId: 'st2', storeName: 'Oak & Pine', deliveredOrders: 0, requestedOrders: 0, coverage: null, eligibleNow: 0 },
        ],
      }),
    )
    const row = panel.getByText('25.0%').closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('Northstar US')
    expect(row).toHaveTextContent('200')
    expect(row).toHaveTextContent('50')
    expect(row).toHaveTextContent('25.0%')
    const empty = panel.getByText('Oak & Pine').closest('tr, [role=row]') as HTMLElement
    expect(empty).toHaveTextContent('尚无已送达订单')
    expect(empty).toHaveTextContent('尚无记录')
    expect(within(empty).queryByText('0')).toBeNull()
  })

  it('请求后评分数增长：请求前后评分数与日期、增长；没有对照时写原因（需要再导入一次评分）', async () => {
    const { panel } = await openSolicit()
    const row = panel.getByText('旅行箱 24 寸', { selector: 'div' }).closest('tr, [role=row]') as HTMLElement
    expect(row).toHaveTextContent('1,200（2026-10-01）')
    expect(row).toHaveTextContent('1,280（2026-10-24）')
    expect(row).toHaveTextContent('+80')
    const pending = panel.getByText('收纳袋').closest('tr, [role=row]') as HTMLElement
    expect(pending).toHaveTextContent('需要再导入一次评分')
    expect(pending).toHaveTextContent('尚无记录')
    expect(panel.getByText('增长只反映时间上的先后。')).toBeInTheDocument()
    expect(panel.getByText('可请求订单：送达后第 5 至 30 天。')).toBeInTheDocument()
  })

  it('可请求订单：下单与送达日期、送达后第几天与剩余天数、ASIN、上次发送失败写“发送失败，可再次请求”；最近请求记录用状态中文', async () => {
    const { panel } = await openSolicit()
    const first = rowOf(panel, ORDER_1)
    expect(first).toHaveTextContent('2026-10-05')
    expect(first).toHaveTextContent('2026-10-10')
    expect(first).toHaveTextContent('送达后第 14 天')
    expect(first).toHaveTextContent('剩余 16 天')
    expect(first).toHaveTextContent('B0RATE0001')
    expect(first).toHaveTextContent('尚未请求')
    expect(rowOf(panel, ORDER_2)).toHaveTextContent('发送失败，可再次请求')
    const recent = panel.getByText('111-0000009-0000009').closest('tr, [role=row]') as HTMLElement
    expect(recent).toHaveTextContent('已请求')
    expect(panel.getByText('111-0000008-0000008').closest('tr, [role=row]')).toHaveTextContent('亚马逊不允许请求')
    expect(panel.queryByText(/买家|收件人/)).toBeNull()
  })

  it('批量请求：勾选后先弹确认（每单只能请求一次、无法撤回），确认才提交；提示已受理与跳过的原因', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { panel } = await openSolicit(undefined, {
      '/reviews/solicitations': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { status: 201, body: ok({ accepted: 1, skipped: [{ amazonOrderId: ORDER_2, reason: 'ALREADY_REQUESTED' }], batchId: 'b1', jobId: 'j1' }).body }
      },
    })
    expect(batchButton(panel)).toBeDisabled()
    await userEvent.click(within(rowOf(panel, ORDER_1)).getByRole('checkbox'))
    await userEvent.click(within(rowOf(panel, ORDER_2)).getByRole('checkbox'))
    expect(panel.getByText(/已勾选 2 单/)).toBeInTheDocument()
    await userEvent.click(batchButton(panel))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('每个订单只能请求一次，提交后无法撤回。')).toBeInTheDocument()
    expect(dialog.getByText(/Northstar US/)).toHaveTextContent('2 个订单')
    expect(bodies).toHaveLength(0)
    await userEvent.click(dialog.getByRole('button', { name: /确认请求/ }))
    await waitFor(() => expect(bodies).toEqual([{ storeId: 'st1', orderIds: [ORDER_1, ORDER_2] }]))
    expect(await panel.findByTestId('solicit-result')).toHaveTextContent('已受理 1 个订单，跳过 1 个（已经请求过 1 个）')
  })

  it('全部受理：成功提示不带跳过；服务端拒绝（开关关闭）时在弹窗里显示原因', async () => {
    let reject = true
    const { panel } = await openSolicit(undefined, {
      '/reviews/solicitations': () =>
        reject
          ? { status: 409, body: { error: { code: 'DATA_CONDITION_FAILED', message: '写入开关“请求评价”还没有打开' } } }
          : { status: 201, body: ok({ accepted: 1, skipped: [], batchId: 'b1', jobId: 'j1' }).body },
    })
    await userEvent.click(within(rowOf(panel, ORDER_1)).getByRole('checkbox'))
    await userEvent.click(batchButton(panel))
    let dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /确认请求/ }))
    expect(await dialog.findByText(/写入开关“请求评价”还没有打开/)).toBeInTheDocument()
    expect(panel.queryByTestId('solicit-result')).toBeNull()
    reject = false
    dialog = within(screen.getByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /确认请求/ }))
    expect(await panel.findByTestId('solicit-result')).toHaveTextContent('已受理 1 个订单')
    expect(panel.getByTestId('solicit-result')).not.toHaveTextContent('跳过')
  })

  it('跨店铺勾选：批量请求禁用（一次只能请求同一个店铺）', async () => {
    const other = eligibleRow({ storeId: 'st2', storeName: 'Oak & Pine', amazonOrderId: '222-0000001-0000001' })
    const { panel } = await openSolicit(() => solicitResponse({ items: [eligibleRow(), other] }))
    await userEvent.click(within(rowOf(panel, ORDER_1)).getByRole('checkbox'))
    expect(batchButton(panel)).toBeEnabled()
    await userEvent.click(within(rowOf(panel, '222-0000001-0000001')).getByRole('checkbox'))
    expect(batchButton(panel)).toBeDisabled()
  })

  it('没有 reviews.solicit 权限：批量请求禁用并写明原因', async () => {
    const { panel } = await openSolicit(undefined, {}, { ...defaultMe, permissions: ['reviews.read'] })
    expect(batchButton(panel)).toBeDisabled()
    expect(panel.getByTestId('solicit-switch-note')).toHaveTextContent('无权限：批量请求评价需要“请求评价”权限（reviews.solicit）')
  })

  it('写入开关关闭（响应带开关状态）：批量请求禁用并写明原因', async () => {
    const response = () => ({ ...solicitResponse(), switch: { enabled: false, permitted: true } }) as SolicitTabResponse
    const { panel } = await openSolicit(response)
    await userEvent.click(within(rowOf(panel, ORDER_1)).getByRole('checkbox'))
    expect(batchButton(panel)).toBeDisabled()
    expect(panel.getByTestId('solicit-switch-note')).toHaveTextContent('写入开关“请求评价”（sw.solicitation.send）未开启')
  })

  it('有权限且开关状态未知：写明受开关控制，按钮可用（由服务端在提交时拒绝并说明原因）', async () => {
    const { panel } = await openSolicit()
    expect(panel.getByTestId('solicit-switch-note')).toHaveTextContent('受写入开关“请求评价”（sw.solicitation.send）控制')
    await userEvent.click(within(rowOf(panel, ORDER_1)).getByRole('checkbox'))
    expect(batchButton(panel)).toBeEnabled()
  })

  it('翻页：第二页调用 /reviews/solicitations/eligible（带游标与店铺），回到第一页用页签数据', async () => {
    const { app, panel } = await openSolicit(() => solicitResponse({ pageInfo: { pageSize: 2, nextCursor: 'cur-2', hasMore: true, approxTotal: 3 } }), {
      '/reviews/solicitations/eligible': () => ok({ items: [eligibleRow({ amazonOrderId: '111-0000003-0000003' })], pageInfo: { pageSize: 2, nextCursor: null, hasMore: false, approxTotal: 3 } }),
    })
    await userEvent.click(panel.getByRole('button', { name: '下一页' }))
    expect(await panel.findByText('111-0000003-0000003')).toBeInTheDocument()
    await waitFor(() => expect(lastParams(app, '/reviews/solicitations/eligible').get('cursor')).toBe('cur-2'))
    expect(lastParams(app, '/reviews/solicitations/eligible').get('pageSize')).toBe('2')
    expect(panel.getByText(/第 2 页/)).toBeInTheDocument()
    expect(panel.queryByText(ORDER_1)).toBeNull()
    await userEvent.click(panel.getByRole('button', { name: '上一页' }))
    expect(await panel.findByText(ORDER_1)).toBeInTheDocument()
  })

  it('选择店铺：请求带 storeId，地址栏保留选择', async () => {
    const { app, panel } = await openSolicit()
    await userEvent.click(panel.getByRole('combobox', { name: '请求评价店铺' }))
    await userEvent.click(await screen.findByTitle('Northstar US'))
    await waitFor(() => expect(lastParams(app, '/reviews').get('storeId')).toBe('st1'))
    expect(lastParams(app, '/reviews').get('tab')).toBe('solicit')
    expect(app.router.state.location.search).toMatchObject({ tab: 'solicit', storeId: 'st1' })
  })

  it('没有任何数据：各块写“尚无记录”的前置条件，不写 0', async () => {
    mountApp({
      url: '/app/reviews?tab=solicit',
      pages: reviewsPages,
      handlers: reviewsHandlers({ solicit: () => solicitResponse({ items: [], coverage: [], growth: [], recent: [] }) }),
    })
    const panel = within(await screen.findByTestId('solicit-panel', {}, { timeout: 15_000 }))
    expect((await panel.findAllByText(/没有处于送达后第 5 至 30 天/, {}, { timeout: 15_000 })).length).toBeGreaterThan(0)
    expect((await panel.findAllByText(/还没有请求过评价/)).length).toBeGreaterThan(0)
    expect(batchButton(panel)).toBeDisabled()
  })

  it('来源没接上：写“尚未接入”与原因', async () => {
    mountApp({
      url: '/app/reviews?tab=solicit',
      pages: reviewsPages,
      handlers: reviewsHandlers({ solicit: () => solicitResponse({ state: 'NOT_CONNECTED', note: '还没有接入亚马逊店铺', items: [], coverage: [], growth: [], recent: [], stores: [] }) }),
    })
    const panel = within(await screen.findByTestId('solicit-panel', {}, { timeout: 15_000 }))
    expect((await panel.findAllByText('尚未接入', {}, { timeout: 15_000 })).length).toBeGreaterThan(0)
    expect(panel.getAllByText(/还没有接入亚马逊店铺/).length).toBeGreaterThan(0)
  })
})

describe('评价与反馈：页签与地址栏', () => {
  it('默认进入评分概况；点页签后地址栏带 tab，并且各页签只在打开后才读取', async () => {
    const app = mountApp({ url: '/app/reviews', pages: reviewsPages, handlers: reviewsHandlers({ ratings: () => ratingsResponse() }) })
    await screen.findByTestId('ratings-panel', {}, { timeout: 15_000 })
    expect(screen.getByRole('tab', { name: '评分概况' })).toHaveAttribute('aria-selected', 'true')
    expect(callsOf(app, '/reviews').map(call => new URLSearchParams(call.search).get('tab'))).not.toContain('solicit')
    await userEvent.click(screen.getByRole('tab', { name: '请求评价' }))
    await screen.findByTestId('solicit-panel')
    expect(app.router.state.location.search).toMatchObject({ tab: 'solicit' })
    expect(lastParams(app, '/reviews').get('tab')).toBe('solicit')
  })

  it('切换页签会丢掉不适用的选择（asin、nodeId、storeId）', async () => {
    const app = mountApp({ url: '/app/reviews?tab=topics&storeId=st1&asin=B0RATE0002', pages: reviewsPages, handlers: reviewsHandlers() })
    await screen.findByTestId('topics-panel', {}, { timeout: 15_000 })
    await userEvent.click(screen.getByRole('tab', { name: '退货主题' }))
    await screen.findByTestId('returns-panel')
    await waitFor(() => expect(lastParams(app, '/reviews').get('tab')).toBe('returns'))
    expect(lastParams(app, '/reviews').get('asin')).toBeNull()
    expect(lastParams(app, '/reviews').get('storeId')).toBeNull()
  })

  it('地址栏里不认识的页签回到评分概况', async () => {
    mountApp({ url: '/app/reviews?tab=nope', pages: reviewsPages, handlers: reviewsHandlers() })
    expect(await screen.findByTestId('ratings-panel', {}, { timeout: 15_000 })).toBeInTheDocument()
  })
})
