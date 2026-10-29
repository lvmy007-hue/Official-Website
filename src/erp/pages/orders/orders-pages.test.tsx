import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { identity, ok, orderList, orderRow, piiOk, rowText } from './orders-fixtures.test-helper'

// 订单列表与详情（P2b-01）：范围参数与新鲜度、游标翻页、没有数据的写法、权限决定页签、买家信息的查看理由与自动隐藏。

const pages: LivePages = {
  OrdersPage: { load: () => import('./OrdersPage') },
  OrderDetailPage: { load: () => import('./OrderDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/orders': () => ok(orderList()),
  '/orders/o1': () => ok(identity()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('订单列表', () => {
  it('请求带全局范围参数；显示新鲜度条；订单号链到详情；默认 30 天的提示', { timeout: 30000 }, async () => {
    const app = mountApp({ url: '/app/orders?storeIds=st1&from=2026-10-01&to=2026-10-07', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: '111-2223334-5556667' }, { timeout: 15000 })
    expect(link.getAttribute('href')).toMatch(/^\/app\/orders\/o1(\?|$)/)
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    const params = new URLSearchParams(app.calls.find(call => call.path === '/orders')!.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('from')).toBe('2026-10-01')
    expect(params.get('to')).toBe('2026-10-07')
    expect(params.get('marketplaceId')).toBe('ATVPDKIKX0DER')
    expect(screen.getByText(/未选择下单日期范围，当前显示 2026-09-23 至 2026-10-23/)).toBeInTheDocument()
    expect(document.querySelector('.fba-context-strip')).toBeNull()
  })

  it('没有订单：只写原因，没有任何示例记录，也不出现 0', async () => {
    mountApp({ url: '/app/orders', pages, handlers: handlers({ '/orders': () => ok(orderList([])) }) })
    expect(await screen.findByText(/所选日期范围内尚无订单记录/)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('没有财务交易时退款写“待财务交易”，不写“无退款”；净收益列只在有 field.profit 时出现', async () => {
    const pending = orderRow({ refund: { state: 'PENDING_DATA', amount: null }, settlement: { state: 'NONE', label: '尚无财务交易' } })
    const app = mountApp({ url: '/app/orders', pages, handlers: handlers({ '/orders': () => ok(orderList([pending])) }, ['orders.read']) })
    await screen.findByRole('link', { name: '111-2223334-5556667' })
    expect(rowText('o1')).toContain('待财务交易')
    expect(rowText('o1')).not.toContain('无退款')
    expect(screen.queryByText(/净收益/)).not.toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/orders/net-income')).toBe(false)
  })

  it('净收益是异步列：列表先出，再按屏幕上的订单批量取；风险与替换标签可见', async () => {
    const row = orderRow({ risks: ['REFUND', 'RETURN'], isReplacement: true, refund: { state: 'PARTIAL', amount: 10 }, returnCount: 1 })
    const bodies: unknown[] = []
    const net = { '/orders/net-income': (_url: URL, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), ok({ rows: { o1: { net: { value: 12.5, currency: 'USD' } } } })) } as Record<
      string,
      Handler
    >
    const app = mountApp({ url: '/app/orders', pages, handlers: handlers({ '/orders': () => ok(orderList([row])), ...net }) })
    await screen.findByRole('link', { name: '111-2223334-5556667' })
    expect((await screen.findAllByText('净收益（财务交易合计）')).length).toBeGreaterThan(0)
    expect(await screen.findByText('$12.50')).toBeInTheDocument()
    const call = app.calls.find(item => item.path === '/orders/net-income')!
    expect(call.method).toBe('POST')
    expect(bodies).toEqual([{ ids: ['o1'] }])
    expect(rowText('o1')).toContain('$12.50')
    expect(rowText('o1')).toContain('替换订单')
    expect(rowText('o1')).toContain('1 笔')
  })

  it('筛选结果可能不完整时给出提示', async () => {
    mountApp({ url: '/app/orders', pages, handlers: handlers({ '/orders': () => ok(orderList([orderRow()], { filterLimited: true })) }) })
    expect(await screen.findByText(/筛选命中的订单太多/)).toBeInTheDocument()
  })

  it('搜索把关键字发给服务端，并写进地址栏；带条件的筛选链接刷新后原样恢复', async () => {
    const seen: URLSearchParams[] = []
    const track = { '/orders': (url: URL) => (seen.push(url.searchParams), ok(orderList([orderRow()]))) } as Record<string, Handler>
    const first = mountApp({ url: '/app/orders', pages, handlers: handlers(track) })
    await screen.findByRole('link', { name: '111-2223334-5556667' })
    expect(seen[0]!.get('cursor')).toBeNull()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索订单号或追踪号' }), '111-222{Enter}')
    await waitFor(() => expect(seen.some(params => params.get('q') === '111-222' && params.get('cursor') === null)).toBe(true))
    expect(screen.getByRole('list', { name: '已生效的条件' })).toHaveTextContent('111-222')
    expect(first.router.state.location.search).toMatchObject({ q: '111-222' })
    first.unmount()
    seen.length = 0
    mountApp({ url: '/app/orders?q=111-222&status=Shipped&refunded=true', pages, handlers: handlers(track) })
    await screen.findByRole('link', { name: '111-2223334-5556667' })
    expect(seen[0]!.get('q')).toBe('111-222')
    expect(seen[0]!.get('status')).toBe('Shipped')
    expect(seen[0]!.get('refunded')).toBe('true')
  })

  it('批量搜索：粘贴多行去空行去重后按精确匹配（qs）发给服务端；超过 500 个不让提交', async () => {
    const seen: URLSearchParams[] = []
    mountApp({ url: '/app/orders', pages, handlers: handlers({ '/orders': url => (seen.push(url.searchParams), ok(orderList([orderRow()]))) }) })
    await screen.findByRole('link', { name: '111-2223334-5556667' })
    await userEvent.click(screen.getByRole('button', { name: /^批\s?量$/ }))
    const dialog = await screen.findByRole('dialog')
    const box = within(dialog).getByRole('textbox', { name: '批量搜索内容' })
    await userEvent.click(box)
    await userEvent.paste('AAA\n\nbbb\naaa\n  \nCCC,DDD')
    expect(within(dialog).getByText(/共 4 个词，已去掉 1 个重复/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /^搜\s?索$/ }))
    await waitFor(() => expect(seen.some(params => params.get('qs') === 'AAA,bbb,CCC,DDD')).toBe(true))
    expect(screen.getByRole('list', { name: '已生效的条件' })).toHaveTextContent('批量精确）：4 项')

    await userEvent.click(screen.getByRole('button', { name: /^批\s?量$/ }))
    const again = await screen.findByRole('dialog')
    const textarea = within(again).getByRole('textbox', { name: '批量搜索内容' })
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    await userEvent.paste(Array.from({ length: 501 }, (_, index) => `T${index}`).join('\n'))
    expect(within(again).getByRole('alert')).toHaveTextContent(/最多 500 个词/)
    expect(within(again).getByRole('button', { name: /^搜\s?索$/ })).toBeDisabled()
  })
})

describe('订单详情', () => {
  it('身份区 5 项指标；9 个页签；页签只在打开时才取数', async () => {
    const app = mountApp({
      url: '/app/orders/o1',
      pages,
      handlers: handlers({ '/orders/o1/items': () => ok({ items: [], cancellation: null, associatedItems: { state: 'NOT_CONNECTED', note: '同步器尚未读取关联商品' } }) }),
    })
    expect(await screen.findByText('订单金额')).toBeInTheDocument()
    for (const label of ['概览', '订单行', '收入与费用', '履约与包裹', '退款与退货', '财务交易', '买家信息', '时间线', '风险标记']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/orders/o1/items')).toBe(false)
    await userEvent.click(screen.getByRole('tab', { name: '订单行' }))
    expect(await screen.findByText(/同步器尚未读取关联商品/)).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/orders/o1/items')).toBe(true)
  })

  it('整页详情骨架（P6-05）：编码字段组一行显示店铺与站点；页签条在吸顶容器里', async () => {
    mountApp({ url: '/app/orders/o1', pages, handlers: handlers() })
    const codes = await screen.findByLabelText('编码')
    expect(within(codes).getByText('店铺')).toBeInTheDocument()
    expect(within(codes).getByText('站点')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '概览' }).closest('.erp-detail-sticky')).not.toBeNull()
  })

  it('只有 orders.read：退款与退货、财务交易、买家信息页签都不出现', async () => {
    mountApp({ url: '/app/orders/o1', pages, handlers: handlers({ '/orders/o1': () => ok(identity({ buyerInfo: { access: 'RESTRICTED', state: 'AVAILABLE', expiresAt: null } })) }, ['orders.read']) })
    await screen.findByRole('tab', { name: '概览' })
    for (const label of ['退款与退货', '财务交易', '买家信息']) expect(screen.queryByRole('tab', { name: label })).not.toBeInTheDocument()
  })

  it('收入与费用页签：与财务交易有差异时写出金额；没有费用明细时写原因', async () => {
    const charges = {
      currency: 'USD',
      lines: [],
      revenue: { item: 50, shipping: 5, promotion: -1, tax: 5.9, other: 0, totalExTax: 54, total: 59.9 },
      fees: [],
      feeTotal: null,
      match: { state: 'DIFF', note: '收入与财务交易不一致', revenue: { order: 54, finance: 50, diff: 4 }, tax: null },
    }
    mountApp({ url: '/app/orders/o1', pages, handlers: handlers({ '/orders/o1/charges': () => ok(charges) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '收入与费用' }))
    expect(await screen.findByText('与财务交易有差异')).toBeInTheDocument()
    expect(screen.getByText(/订单接口 \$54.00，财务交易 \$50.00，差 \$4.00/)).toBeInTheDocument()
    expect(screen.getByText(/这个订单还没有财务交易明细/)).toBeInTheDocument()
  })

  it('读取失败：显示正式的错误状态，不白屏', async () => {
    mountApp({
      url: '/app/orders/o1',
      pages,
      handlers: handlers({ '/orders/o1': () => ({ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: '订单不存在或不在当前范围内' } } }) }),
    })
    expect(await screen.findByText(/订单不存在或不在当前范围内/)).toBeInTheDocument()
  })
})

describe('买家信息页签', () => {
  const open = async (over: Record<string, Handler> = {}, info = identity()) => {
    const app = mountApp({ url: '/app/orders/o1', pages, handlers: handlers({ '/orders/o1': () => ok(info), ...over }) })
    await userEvent.click(await screen.findByRole('tab', { name: '买家信息' }))
    return app
  }

  it('默认只有遮罩；看不到任何明文', async () => {
    await open()
    expect(await screen.findByTestId('pii-masked-block')).toBeInTheDocument()
    expect(screen.getAllByLabelText('已隐藏').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('张三')
    expect(screen.getByText(/加密保存，保留至/)).toBeInTheDocument()
  })

  it('不填理由不发请求；填写后带着理由发出，明文只显示在页面里；立即隐藏后消失', async () => {
    let body: Record<string, unknown> | undefined
    await open({
      '/pii/reveal': (_url, init) => {
        body = JSON.parse(String(init?.body))
        return ok(piiOk)
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: /查看买家信息/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('textbox', { name: '查看原因' }), '客服处理退款咨询')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    expect(await screen.findByTestId('pii-revealed')).toHaveTextContent('张三')
    expect(body).toEqual({
      objectType: 'ORDER',
      objectId: 'o1',
      fields: ['buyerName', 'buyerEmail', 'buyerPhone', 'addressLine1', 'city', 'state', 'postalCode', 'country'],
      reason: '客服处理退款咨询',
    })
    expect(screen.getByTestId('pii-field')).toHaveTextContent(/60 秒后自动隐藏/)
    await userEvent.click(screen.getByRole('button', { name: '立即隐藏' }))
    await waitFor(() => expect(screen.queryByTestId('pii-revealed')).not.toBeInTheDocument())
    expect(document.body.textContent).not.toContain('张三')
  })

  it('60 秒后自动隐藏', async () => {
    await open({ '/pii/reveal': () => ok(piiOk) })
    await userEvent.click(await screen.findByRole('button', { name: /查看买家信息/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: '查看原因' }), '客服处理退款咨询')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认查看' }))
    await screen.findByTestId('pii-revealed')
    // 把时钟拨到 61 秒之后，下一次计时器触发（每秒一次）就会自动隐藏
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 61000)
    await waitFor(() => expect(screen.queryByTestId('pii-revealed')).not.toBeInTheDocument(), { timeout: 4000 })
    vi.restoreAllMocks()
  })

  it('已超过保留期或尚未同步：不给查看按钮，写明原因', async () => {
    await open({}, identity({ buyerInfo: { access: 'ALLOWED', state: 'EXPIRED', expiresAt: '2026-01-01T00:00:00.000Z' } }))
    expect(await screen.findByText(/已超过保留期/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /查看买家信息/ })).not.toBeInTheDocument()
  })
})
