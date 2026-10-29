import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ShipFromListResponse, ShipFromRow } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 发货地址页（P6-08）：PagedGrid 列表、按权限禁用写操作、新增地址提交到服务端。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { ShipFromAddressesPage: { load: () => import('./ShipFromAddressesPage') } }
const ok = (data: unknown) => ({ body: { success: true, data } })

const row = (patch: Partial<ShipFromRow> = {}): ShipFromRow => ({
  id: 'sf1',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  name: '深圳仓',
  addressLine1: '龙岗区 1 号',
  addressLine2: null,
  city: '深圳',
  stateOrProvince: 'GD',
  postalCode: '518000',
  countryCode: 'CN',
  phone: '13800000000',
  isDefault: true,
  status: 'ACTIVE',
  version: 1,
  usedByPlans: 0,
  createdAt: '2026-12-10T08:00:00Z',
  updatedAt: '2026-12-10T08:00:00Z',
  ...patch,
})

const list = (items: ShipFromRow[], patch: Partial<ShipFromListResponse> = {}): ShipFromListResponse => ({
  items,
  page: 1,
  pageSize: 50,
  total: items.length,
  summary: { total: items.length, active: items.filter(item => item.status === 'ACTIVE').length, inactive: items.filter(item => item.status === 'INACTIVE').length },
  canManage: true,
  manageBlockedReason: null,
  ...patch,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/ship-from-addresses': () => ok(list([row(), row({ id: 'sf2', name: '东莞仓', isDefault: false })])),
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('发货地址页', () => {
  it('列表：显示地址、店铺与统计；默认地址有标记', async () => {
    mountApp({ url: '/app/settings/ship-from', pages, handlers: handlers() })
    expect(await screen.findByText('深圳仓')).toBeInTheDocument()
    expect(screen.getByText('东莞仓')).toBeInTheDocument()
    expect(screen.getByText(/范围内共 2 个地址/)).toBeInTheDocument()
    expect(screen.getByText(/使用中 2 个/)).toBeInTheDocument()
  })

  it('没有“发货地址维护”权限：新增按钮禁用，并显示服务端给出的原因', async () => {
    mountApp({
      url: '/app/settings/ship-from',
      pages,
      handlers: handlers({ '/ship-from-addresses': () => ok(list([row()], { canManage: false, manageBlockedReason: '没有“发货地址维护”权限（企业所有者、管理员与供应链有）' })) }, ['inbound.read']),
    })
    expect(await screen.findByText('深圳仓')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新增发货地址/ })).toBeDisabled()
    expect(await screen.findByText('你可以查看发货地址，但不能修改')).toBeInTheDocument()
  })

  it('没有任何地址：说明怎么新增，不显示空白表', async () => {
    mountApp({ url: '/app/settings/ship-from', pages, handlers: handlers({ '/ship-from-addresses': () => ok(list([])) }) })
    expect(await screen.findByText(/还没有发货地址/)).toBeInTheDocument()
  })

  it('新增：必填项为空被前端拦下；填完提交，带上店铺与地址字段', async () => {
    let body: Record<string, unknown> | null = null
    const app = mountApp({
      url: '/app/settings/ship-from',
      pages,
      handlers: handlers({
        '/ship-from-addresses': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body)) as Record<string, unknown>
            return { status: 201, body: { success: true, data: row({ id: 'sf3' }) } }
          }
          return ok(list([row()]))
        },
      }),
    })
    await screen.findByText('深圳仓')
    await userEvent.click(screen.getByRole('button', { name: /新增发货地址/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    expect((await within(dialog).findAllByText(/请(输入|选择|填写)/)).length).toBeGreaterThan(0)
    expect(body).toBeNull()
    expect(app.calls.some(call => call.method === 'POST' && call.path === '/ship-from-addresses')).toBe(false)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^保\s?存$/ })).toBeEnabled())

    await userEvent.click(within(dialog).getByRole('combobox', { name: '店铺' }))
    await userEvent.click(await screen.findByText('Northstar US', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(within(dialog).getByLabelText('地址名称'), '  广州仓 ')
    await userEvent.type(within(dialog).getByLabelText('地址行 1'), '白云区 2 号')
    await userEvent.type(within(dialog).getByLabelText('城市'), '广州')
    await userEvent.type(within(dialog).getByLabelText('州或省代码'), 'GD')
    await userEvent.type(within(dialog).getByLabelText('邮编'), '510000')
    await userEvent.type(within(dialog).getByLabelText('国家代码'), 'CN')
    await userEvent.type(within(dialog).getByLabelText('电话'), '13900000000')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toMatchObject({
      sellerAccountId: 'st1',
      name: '广州仓',
      addressLine1: '白云区 2 号',
      city: '广州',
      stateOrProvince: 'GD',
      postalCode: '510000',
      countryCode: 'CN',
      phone: '13900000000',
      isDefault: false,
    })
    expect(body).not.toHaveProperty('addressLine2')
  })
})
