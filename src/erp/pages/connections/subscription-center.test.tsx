import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../finance/fee-fixtures.test-helper'
import { STORE_B, missingDestination, subItem, subList } from './subscription-fixtures.test-helper'

// 消息推送订阅页（P5-05，09 章 9.7）：列表字段、接收端未接入的正式状态（所需配置与受影响页面）、没有权限与店铺未授权时按钮禁用并写明原因；
// 订阅、改过滤条件、取消订阅、重放失败事件的请求；筛选。

const T = { timeout: 30000 }
const pages: LivePages = { NotificationSubscriptionsPage: { load: () => import('./NotificationSubscriptionsPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/connections/notifications'
const LIST = '/notifications/subscriptions'
const handlers = (list: ReturnType<typeof subList> = subList(), over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [LIST]: () => ok(list),
  ...over,
})
const loaded = async () => await screen.findByTestId('subscriptions-summary', {}, { timeout: 15000 })
const rowOf = async (label: string) => (await loaded(), (await screen.findByText(label)).closest('tr, [role=row]') as HTMLElement)
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const accepted = (data: unknown) => ({ status: 202, body: { success: true, data } })

describe('展示', () => {
  it('每行显示推送类型与依赖页面、订阅状态、过滤条件、目的地、最近收到、近 24 小时事件数与失败数；顶部汇总', T, async () => {
    const list = subList({
      items: [
        subItem({ type: 'ORDER_CHANGE', rowStatus: 'ACTIVE', events24h: 42, failures24h: 2, lastReceivedAt: '2026-10-25T01:00:00.000Z' }),
        subItem({ type: 'ANY_OFFER_CHANGED', rowStatus: 'ACTIVE', filter: { marketplaceIds: ['ATVPDKIKX0DER'], aggregationTimePeriod: 'FiveMinutes' } }),
        subItem({ type: 'TRANSACTION_UPDATE', rowStatus: 'NOT_CREATED' }),
        subItem({ type: 'SHIPMENT_TRACKING_MILESTONE_CHANGED', rowStatus: 'INVALID' }),
      ],
    })
    mountApp({ url: PAGE, pages, handlers: handlers(list) })
    expect(await loaded()).toHaveTextContent('已订阅 2，处理中 1，已失效 1；近 24 小时收到 42 条事件，失败 2 条')
    const order = await rowOf('订单变化')
    expect(within(order).getByText('ORDER_CHANGE')).toBeInTheDocument()
    expect(within(order).getByText('今日实时')).toBeInTheDocument()
    expect(within(order).getByText('有效')).toBeInTheDocument()
    expect(within(order).getByText('****0001')).toBeInTheDocument()
    expect(within(order).getByText('42')).toBeInTheDocument()
    expect(within(order).getByText('2')).toBeInTheDocument()
    expect(within(order).getByText('不支持过滤')).toBeInTheDocument()
    expect(within(await rowOf('报价变化')).getByText('站点：美国站；聚合周期：5 分钟')).toBeInTheDocument()
    expect(within(await rowOf('财务交易更新')).getByText('处理中')).toBeInTheDocument()
    expect(within(await rowOf('货件追踪节点变化')).getByText('已失效')).toBeInTheDocument()
  })

  it('没订阅的行不写 0：状态、事件数、失败数都写“未订阅”；店铺没有授权标明“店铺未授权”', T, async () => {
    const list = subList({ items: [subItem({ type: 'ORDER_CHANGE' }), subItem({ type: 'TRANSACTION_UPDATE', store: STORE_B })] })
    mountApp({ url: PAGE, pages, handlers: handlers(list) })
    const first = await rowOf('订单变化')
    expect(within(first).getAllByText('未订阅')).toHaveLength(3)
    expect(within(first).queryByText('0')).not.toBeInTheDocument()
    const second = await rowOf('财务交易更新')
    expect(within(second).getByText('店铺未授权')).toBeInTheDocument()
    expect(within(second).getByRole('button', { name: /^订\s*阅$/ })).toBeDisabled()
  })

  it('接收端没接入：正式提示、所需配置、受影响的页面与退化说明；行显示“接收端未接入”与“尚未接入”，订阅按钮禁用', T, async () => {
    const list = subList({
      destination: missingDestination(),
      items: [subItem({ type: 'ORDER_CHANGE', destinationConfigured: false })],
    })
    mountApp({ url: PAGE, pages, handlers: handlers(list) })
    await loaded()
    const alert = await screen.findByTestId('destination-alert')
    expect(alert).toHaveTextContent('推送接收端尚未接入（部署专项）')
    expect(alert).toHaveTextContent('AMAZON_NOTIFICATION_DESTINATION_ID')
    expect(alert).toHaveTextContent('按补偿频率定时同步')
    const affected = screen.getByTestId('affected-pages')
    expect(affected).toHaveTextContent('今日实时')
    expect(affected).toHaveTextContent('定价与购物车（报价变化）')
    expect(affected).toHaveTextContent('今日广告（营销数据流（部署专项另行接入，本页不管理））')
    expect(screen.getByTestId('subscriptions-summary')).toHaveTextContent('接收端接入后才会有事件')
    const row = await rowOf('订单变化')
    expect(within(row).getByText('接收端未接入')).toBeInTheDocument()
    expect(within(row).getAllByText('尚未接入').length).toBeGreaterThanOrEqual(3)
    expect(within(row).getByRole('button', { name: /^订\s*阅$/ })).toBeDisabled()
  })

  it('已配置接收端：只提示目的地末位，不列受影响页面', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await loaded()
    expect(await screen.findByTestId('destination-alert')).toHaveTextContent('推送接收端已配置（****0001）')
    expect(screen.queryByTestId('affected-pages')).not.toBeInTheDocument()
  })

  it('没有订阅管理权限：提示只能查看，所有动作按钮禁用', T, async () => {
    const list = subList({
      canManage: false,
      items: [subItem({ type: 'ORDER_CHANGE', canManage: false }), subItem({ type: 'TRANSACTION_UPDATE', rowStatus: 'ACTIVE', failures24h: 1, canManage: false })],
    })
    mountApp({ url: PAGE, pages, handlers: handlers(list, {}, ['connection.read']) })
    await loaded()
    expect(await screen.findByText(/当前账号只能查看/)).toBeInTheDocument()
    expect(within(await rowOf('订单变化')).getByRole('button', { name: /^订\s*阅$/ })).toBeDisabled()
    const live = await rowOf('财务交易更新')
    for (const name of [/改过滤条件/, /重放失败事件/, /取消订阅/]) expect(within(live).getByRole('button', { name })).toBeDisabled()
  })

  it('加载失败：显示错误并可重试', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(subList(), { [LIST]: () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
  })

  it('没有任何店铺：写明先去连接中心授权', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(subList({ items: [], stores: [] })) })
    await loaded()
    expect(await screen.findByText(/还没有店铺/)).toBeInTheDocument()
  })
})

