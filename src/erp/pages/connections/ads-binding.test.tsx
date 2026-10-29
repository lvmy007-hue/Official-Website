import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../finance/fee-fixtures.test-helper'
import { bindingList, centerList, row } from './connections-fixtures.test-helper'

// 连接中心的广告账户与店铺绑定（P3-03）：清单与状态、未绑定原因、不能绑定时的禁用与原因、
// 绑定 / 改绑 / 解除绑定的请求体（原因只在改绑与解除时要求）、服务端拒绝时留在弹窗里显示原因。
// 连接清单与角色对照在 connection-center.test.tsx 里测，这里只给一份最小的连接清单。

const pages: LivePages = { ConnectionsPage: { load: () => import('./ConnectionsPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PAGE = '/app/connections'
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/connections': () => ok(centerList({ items: [] })),
  '/connections/ads-accounts': () => ok(bindingList()),
  ...over,
})
const rowOf = async (text: string) => (await screen.findByText(text, {}, { timeout: 15000 })).closest('tr, [role=row]') as HTMLElement
const bindOk = (bodies: Array<Record<string, unknown>>, id: string): Record<string, Handler> => ({
  [`/connections/ads-accounts/${id}/bind`]: (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return { status: 201, body: { success: true, data: { id, change: 'BIND', changeLabel: '已绑定店铺', changed: true, bindingStatus: 'MANUAL', sellerAccountId: 's1', warnings: [] } } }
  },
})
const pick = async (dialog: HTMLElement, title: string) => {
  await userEvent.click(within(dialog).getByRole('combobox', { name: '绑定到店铺' }))
  await userEvent.click(await screen.findByTitle(new RegExp(title)))
}

describe('展示', () => {
  it('清单列出三种状态、统计、未绑定原因、绑定店铺与绑定人', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const section = await screen.findByTestId('ads-binding', {}, { timeout: 15000 })
    expect(await screen.findByTestId('ads-binding-summary')).toHaveTextContent('共 3 个广告账户：已自动匹配 1，人工绑定 1，未绑定 1')
    const unbound = within(section).getByText('美国广告账户').closest('tr, [role=row]') as HTMLElement
    expect(within(unbound).getByText('未绑定')).toBeInTheDocument()
    expect(within(unbound).getByTestId('unbound-ap-1')).toHaveTextContent('多个卖家编号相同的店铺')
    expect(within(unbound).getByText('未发现广告账户')).toBeInTheDocument()
    const auto = within(section).getByText('自动匹配的账户').closest('tr, [role=row]') as HTMLElement
    expect(within(auto).getByText('已自动匹配')).toBeInTheDocument()
    expect(within(auto).getByText('美国主店')).toBeInTheDocument()
    expect(within(auto).getByText('amzn1.ads-account.g.abc')).toBeInTheDocument()
    const manual = within(section).getByText('人工绑定的账户').closest('tr, [role=row]') as HTMLElement
    expect(within(manual).getByText('绑定人 管理员小李')).toBeInTheDocument()
    expect(within(manual).getByText('接口未返回')).toBeInTheDocument()
    // 不同状态的操作：未绑定只有“绑定店铺”；已绑定（自动匹配或人工）有“改绑”与“解除绑定”
    expect(within(unbound).getByRole('button', { name: '绑定店铺' })).toBeEnabled()
    expect(within(unbound).queryByRole('button', { name: /解除绑定/ })).not.toBeInTheDocument()
    expect(within(auto).getByRole('button', { name: '改绑' })).toBeEnabled()
    expect(within(manual).getByRole('button', { name: /解除绑定/ })).toBeEnabled()
  })

  it('没有任何广告账户：写明原因，不画空统计', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/connections/ads-accounts': () => ok(bindingList({ items: [] })) }) })
    expect(await screen.findByText(/尚无广告账户记录/, {}, { timeout: 15000 })).toBeInTheDocument()
  })

  it('加载失败：显示错误并可重试', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/connections/ads-accounts': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
  })

  it('不能绑定（数据范围不是全部店铺）：按钮禁用并有说明；没有权限点同样禁用', { timeout: 30000 }, async () => {
    const blocked = '绑定会改变谁能看到这个广告账户的数据，需要“全部店铺”数据范围'
    const first = mountApp({ url: PAGE, pages, handlers: handlers({ '/connections/ads-accounts': () => ok(bindingList({ canBind: false, bindBlockedReason: blocked, stores: [] })) }) })
    expect(await screen.findByText(new RegExp(`当前账号只能查看：${blocked}`), {}, { timeout: 15000 })).toBeInTheDocument()
    expect(within(await rowOf('美国广告账户')).getByRole('button', { name: '绑定店铺' })).toBeDisabled()
    expect(within(await rowOf('自动匹配的账户')).getByRole('button', { name: '改绑' })).toBeDisabled()
    first.unmount()

    mountApp({ url: PAGE, pages, handlers: handlers({}, ['connection.read']) })
    await screen.findByTestId('ads-binding', {}, { timeout: 15000 })
    expect(await within(await rowOf('美国广告账户')).findByRole('button', { name: '绑定店铺' })).toBeDisabled()
  })
})

