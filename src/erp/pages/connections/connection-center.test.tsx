import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../finance/fee-fixtures.test-helper'
import { adsConnRow, bindingList, centerList, derivedRow, roleData, sellerRow } from './connections-fixtures.test-helper'

// 连接中心（P5-04，09 章 9.6）：四类连接、授权主体与范围、健康检查项、失败码、令牌更新与预计失效、角色对照；
// 授权、重新授权、健康检查、断开（再次验证身份）的请求；没有权限或服务端说不能做时按钮禁用并写明原因；授权回调的结果提示。

const goToAuthorization = vi.hoisted(() => vi.fn())
vi.mock('./redirect', () => ({ goToAuthorization }))

const T = { timeout: 30000 }
const pages: LivePages = { ConnectionsPage: { load: () => import('./ConnectionsPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  goToAuthorization.mockReset()
})

const PAGE = '/app/connections'
const handlers = (center: ReturnType<typeof centerList> = centerList(), over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/connections': () => ok(center),
  '/connections/ads-accounts': () => ok(bindingList({ items: [] })),
  ...over,
})
const loaded = async () => await screen.findByTestId('connections-summary', {}, { timeout: 15000 })
const card = async (kind: string) => (await loaded(), await screen.findByTestId(`kind-${kind}`))
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const created = (data: unknown) => ({ status: 201, body: { success: true, data } })

describe('展示', () => {
  it('四类连接各一块；授权连接显示主体、授权人、账户、授权范围、健康检查项、最近成功、令牌更新', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const seller = await card('SELLER')
    expect(within(seller).getByText('星河贸易有限公司')).toBeInTheDocument()
    expect(within(seller).getByText('授权人 管理员小李')).toBeInTheDocument()
    expect(within(seller).getByText('卖家编号 SELLER-A')).toBeInTheDocument()
    expect(within(seller).getByText('店铺 美国主店')).toBeInTheDocument()
    expect(within(seller).getByText('美国站（ATVPDKIKX0DER）')).toBeInTheDocument()
    expect(within(seller).getByText('已授权')).toBeInTheDocument()
    expect(within(seller).getByText('正常')).toBeInTheDocument()
    expect(within(seller).getByTestId('check-token')).toHaveTextContent('换取访问令牌：通过')
    expect(within(seller).getByTestId('check-marketplace')).toHaveTextContent('参与美国站：通过')
    expect(within(seller).getByText('无')).toBeInTheDocument() // 没有失败码
    expect(within(seller).getByText('未推算')).toBeInTheDocument() // 没有设置授权最长年龄就不推算预计失效

    const ads = await card('ADS')
    expect(within(ads).getByText('广告账户（3 个档案）')).toBeInTheDocument()
    expect(within(ads).getByText('advertising::campaign_management')).toBeInTheDocument()
    expect(within(ads).getByText('尚未检查')).toBeInTheDocument()
    expect(within(ads).getByText('尚无成功同步')).toBeInTheDocument()

    const report = await card('REPORT_ROLE')
    expect(within(report).getByText('已具备')).toBeInTheDocument()
    expect(within(report).getByText('8 项报告：7 项可取，1 项缺少角色')).toBeInTheDocument()
    expect(within(report).queryByRole('button', { name: /授权|断开|验证|检查|重试/ })).not.toBeInTheDocument() // 推断出来的两类没有授权动作
    const brand = await card('BRAND_ANALYTICS')
    expect(within(brand).getByText('不适用（无品牌备案）')).toBeInTheDocument()
    expect(await screen.findByTestId('connections-summary')).toHaveTextContent('共 4 个连接，已授权 2')
  })

  it('授权失效：显示失败码与中文原因、异常状态、没有通过的检查项；令牌预计失效给出日期与依据', T, async () => {
    const row = sellerRow({
      state: 'EXPIRED',
      stateLabel: '授权已失效',
      tone: 'error',
      failureCode: 'AUTH_EXPIRED',
      failureText: '亚马逊授权已失效，请重新授权',
      health: {
        status: 'UNHEALTHY',
        statusLabel: '异常',
        checkedAt: '2026-10-25T01:00:00.000Z',
        checks: [
          { key: 'token', label: '换取访问令牌', ok: false, message: 'AUTH_EXPIRED' },
          { key: 'api', label: '调用卖家接口', ok: null, message: null },
          { key: 'marketplace', label: '参与美国站', ok: null, message: null },
        ],
      },
      tokenExpiry: { state: 'SOON', expiresAt: '2026-11-10T00:00:00.000Z', daysLeft: 16, basis: '按预警规则设置的授权最长年龄 365 天推算，不是亚马逊公布的有效期' },
    })
    mountApp({ url: PAGE, pages, handlers: handlers(centerList({ items: [row] })) })
    const seller = await card('SELLER')
    expect(within(seller).getByText('授权已失效')).toBeInTheDocument()
    expect(within(seller).getByText('AUTH_EXPIRED')).toBeInTheDocument()
    expect(within(seller).getByText('亚马逊授权已失效，请重新授权')).toBeInTheDocument()
    expect(within(seller).getByText('异常')).toBeInTheDocument()
    expect(within(seller).getByTestId('check-token')).toHaveTextContent('换取访问令牌：未通过（AUTH_EXPIRED）')
    expect(within(seller).getByTestId('check-api')).toHaveTextContent('调用卖家接口：未检查')
    expect(within(seller).getByTestId('token-expiry')).toHaveTextContent('预计 16 天后失效')
    // 没有连接时，其余三类都写明前置条件，不画空表
    expect(within(await card('ADS')).getByText(/尚未授权广告接口/)).toBeInTheDocument()
  })

  it('没有任何连接：每块写明怎么开始，角色对照提示先授权', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(centerList({ items: [], roles: roleData([]) })) })
    expect(within(await card('SELLER')).getByText(/尚未授权卖家接口/)).toBeInTheDocument()
    expect(within(await card('REPORT_ROLE')).getByText(/需要先授权卖家接口并完成一次同步/)).toBeInTheDocument()
    expect(await screen.findByText('还没有已授权的卖家店铺，授权后才能对照角色。')).toBeInTheDocument()
  })

  it('加载失败：显示错误并可重试', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(centerList(), { '/connections': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
  })
})