describe('筛选', () => {
  const items = [
    subItem({ type: 'ORDER_CHANGE', rowStatus: 'ACTIVE' }),
    subItem({ type: 'TRANSACTION_UPDATE' }),
    subItem({ type: 'ORDER_CHANGE', store: STORE_B }),
    subItem({ type: 'ANY_OFFER_CHANGED', store: STORE_B, rowStatus: 'INVALID' }),
  ]

  it('按店铺、状态、关键字筛选；没有符合条件的写明原因', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(subList({ items })) })
    await loaded()
    expect(await screen.findAllByText('订单变化')).toHaveLength(2)
    await userEvent.click(screen.getByRole('combobox', { name: '订阅状态' }))
    await userEvent.click(await screen.findByText('已有订阅记录', { selector: '.ant-select-item-option-content' }))
    await waitFor(() => expect(screen.queryByText('财务交易更新')).not.toBeInTheDocument())
    expect(screen.getAllByText('订单变化')).toHaveLength(1)
    expect(screen.getByText('报价变化')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: '搜索推送类型' }), '竞品')
    await waitFor(() => expect(screen.queryByText('订单变化')).not.toBeInTheDocument())
    expect(screen.getByText('报价变化')).toBeInTheDocument()
    await userEvent.clear(screen.getByRole('textbox', { name: '搜索推送类型' }))
    await userEvent.type(screen.getByRole('textbox', { name: '搜索推送类型' }), '不存在的类型')
    expect(await screen.findByText(/没有符合筛选条件的订阅/)).toBeInTheDocument()
  })
})