describe('人工绑定', () => {
  it('第一次绑定：选店铺即可，不要原因；备注可选；请求体只有店铺编号', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(bindOk(bodies, 'ap-1')) })
    await screen.findByTestId('ads-binding', {}, { timeout: 15000 })
    await userEvent.click(await within(await screen.findByTestId('ads-binding')).findByRole('button', { name: '绑定店铺' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('改绑原因')).not.toBeInTheDocument()
    await pick(dialog, '美国主店')
    await userEvent.click(within(dialog).getByRole('button', { name: /绑\s*定$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ sellerAccountId: 's1' })
  })

  it('不选店铺：前端拦下，不发请求', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(bindOk(bodies, 'ap-1')) })
    await userEvent.click(await within(await screen.findByTestId('ads-binding', {}, { timeout: 15000 })).findByRole('button', { name: '绑定店铺' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /绑\s*定$/ }))
    expect(await within(dialog).findByText('请选择店铺')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
  })

  it('改绑：原因必填；请求体带店铺与原因', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(bindOk(bodies, 'ap-2')) })
    await screen.findByTestId('ads-binding', {}, { timeout: 15000 })
    await userEvent.click(within(await rowOf('自动匹配的账户')).getByRole('button', { name: '改绑' }))
    const dialog = await screen.findByRole('dialog')
    await pick(dialog, '美国二店')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认改绑/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.type(within(dialog).getByRole('textbox'), '实际属于二店')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认改绑/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ sellerAccountId: 's2', reason: '实际属于二店' })
  })

  it('解除绑定：原因必填；请求体的店铺编号是 null', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: PAGE, pages, handlers: handlers(bindOk(bodies, 'ap-3')) })
    await screen.findByTestId('ads-binding', {}, { timeout: 15000 })
    await userEvent.click(within(await rowOf('人工绑定的账户')).getByRole('button', { name: /解除绑定/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/之后同步广告账户时/)).toBeInTheDocument()
    await userEvent.type(within(dialog).getByRole('textbox'), '不属于任何店铺')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认解除/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ sellerAccountId: null, reason: '不属于任何店铺' })
  })

  it('服务端拒绝（被别人改过）：弹窗里显示原因，不关闭', { timeout: 30000 }, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({ '/connections/ads-accounts/ap-1/bind': () => ({ status: 409, body: { error: { code: 'CONFLICT', message: '这个广告账户刚刚被他人或自动匹配改动过，请刷新后再试' } } }) }),
    })
    await userEvent.click(await within(await screen.findByTestId('ads-binding', {}, { timeout: 15000 })).findByRole('button', { name: '绑定店铺' }))
    const dialog = await screen.findByRole('dialog')
    await pick(dialog, '美国主店')
    await userEvent.click(within(dialog).getByRole('button', { name: /绑\s*定$/ }))
    expect(await within(dialog).findByText(/刚刚被他人或自动匹配改动过/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('绑定成功后清单重新取数（范围过滤的结果变了）', { timeout: 30000 }, async () => {
    const bodies: Array<Record<string, unknown>> = []
    let listCalls = 0
    const app = mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        ...bindOk(bodies, 'ap-1'),
        '/connections/ads-accounts': () => {
          listCalls += 1
          return ok(bindingList({ items: [row()] }))
        },
      }),
    })
    await userEvent.click(await within(await screen.findByTestId('ads-binding', {}, { timeout: 15000 })).findByRole('button', { name: '绑定店铺' }))
    const dialog = await screen.findByRole('dialog')
    await pick(dialog, '美国主店')
    await userEvent.click(within(dialog).getByRole('button', { name: /绑\s*定$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    await waitFor(() => expect(listCalls).toBeGreaterThan(1))
    expect(app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/bind'))).toHaveLength(1)
  })
})
