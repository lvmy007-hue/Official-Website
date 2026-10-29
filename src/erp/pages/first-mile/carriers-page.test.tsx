import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CarrierListResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { shipmentList, statsResponse } from '../inbound/receiving-fixtures.test-helper'
import { detail, listResponse, ok } from './first-mile-fixtures.test-helper'

// 物流渠道与报价页、头程详情的缺失字段提示与预估对比、三种差异表（P6-26）。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = {
  FirstMilePage: { load: () => import('./FirstMilePage') },
  FirstMileCarriersPage: { load: () => import('./FirstMileCarriersPage') },
  FirstMileDetailPage: { load: () => import('./FirstMileDetailPage') },
  ShipmentReceivingPage: { load: () => import('../inbound/ShipmentReceivingPage') },
}
afterEach(() => vi.unstubAllGlobals())

const carriers = (patch: Partial<CarrierListResponse> = {}): CarrierListResponse => ({
  items: [
    {
      kind: 'CARRIER',
      id: 'c1',
      name: '甲物流',
      code: 'JIA',
      status: 'ACTIVE',
      version: 1,
      channelCount: 1,
      channels: [
        {
          kind: 'CHANNEL',
          id: 'ch1',
          carrierId: 'c1',
          carrierName: '甲物流',
          name: '空运特快',
          code: 'AIR',
          volumetricDivisor: 6000,
          splitFactor: 1,
          status: 'ACTIVE',
          version: 1,
          rateCount: 3,
          regions: ['US-West'],
          shipmentCount: 2,
        },
      ],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  canManage: true,
  manageBlockedReason: null,
  ...patch,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/first-mile/carriers': () => ok(carriers()),
  '/first-mile': () => ok(listResponse()),
  '/first-mile/fm1': () => ok(detail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('物流渠道与报价页', () => {
  it('物流商一行，点箭头展开渠道；渠道行显示材积除数、分抛系数与报价条数', async () => {
    mountApp({ url: '/app/first-mile/carriers', pages, handlers: handlers() })
    expect(await screen.findByText('甲物流')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    const channel = (await screen.findByText('空运特快')).closest('[role="row"]') as HTMLElement
    expect(within(channel).getByText('6,000')).toBeInTheDocument()
    expect(within(channel).getByText('US-West')).toBeInTheDocument()
  })

  it('没有维护权限：新增按钮禁用并显示原因', async () => {
    mountApp({
      url: '/app/first-mile/carriers',
      pages,
      handlers: handlers({ '/first-mile/carriers': () => ok(carriers({ canManage: false, manageBlockedReason: '没有“头程物流维护”权限（firstmile.write）' })) }, ['firstmile.read']),
    })
    expect(await screen.findByText('甲物流')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新增物流商/ })).toBeDisabled()
    expect(await screen.findByText('你可以查看物流渠道与报价，但不能修改')).toBeInTheDocument()
  })

  it('没有物流商：说明怎么新增', async () => {
    mountApp({ url: '/app/first-mile/carriers', pages, handlers: handlers({ '/first-mile/carriers': () => ok(carriers({ items: [], total: 0 })) }) })
    expect(await screen.findByText(/还没有物流商/)).toBeInTheDocument()
  })

  it('新增物流商：名称与代码必填；提交带上去首尾空格的名称', async () => {
    let body: Record<string, unknown> | null = null
    mountApp({
      url: '/app/first-mile/carriers',
      pages,
      handlers: handlers({
        '/first-mile/carriers': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body)) as Record<string, unknown>
            return { status: 201, body: { success: true, data: { id: 'c2', version: 1 } } }
          }
          return ok(carriers())
        },
      }),
    })
    await screen.findByText('甲物流')
    await userEvent.click(screen.getByRole('button', { name: /新增物流商/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    expect(body).toBeNull()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^保\s?存$/ })).toBeEnabled())
    await userEvent.type(within(dialog).getByLabelText('物流商名称'), '  乙物流 ')
    await userEvent.type(within(dialog).getByLabelText('物流商代码'), 'yi')
    await userEvent.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toEqual({ name: '乙物流', code: 'yi' })
  })
})