describe('动作', () => {
  it('订阅：先预览说明，确认后只带店铺与类型（不带过滤条件），成功提示后重新取数', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    let listCalls = 0
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(subList(), {
        [LIST]: (_url, init) => (init?.method === 'POST' ? (bodies.push(bodyOf(init)), accepted({ id: 'sub-new', status: 'NOT_CREATED' })) : (listCalls++, ok(subList()))),
      }),
    })
    await userEvent.click(within(await rowOf('订单变化')).getByRole('button', { name: /^订\s*阅$/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/亚马逊会把「订单变化」事件推送到接收端/)).toBeInTheDocument()
    expect(bodies).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: '确认订阅' }))
    await waitFor(() => expect(bodies).toEqual([{ sellerAccountId: 's1', notificationType: 'ORDER_CHANGE' }]))
    expect(await screen.findByText('已登记订阅，创建由后台任务完成，状态稍后更新')).toBeInTheDocument()
    await waitFor(() => expect(listCalls).toBeGreaterThan(1))
  })

  it('订阅报价变化：表单里选聚合周期，请求带过滤条件；不选站点就不带站点', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(subList({ items: [subItem({ type: 'ANY_OFFER_CHANGED' })] }), {
        [LIST]: (_url, init) =>
          init?.method === 'POST' ? (bodies.push(bodyOf(init)), accepted({ id: 'x', status: 'NOT_CREATED' })) : ok(subList({ items: [subItem({ type: 'ANY_OFFER_CHANGED' })] })),
      }),
    })
    await userEvent.click(within(await rowOf('报价变化')).getByRole('button', { name: /^订\s*阅$/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '聚合周期' }))
    await userEvent.click(await screen.findByText('5 分钟', { selector: '.ant-select-item-option-content' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '确认订阅' }))
    await waitFor(() => expect(bodies).toEqual([{ sellerAccountId: 's1', notificationType: 'ANY_OFFER_CHANGED', filter: { aggregationTimePeriod: 'FiveMinutes' } }]))
  })

  it('订阅被服务端拒绝（接收端未配置 503）：弹窗不关，显示原因', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(subList(), {
        [LIST]: (_url, init) => (init?.method === 'POST' ? { status: 503, body: { error: { code: 'DEPENDENCY_UNAVAILABLE', message: '推送接收端尚未配置' } } } : ok(subList())),
      }),
    })
    await userEvent.click(within(await rowOf('订单变化')).getByRole('button', { name: /^订\s*阅$/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认订阅' }))
    expect(await within(dialog).findByText(/推送接收端尚未配置/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('改过滤条件：表单带出当前条件，请求带订阅版本号；不支持过滤的类型按钮禁用并写明原因', T, async () => {
    const calls: Array<{ method?: string; body: Record<string, unknown> }> = []
    const list = subList({
      items: [
        subItem({ type: 'ANY_OFFER_CHANGED', rowStatus: 'ACTIVE', id: 'sub-offer', version: 4, filter: { aggregationTimePeriod: 'TenMinutes' } }),
        subItem({ type: 'ORDER_CHANGE', rowStatus: 'ACTIVE' }),
      ],
    })
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(list, {
        '/notifications/subscriptions/sub-offer': (_url, init) => (calls.push({ method: init?.method, body: bodyOf(init) }), ok({ id: 'sub-offer', status: 'NOT_CREATED', version: 5 })),
      }),
    })
    expect(within(await rowOf('订单变化')).getByRole('button', { name: /改过滤条件/ })).toBeDisabled()
    await userEvent.click(within(await rowOf('报价变化')).getByRole('button', { name: /改过滤条件/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('10 分钟')).toBeInTheDocument() // 当前条件
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '聚合周期' }))
    await userEvent.click(await screen.findByText('5 分钟', { selector: '.ant-select-item-option-content' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '确认修改' }))
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', body: { version: 4, filter: { aggregationTimePeriod: 'FiveMinutes' } } }]))
    expect(await screen.findByText('已提交修改，重建由后台任务完成，状态稍后更新')).toBeInTheDocument()
  })

  it('取消订阅：先预览（写明受影响的页面），确认后发 DELETE', T, async () => {
    const calls: string[] = []
    const list = subList({ items: [subItem({ type: 'ORDER_CHANGE', rowStatus: 'ACTIVE', id: 'sub-1' })] })
    mountApp({ url: PAGE, pages, handlers: handlers(list, { '/notifications/subscriptions/sub-1': (_url, init) => (calls.push(String(init?.method)), ok({ id: 'sub-1', removed: false })) }) })
    await userEvent.click(within(await rowOf('订单变化')).getByRole('button', { name: /取消订阅/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/订单、今日实时会退化为按补偿频率定时同步/)).toBeInTheDocument()
    expect(calls).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: '确认取消订阅' }))
    await waitFor(() => expect(calls).toEqual(['DELETE']))
    expect(await screen.findByText('已提交取消订阅，由后台任务完成')).toBeInTheDocument()
  })

  it('重放失败事件：有失败才可点；确认后请求全部失败事件；没有失败时禁用并写明原因', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    const list = subList({
      items: [subItem({ type: 'ORDER_CHANGE', rowStatus: 'ACTIVE', id: 'sub-1', failures24h: 3 }), subItem({ type: 'TRANSACTION_UPDATE', rowStatus: 'ACTIVE', id: 'sub-2' })],
    })
    mountApp({ url: PAGE, pages, handlers: handlers(list, { '/notifications/subscriptions/sub-1/replay': (_url, init) => (bodies.push(bodyOf(init)), accepted({ replayed: 3 })) }) })
    expect(within(await rowOf('财务交易更新')).getByRole('button', { name: /重放失败事件/ })).toBeDisabled()
    await userEvent.click(within(await rowOf('订单变化')).getByRole('button', { name: /重放失败事件/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/最多 200 条/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '确认重放' }))
    await waitFor(() => expect(bodies).toEqual([{ allFailed: true }]))
    expect(await screen.findByText('已提交重放，处理结果稍后更新')).toBeInTheDocument()
  })
})