describe('角色对照', () => {
  it('缺角色的板块写明影响哪些页面（可点进去）；逐个角色显示状态；写明推断依据', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const panel = await screen.findByTestId('role-comparison', {}, { timeout: 15000 })
    expect(within(panel).getByText(/最近一次同步的结果推断/)).toBeInTheDocument()
    const support = within(panel).getAllByText('支持案件')[0]!.closest('tr, [role=row]') as HTMLElement
    expect(within(support).getByText('缺少角色')).toBeInTheDocument()
    expect(within(support).getByRole('note')).toHaveTextContent('缺少所需角色')
    expect(within(support).getAllByRole('link').length).toBeGreaterThan(0)
    const orders = within(panel).getAllByText('订单')[0]!.closest('tr, [role=row]') as HTMLElement
    expect(within(orders).getByText('已打通')).toBeInTheDocument()
    expect(within(orders).queryByRole('note')).not.toBeInTheDocument()
    expect(within(panel).getByText(/个功能板块缺少所需角色/)).toBeInTheDocument()
    expect(within(panel).getByText('角色逐项')).toBeInTheDocument()
    const role = within(panel)
      .getAllByText('卖家支持（受限）')
      .find(node => node.closest('tr, [role=row]')?.textContent?.includes('缺失'))
    expect(role).toBeTruthy()
  })
})