describe('头程详情：缺失字段与预估对比', () => {
  it('缺重量或体积：页面顶部提示缺哪些 SKU，并给出一次补录入口', async () => {
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers() })
    expect(await screen.findByText(/有 1 个 SKU 缺重量或体积/)).toBeInTheDocument()
    expect(screen.getByText(/SKU-B（缺重量、体积）/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /一次补录/ })).toBeEnabled()
  })

  it('补录：建议值预填，只提交填了的格子，带运单版本号', async () => {
    let body: Record<string, unknown> | null = null
    mountApp({
      url: '/app/first-mile/fm1',
      pages,
      handlers: handlers({
        '/first-mile/fm1/items/fill': (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return ok({ id: 'fm1', version: 5, filled: 1 })
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: /一次补录/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('SKU-B 重量')).toHaveValue('12')
    await userEvent.click(within(dialog).getByRole('button', { name: /^补\s?录$/ }))
    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toEqual({ version: 4, rows: [{ sku: 'SKU-B', weightKg: 12 }] })
  })

  it('没有缺失字段：不显示提示', async () => {
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(detail({ missingFields: [] })) }) })
    await screen.findByText('WB-1001')
    expect(screen.queryByText(/缺重量或体积/)).not.toBeInTheDocument()
  })

  it('预估、实际、差异三行并列；差异超过阈值标异常；没有预估写“尚无预估”', async () => {
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(detail({}, { estimatedCost: '700', actualCost: '980.5' })) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '费用与分摊' }))
    expect(await screen.findByText('预估头程费用')).toBeInTheDocument()
    expect(screen.getByText(/异常（超过 20%）/)).toBeInTheDocument()
  })

  it('没有预估时不拿 0 做对比', async () => {
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(detail({}, { estimatedCost: null })) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '费用与分摊' }))
    expect(await screen.findByText('尚无预估，无法对比')).toBeInTheDocument()
  })

  it('没有成本权限：预估对比整块不显示', async () => {
    mountApp({
      url: '/app/first-mile/fm1',
      pages,
      handlers: handlers({ '/first-mile/fm1': () => ok(detail({}, { estimatedCost: undefined, actualCost: undefined })) }, ['firstmile.read']),
    })
    await screen.findByText('WB-1001')
    expect(screen.queryByText('预估与实际')).not.toBeInTheDocument()
  })
})

describe('货件三种差异表', () => {
  it('列出申报、已发、签收与三种差异；没有数据写“尚无记录”', async () => {
    const shipmentGap = {
      id: 'sh1',
      shipmentId: 'FBA-GAP-1',
      shipmentConfirmationId: null,
      planId: 'p1',
      planName: '10 月补货',
      destinationFc: 'ONT8',
      status: 'CLOSED',
      closed: true,
      declared: 100,
      shipped: 100,
      received: 90,
      declaredVsShipped: 0,
      shippedVsReceived: 10,
      declaredVsReceived: 10,
    }
    mountApp({
      url: '/app/warehouse',
      pages,
      handlers: handlers({
        '/inbound/shipments/discrepancies': () =>
          ok({
            items: [shipmentGap, { ...shipmentGap, id: 'sh2', shipmentId: 'FBA-GAP-2', received: null, shippedVsReceived: null, declaredVsReceived: null }],
            total: 2,
            page: 1,
            pageSize: 50,
            truncated: false,
            note: '三种差异两两相减',
          }),
        '/inbound/shipments': () => ok(shipmentList([])),
        '/inbound/receiving/stats': () => ok(statsResponse()),
      }),
    })
    expect(await screen.findByText('FBA-GAP-1')).toBeInTheDocument()
    expect(screen.getAllByText('少收 10').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('尚无记录').length).toBeGreaterThan(0)
    expect(screen.getByText('三种差异两两相减')).toBeInTheDocument()
  })
})
