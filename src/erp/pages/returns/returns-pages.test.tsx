import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { awaiting, detail, ok, returnList, returnRow, rowText } from './returns-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 退货列表与详情（P2b-02；P6-13 迁到 MassiveGrid / PagedGrid 骨架）：范围参数与新鲜度、没有数据的写法、筛选写进地址栏并发给服务端、
// 退货原因三层显示、退款后未收到退货清单、买家备注默认隐藏。

const pages: LivePages = {
  ReturnsPage: { load: () => import('./ReturnsPage') },
  ReturnDetailPage: { load: () => import('./ReturnDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/returns': () => ok(returnList()),
  '/returns/awaiting': () => ok(awaiting()),
  '/returns/r1': () => ok(detail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchers: 0, watchId: null } }),
  ...over,
})

describe('退货列表', () => {
  it('请求带全局范围参数；订单号链到退货详情；默认范围提示；退货原因三层显示；列表里没有买家备注', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/returns?storeIds=st1&from=2026-10-01&to=2026-10-07', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: /111-2223334-5556667/ }, { timeout: 15000 })
    expect(link.getAttribute('href')).toMatch(/^\/app\/returns\/r1(\?|$)/)
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    const params = new URLSearchParams(app.calls.find(call => call.path === '/returns')!.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('from')).toBe('2026-10-01')
    expect(screen.getByText(/未选择日期范围，当前显示 2026-07-25 至 2026-10-23 的退货（最近 90 天）/)).toBeInTheDocument()
    const text = rowText('r1')
    expect(text).toContain('DEFECTIVE')
    expect(text).toContain('商品有缺陷')
    expect(text).toContain('商品质量')
    for (const header of ['原因代码', '中文释义', '大类']) expect(screen.getAllByText(header).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('联系电话')
  })

  it('没有退货记录：只写原因，没有示例记录，也不出现 0', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns': () => ok(returnList([])) }) })
    expect(await screen.findByText(/所选日期范围内尚无退货记录/)).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
  })

  it('没有财务交易写“待财务交易”不写“无退款”；没有原因写“未提供原因”；报告没给处置写“处置未知”', async () => {
    const row = returnRow({
      reason: null,
      reasonLabel: null,
      reasonCategory: null,
      disposition: { group: 'UNKNOWN', label: '处置未知', sellable: null, raw: null },
      refund: { state: 'PENDING_DATA', amount: null, firstRefundAt: null },
      receipt: { state: 'PENDING_DATA', label: '待财务交易' },
    })
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns': () => ok(returnList([row])) }) })
    await screen.findByRole('link', { name: /111-2223334-5556667/ })
    const text = rowText('r1')
    expect(text).toContain('待财务交易')
    expect(text).not.toContain('无退款')
    expect(text).toContain('未提供原因')
    expect(text).toContain('处置未知')
  })

  it('映射表里还没补全的原因代码：原样显示代码，大类标“未分类”', async () => {
    const row = returnRow({ reason: 'CUSTOM_NEW', reasonLabel: 'CUSTOM_NEW', reasonCategory: '未分类' })
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns': () => ok(returnList([row])) }) })
    await screen.findByRole('link', { name: /111-2223334-5556667/ })
    expect(rowText('r1')).toContain('CUSTOM_NEW')
    expect(rowText('r1')).toContain('未分类')
  })

  it('筛选结果可能不完整时给出提示', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns': () => ok(returnList([returnRow()], { filterLimited: true })) }) })
    expect(await screen.findByText(/退款筛选命中的订单太多/)).toBeInTheDocument()
  })

  it('搜索把关键字发给服务端并写进地址栏；从游标第一块开始取', async () => {
    const seen: URLSearchParams[] = []
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns': url => (seen.push(url.searchParams), ok(returnList())) }) })
    await screen.findByRole('link', { name: /111-2223334-5556667/ })
    expect(seen[0]!.get('cursor')).toBeNull()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索订单号或退货件编号' }), '111-222{Enter}')
    await waitFor(() => expect(seen.some(params => params.get('q') === '111-222' && params.get('cursor') === null)).toBe(true))
    expect(screen.getByRole('list', { name: '已生效的条件' })).toHaveTextContent('111-222')
    expect(app.router.state.location.search).toMatchObject({ q: '111-222' })
  })

  it('带筛选条件的链接：原因（含企业自己加的代码）、处置、是否退款、ASIN、SKU 原样发给服务端', async () => {
    const seen: URLSearchParams[] = []
    mountApp({
      url: '/app/returns?reason=custom_reason&disposition=SELLABLE&refunded=true&asin=B0TESTASIN1&sku=SKU-1',
      pages,
      handlers: handlers({ '/returns': url => (seen.push(url.searchParams), ok(returnList())) }),
    })
    await screen.findByRole('link', { name: /111-2223334-5556667/ })
    const params = seen[0]!
    expect(params.get('reason')).toBe('custom_reason')
    expect(params.get('disposition')).toBe('SELLABLE')
    expect(params.get('refunded')).toBe('true')
    expect(params.get('asin')).toBe('B0TESTASIN1')
    expect(params.get('sku')).toBe('SKU-1')
  })

  it('四个视图：退货记录、退款后未收到退货、退货分析、原因映射；其余页签不打开就不取数', async () => {
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await screen.findByRole('link', { name: /111-2223334-5556667/ })
    for (const name of ['退货记录', '退款后未收到退货', '退货分析', '原因映射']) expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    expect(app.calls.some(call => call.path.startsWith('/returns/analysis') || call.path === '/returns/reason-map' || call.path === '/returns/awaiting')).toBe(false)
  })
})