describe('动作', () => {
  it('健康检查：提交后台任务，成功提示后重新取数', T, async () => {
    const calls: string[] = []
    let listCalls = 0
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(centerList(), {
        '/connections': () => (listCalls++, ok(centerList())),
        '/connections/conn-1/health-check': () => (calls.push('check'), created({ connectionId: 'conn-1', syncJobId: 'job-1', alreadyRunning: false })),
      }),
    })
    const seller = await card('SELLER')
    await userEvent.click(within(seller).getByRole('button', { name: '健康检查' }))
    await waitFor(() => expect(calls).toEqual(['check']))
    expect(await screen.findByText('已提交健康检查，结果稍后出现在这一行')).toBeInTheDocument()
    await waitFor(() => expect(listCalls).toBeGreaterThan(1))
  })

  it('重新授权：先预览说明（卖家要用原账号），确认后调接口并跳转到返回的授权地址', T, async () => {
    let called = 0
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(centerList(), {
        '/connections/conn-1/reauthorize': () => (
          called++,
          created({ connectionId: 'conn-1', provider: 'AMAZON_SP_API', authorizationUrl: 'https://sellercentral.amazon.com/apps/authorize/consent?state=x' })
        ),
      }),
    })
    await userEvent.click(within(await card('SELLER')).getByRole('button', { name: '重新授权' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/必须与当前连接是同一个/)).toBeInTheDocument()
    expect(called).toBe(0)
    await userEvent.click(within(dialog).getByRole('button', { name: '前往授权' }))
    await waitFor(() => expect(goToAuthorization).toHaveBeenCalledWith('https://sellercentral.amazon.com/apps/authorize/consent?state=x'))
    expect(called).toBe(1)
  })

  it('断开：原因必填、必须勾选确认、再次验证身份；先验证再提交，请求体只有原因', T, async () => {
    const order: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(centerList(), {
        '/auth/step-up': (_url, init) => (order.push(`step-up:${String(bodyOf(init).action)}`), ok({ expiresAt: '2026-10-25T12:00:00Z' })),
        '/connections/conn-1/disconnect': (_url, init) => (order.push('disconnect'), bodies.push(bodyOf(init)), created({ connectionId: 'conn-1', state: 'REVOKED', cancelledJobs: 2 })),
      }),
    })
    await userEvent.click(within(await card('SELLER')).getByRole('button', { name: /断\s*开/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/排队中的同步任务全部取消/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '确认断开' }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.type(within(dialog).getByLabelText('断开原因'), '店铺已转让')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认断开' }))
    expect(await within(dialog).findByText('请先勾选确认')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: '确认断开' }))
    await waitFor(() => expect(order).toEqual(['step-up:connection.disconnect', 'disconnect']))
    expect(bodies).toEqual([{ reason: '店铺已转让' }])
  })

  it('断开：服务端拒绝时弹窗不关，显示原因', T, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(centerList(), {
        '/auth/step-up': () => ok({ expiresAt: '2026-10-25T12:00:00Z' }),
        '/connections/conn-1/disconnect': () => ({ status: 409, body: { error: { code: 'CONNECTION_ALREADY_DISCONNECTED', message: '连接已经断开' } } }),
      }),
    })
    await userEvent.click(within(await card('SELLER')).getByRole('button', { name: /断\s*开/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('断开原因'), '重复点击')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: '确认断开' }))
    expect(await within(dialog).findByText(/连接已经断开/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('授权卖家接口：选法人主体，请求体带法人主体与区域，跳转到返回的授权地址；不选被拦下', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers(
        centerList({
          items: [],
          legalEntities: [
            { id: 'le1', name: '星河贸易有限公司' },
            { id: 'le2', name: '星云商贸有限公司' },
          ],
        }),
        {
          '/sp-api/oauth/start': (_url, init) => (bodies.push(bodyOf(init)), created({ authorizationUrl: 'https://sellercentral.amazon.com/apps/authorize/consent?state=y' })),
        },
      ),
    })
    await loaded()
    await userEvent.click(await screen.findByRole('button', { name: '授权卖家接口' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '前往亚马逊授权' }))
    expect(await within(dialog).findByText('请选择法人主体')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('combobox', { name: '法人主体' }))
    await userEvent.click(await screen.findByTitle('星河贸易有限公司'))
    await userEvent.click(within(dialog).getByRole('button', { name: '前往亚马逊授权' }))
    await waitFor(() => expect(bodies).toEqual([{ legalEntityId: 'le1', region: 'NA' }]))
    await waitFor(() => expect(goToAuthorization).toHaveBeenCalledWith('https://sellercentral.amazon.com/apps/authorize/consent?state=y'))
  })

  it('授权广告接口：确认后调广告授权接口并跳转', T, async () => {
    let called = 0
    mountApp({ url: PAGE, pages, handlers: handlers(centerList({ items: [] }), { '/ads/oauth/start': () => (called++, created({ authorizationUrl: 'https://www.amazon.com/ap/oa?client_id=x' })) }) })
    await loaded()
    await userEvent.click(await screen.findByRole('button', { name: '授权广告接口' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '前往亚马逊授权' }))
    await waitFor(() => expect(goToAuthorization).toHaveBeenCalledWith('https://www.amazon.com/ap/oa?client_id=x'))
    expect(called).toBe(1)
  })
})