describe('退款后未收到退货', () => {
  it('打开页签才取数；显示口径说明、已过天数；退款不等于要退货', async () => {
    const app = mountApp({ url: '/app/returns', pages, handlers: handlers() })
    await screen.findByRole('link', { name: /111-2223334-5556667/ })
    expect(app.calls.some(call => call.path === '/returns/awaiting')).toBe(false)
    await userEvent.click(screen.getByRole('tab', { name: '退款后未收到退货' }))
    expect(await screen.findByText('333-0000000-0000003')).toBeInTheDocument()
    expect(screen.getByText('83 天')).toBeInTheDocument()
    expect(screen.getByText(/退款不等于要退货/)).toBeInTheDocument()
  })

  it('清单不完整时提示；没有满足条件的订单只写原因', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/awaiting': () => ok(awaiting({ items: [], state: 'NO_DATA', note: '所选范围内没有满足条件的订单', truncated: true })) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '退款后未收到退货' }))
    expect(await screen.findByText('清单可能不完整')).toBeInTheDocument()
    expect(await screen.findByText(/所选范围内没有满足条件的订单/)).toBeInTheDocument()
  })

  it('读取失败：显示正式的错误状态，不白屏', async () => {
    mountApp({ url: '/app/returns', pages, handlers: handlers({ '/returns/awaiting': () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '退款后未收到退货' }))
    expect(await screen.findByText(/服务暂时不可用|读取失败|出错/)).toBeInTheDocument()
  })
})

describe('退货详情', () => {
  it('身份区 6 项指标；4 个页签；买家备注默认只有遮罩，填理由后经统一出口才显示；原因显示代码与大类', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/returns/r1',
      pages,
      handlers: handlers({
        '/pii/reveal': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return ok({
            objectType: 'RETURN',
            objectId: 'r1',
            state: 'OK',
            values: { customerComments: '包装破损，内含联系电话 13800000000' },
            expiresAt: '2026-10-27T10:01:00.000Z',
            retainedUntil: '2026-11-17T10:00:00.000Z',
            note: null,
          })
        },
      }),
    })
    expect(await screen.findByText('退款后是否收到退货')).toBeInTheDocument()
    for (const label of ['概览', '退款与费用', '关联赔付', '处理时间线']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    expect(screen.getByText('DEFECTIVE（商品质量）')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('13800000000')
    expect(screen.getByTestId('pii-masked-block')).toBeInTheDocument()
    expect(screen.getByTestId('buyer-comments')).toHaveTextContent('电话')
    await userEvent.click(screen.getByRole('button', { name: /查看买家留言/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '查看原因' }), '核对退货原因')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    expect(await screen.findByTestId('pii-revealed')).toHaveTextContent('13800000000')
    expect(body).toEqual({ objectType: 'RETURN', objectId: 'r1', fields: ['customerComments'], reason: '核对退货原因' })
    await userEvent.click(screen.getByRole('button', { name: '立即隐藏' }))
    await waitFor(() => expect(document.body.textContent).not.toContain('13800000000'))
  })

  it('买家备注：没有留言就写明没有，不给查看按钮', async () => {
    mountApp({ url: '/app/returns/r1', pages, handlers: handlers({ '/returns/r1': () => ok(detail({ buyerComments: { state: 'NONE', kinds: [], retainedUntil: null } })) }) })
    expect(await screen.findByText('买家没有留言')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /查看买家留言/ })).not.toBeInTheDocument()
  })

  it('买家备注已过保留期：写明已清除，没有查看按钮', async () => {
    mountApp({ url: '/app/returns/r1', pages, handlers: handlers({ '/returns/r1': () => ok(detail({ buyerComments: { state: 'EXPIRED', kinds: [], retainedUntil: null } })) }) })
    expect(await screen.findByText(/买家留言已超过保留期/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /查看买家留言/ })).not.toBeInTheDocument()
  })

  it('同一订单的其他退货链到各自详情；订单链到订单详情', async () => {
    mountApp({ url: '/app/returns/r1', pages, handlers: handlers() })
    const sibling = await screen.findByRole('link', { name: /SKU-2 × 2/ })
    expect(sibling.getAttribute('href')).toMatch(/^\/app\/returns\/r2(\?|$)/)
  })

  it('退款与费用页签：订单口径说明、费用合计；赔付页签：尚未核查', async () => {
    mountApp({ url: '/app/returns/r1', pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '退款与费用' }))
    expect(await screen.findByText(/退款金额是订单口径/)).toBeInTheDocument()
    expect(screen.getAllByText('退货处理费').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: '关联赔付' }))
    expect(await screen.findByText(/这条退货还没有核查过是否需要索赔/)).toBeInTheDocument()
    expect(screen.getByText('尚无关联案件')).toBeInTheDocument()
  })

  it('处理时间线按时间显示来源', async () => {
    mountApp({ url: '/app/returns/r1', pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '处理时间线' }))
    const timeline = await screen.findByTestId('return-timeline')
    expect(within(timeline).getByText('退货记录')).toBeInTheDocument()
  })

  it('不在范围内：显示正式的错误状态，不白屏', async () => {
    mountApp({
      url: '/app/returns/r1',
      pages,
      handlers: handlers({ '/returns/r1': () => ({ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: '退货记录不存在或不在当前范围内' } } }) }),
    })
    expect(await screen.findByText(/退货记录不存在或不在当前范围内/)).toBeInTheDocument()
  })
})