describe('不能做时的禁用与原因', () => {
  it('只能查看（服务端说不能管理）：授权与三个动作全部禁用，页面说明原因', T, async () => {
    const reason = '需要“全部店铺”数据范围才能管理连接'
    const blocked = { allowed: false, reason }
    const row = sellerRow({ actions: { healthCheck: blocked, reauthorize: blocked, disconnect: blocked } })
    mountApp({ url: PAGE, pages, handlers: handlers(centerList({ items: [row], canManage: false, manageBlockedReason: reason, legalEntities: [] })) })
    expect(await screen.findByText(new RegExp(`当前账号只能查看：${reason}`), {}, { timeout: 15000 })).toBeInTheDocument()
    const seller = await card('SELLER')
    for (const name of ['健康检查', '重新授权', /断\s*开/]) expect(within(seller).getByRole('button', { name })).toBeDisabled()
    expect(screen.getByRole('button', { name: '授权卖家接口' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '授权广告接口' })).toBeDisabled()
  })

  it('没有管理连接的权限点（即使服务端说可以）：同样禁用', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers(centerList(), {}, ['connection.read']) })
    const seller = await card('SELLER')
    expect(within(seller).getByRole('button', { name: '健康检查' })).toBeDisabled()
    expect(within(seller).getByRole('button', { name: /断\s*开/ })).toBeDisabled()
  })

  it('已断开的连接：健康检查与断开禁用，重新授权可用', T, async () => {
    const row = sellerRow({
      state: 'REVOKED',
      stateLabel: '已断开',
      tone: 'default',
      hasToken: false,
      actions: { healthCheck: { allowed: false, reason: '连接已断开，请先重新授权' }, reauthorize: { allowed: true, reason: null }, disconnect: { allowed: false, reason: '连接已经断开' } },
    })
    mountApp({ url: PAGE, pages, handlers: handlers(centerList({ items: [row, adsConnRow(), derivedRow('REPORT_ROLE')] })) })
    const seller = await card('SELLER')
    expect(within(seller).getByText('已断开')).toBeInTheDocument()
    expect(within(seller).getByRole('button', { name: '健康检查' })).toBeDisabled()
    expect(within(seller).getByRole('button', { name: /断\s*开/ })).toBeDisabled()
    expect(within(seller).getByRole('button', { name: '重新授权' })).toBeEnabled()
  })
})

describe('授权回调结果', () => {
  it('卖家账号与原连接不一致：显示原因与错误码', T, async () => {
    mountApp({ url: `${PAGE}?provider=sp-api&status=error&code=OAUTH_SELLER_MISMATCH`, pages, handlers: handlers() })
    expect(await screen.findByText('卖家接口授权没有完成', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getByText(/不是同一个，没有更新/)).toHaveTextContent('错误码 OAUTH_SELLER_MISMATCH')
  })

  it('授权成功：提示已自动做健康检查', T, async () => {
    mountApp({ url: `${PAGE}?provider=ads&status=connected`, pages, handlers: handlers() })
    expect(await screen.findByText('广告接口授权成功', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getByText(/已自动提交一次健康检查/)).toBeInTheDocument()
  })

  it('没有回调参数：不显示提示', T, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await card('SELLER')
    expect(screen.queryByText(/授权没有完成|授权成功/)).not.toBeInTheDocument()
  })
})
