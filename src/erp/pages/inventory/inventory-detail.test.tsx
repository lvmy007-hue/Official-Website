import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { calc } from '../replenishment/replenishment-fixtures.test-helper'
import { freshness, ok, row } from './inventory-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 库存详情页（P2a-06）：身份区、规则建议、10 个页签（每个页签只在打开时取数）。

const pages: LivePages = { InventoryDetailPage: { load: () => import('./InventoryDetailPage') } }
afterEach(() => vi.unstubAllGlobals())

const assessed = row({
  assessment: {
    state: 'OK',
    reason: null,
    risk: 'MEDIUM',
    daysOfCover: 30.4,
    noDemand: false,
    stockoutDate: '2026-11-21',
    fastestLeadDays: 45,
    fastestReplenishDate: null,
    targetDays: 60,
    policyVersion: 2,
  },
})

const detail = {
  row: assessed,
  policy: null,
  suggestions: [{ id: 'sg1', rule: '覆盖天数低于提前期加安全库存', evidence: '可售天数 30.4，规则要求 59', impact: '预计 11-21 断货', risk: '补货来不及', action: 'REPLENISH' as const }],
  freshness,
}

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['inventory.read', 'replenishment.read'] }),
  '/inventory/inv1': () => ok(detail),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }))

describe('库存详情页', () => {
  it('身份区、规则建议与 10 个页签', async () => {
    mountApp({ url: '/app/inventory/inv1', pages, handlers: handlers() })
    expect(await screen.findByText('示例商品')).toBeInTheDocument()
    expect(screen.getByText('覆盖天数低于提前期加安全库存')).toBeInTheDocument()
    expect(screen.getByText('安排补货')).toBeInTheDocument()
    expect(screen.getByText('30.4 天')).toBeInTheDocument()
    for (const label of ['库存结构趋势', '历史快照', '库存台账', '入仓与在途', '上游仓储', '补货建议', '库龄与费用', '处置建议', '预测', '变更与审计']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }
  })

  it('有对应的商品行：身份区给出到 ASIN 360 的链接；没有就不显示', async () => {
    const both: LivePages = { ...pages, Asin360Page: { load: () => import('../products/Asin360Page') } }
    mountApp({ url: '/app/inventory/inv1', pages: both, handlers: handlers({ '/inventory/inv1': () => ok({ ...detail, productId: 'p1' }) }) })
    const link = await screen.findByRole('link', { name: '商品全景（ASIN 360）' })
    expect(link).toHaveAttribute('href', expect.stringContaining('/app/products/p1'))
  })

  it('没有对应的商品行：不显示 ASIN 360 链接', async () => {
    const both: LivePages = { ...pages, Asin360Page: { load: () => import('../products/Asin360Page') } }
    mountApp({ url: '/app/inventory/inv1', pages: both, handlers: handlers({ '/inventory/inv1': () => ok({ ...detail, productId: null }) }) })
    await screen.findByText('示例商品')
    expect(screen.queryByText('商品全景（ASIN 360）')).not.toBeInTheDocument()
  })

  it('库存记录不存在：显示服务端的错误，不渲染空详情', async () => {
    mountApp({ url: '/app/inventory/nope', pages, handlers: handlers({ '/inventory/nope': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '库存记录不存在' } } }) }) })
    expect(await screen.findByText(/库存记录不存在/)).toBeInTheDocument()
  })

  it('库存结构趋势：默认页签，只取这一个页签的数，图下写明来源规则', async () => {
    const app = mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/structure': () =>
          ok({
            state: 'OK',
            note: null,
            from: '2026-09-22',
            to: '2026-10-22',
            points: [{ date: '2026-10-21', source: 'API', sellable: 100, inbound: 10, reserved: 2, unsellable: 1, researching: 0 }],
          }),
      }),
    })
    await screen.findByText('示例商品')
    expect(await screen.findByRole('img', { name: '库存结构趋势折线图' })).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/inventory/inv1/ledger')).toBe(false)
    expect(screen.getByText(/不跨来源相加/)).toBeInTheDocument()
  })

  it('库存结构趋势：趋势图下是统一事件带（对象类型 INVENTORY），下面是和图联动的每日明细表（PagedGrid）', async () => {
    const app = mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/structure': () =>
          ok({
            state: 'OK',
            note: null,
            from: '2026-10-20',
            to: '2026-10-22',
            points: [
              { date: '2026-10-21', source: 'API', sellable: 100, inbound: 10, reserved: 2, unsellable: 1, researching: 0 },
              { date: '2026-10-22', source: 'MYI_ALL', sellable: 90, inbound: null, reserved: 2, unsellable: 1, researching: 0 },
            ],
          }),
        '/events': () => ok({ items: [], truncated: false, truncatedTypes: [], unavailableTypes: ['AUDIT'] }),
      }),
    })
    const table = await screen.findByTestId('structure-table')
    expect(await within(table).findByText('2026-10-22')).toBeInTheDocument()
    expect(within(table).getByText('库存报告（全部）')).toBeInTheDocument()
    expect(within(table).getByText('共 2 条')).toBeInTheDocument()
    expect(within(table).getByText(/在趋势图上点某一天/)).toBeInTheDocument()
    const call = app.calls.find(item => item.path === '/events')!
    expect(new URLSearchParams(call.search).get('objectType')).toBe('INVENTORY')
    expect(new URLSearchParams(call.search).get('objectId')).toBe('inv1')
    expect(await screen.findByTestId('event-band')).toHaveTextContent('没有查看权限，未显示：系统操作')
  })

  it('库存台账：关联单据对应页面未上线时只显示编号，不给死链接；下一页带游标', async () => {
    const app = mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/ledger': () =>
          ok({
            state: 'OK',
            note: null,
            items: [
              {
                id: 'l1',
                eventDate: '2026-10-20',
                eventType: 'Shipments',
                reasonCode: '—',
                disposition: 'SELLABLE',
                fulfillmentCenter: 'ONT8',
                quantity: -2,
                referenceId: '111-222',
                referenceKind: 'ORDER',
              },
            ],
            pageInfo: { pageSize: 50, nextCursor: 'c2', hasMore: true, approxTotal: null },
          }),
      }),
    })
    await openTab('库存台账')
    const line = (await screen.findByText('111-222')).closest<HTMLElement>('tr, [role=row]')!
    expect(within(line).queryByRole('link')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /下\s?一\s?页/ }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/inventory/inv1/ledger' && call.search.includes('cursor=c2'))).toBe(true))
  })

  it('入仓与在途：预计到货时间写明尚未接入与负责的工作包', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/inbound': () =>
          ok({
            counts: { working: 5, shipped: 30, receiving: 0, total: 35, counted: 30 },
            shipments: [
              {
                planId: 'p1',
                planName: '十月补货',
                planStatus: 'SUBMITTED',
                planQuantity: 30,
                shipmentId: null,
                shipmentStatus: null,
                destinationFc: null,
                unitsExpected: null,
                unitsReceived: null,
                receiveProgress: null,
              },
            ],
            eta: { state: 'NOT_CONNECTED', note: '预计到货时间需要货件跟踪数据', workPackage: 'P2a-11' },
          }),
      }),
    })
    await openTab('入仓与在途')
    expect(await screen.findByText('十月补货')).toBeInTheDocument()
    expect(screen.getByText('尚未生成货件')).toBeInTheDocument()
    expect(screen.getByText(/P2a-11/)).toBeInTheDocument()
  })

  it('上游仓储：店铺没有开通时只显示说明，不显示数字', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/awd': () => ok({ state: 'NOT_APPLICABLE', note: '这个店铺没有开通亚马逊仓储分销', snapshotDate: null, stock: null, inboundShipments: [], freshness: null }),
      }),
    })
    await openTab('上游仓储')
    expect(await screen.findByText('这个店铺没有开通亚马逊仓储分销')).toBeInTheDocument()
    expect(screen.queryByTestId('awd-stock')).not.toBeInTheDocument()
  })

  it('上游仓储：有快照时显示库存，缺的数字写“尚无记录”，并列出未完结的入库货件', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/awd': () =>
          ok({
            state: 'OK',
            note: null,
            snapshotDate: '2026-10-22',
            stock: { onhandQty: 120, availableQty: 100, reservedForReplenishment: null, inboundToAwdQty: 30, outboundToFbaInTransit: null, expiryDate: null, expirations: [] },
            inboundShipments: [{ id: 's1', shipmentId: 'SHIP-1', orderRowId: null, status: 'IN_TRANSIT', statusLabel: '运输中', expectedQty: 240, receivedQty: null, unit: 'PRODUCT_UNITS' }],
            freshness: null,
          }),
      }),
    })
    await openTab('上游仓储')
    const stock = await screen.findByTestId('awd-stock')
    expect(stock).toHaveTextContent('可用100')
    expect(stock).toHaveTextContent('预留给补货尚无记录')
    expect(screen.getByText(/SHIP-1/)).toBeInTheDocument()
    expect(screen.getByText(/已接收 尚无记录/)).toBeInTheDocument()
  })

  it('上游仓储：没有 awd.read 权限时显示无权限而不是空白', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({ '/inventory/inv1/awd': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) }),
    })
    await openTab('上游仓储')
    expect((await screen.findAllByText(/awd\.read|FORBIDDEN|无权/)).length).toBeGreaterThan(0)
  })

  it('补货建议：我方建议来自补货计算链（可展开公式），与亚马逊建议并列，列出差异原因', async () => {
    const amazon = {
      state: 'OK',
      note: null,
      recommendedQty: 100,
      recommendedShipDate: '2026-10-28',
      alertReason: 'Low stock',
      recommendedAction: 'Create shipment',
      source: 'RESTOCK_REPORT',
      snapshotDate: '2026-10-21',
    }
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({ '/inventory/inv1/replenishment': () => ok({ ours: calc({ recommendedQty: 80 }), amazon, diffQty: -20, diffReasons: ['亚马逊按其自己的预测日销计算，口径不同'] }) }),
    })
    await openTab('补货建议')
    const card = await screen.findByTestId('ours-card')
    expect(within(card).getByText('80')).toBeInTheDocument()
    expect(within(card).getByText(/下单日 2026-10-22，到仓日 2026-12-01，采购量 400 件/)).toBeInTheDocument()
    expect(screen.getByTestId('calc-steps')).toBeInTheDocument()
    expect(screen.getByText(/第 1 步 需求预测/)).toBeInTheDocument()
    expect(within(screen.getByTestId('amazon-card')).getByText('100')).toBeInTheDocument()
    expect(screen.getByText(/少/)).toBeInTheDocument()
    expect(screen.getByText('亚马逊按其自己的预测日销计算，口径不同')).toBeInTheDocument()
  })

  it('补货建议：当前策略版本不含服务水平与提前期拆分时，写明需要补齐，不显示任何建议量', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/replenishment': () =>
          ok({
            ours: calc({ state: 'POLICY_INCOMPLETE', reason: '当前策略版本没有服务水平或提前期拆分：请保存新版本补齐', recommendedQty: 0, purchaseQty: 0, steps: [], shipments: [] }),
            amazon: { state: 'NO_DATA', note: '尚无记录', recommendedQty: null, recommendedShipDate: null, alertReason: null, recommendedAction: null, source: null, snapshotDate: null },
            diffQty: null,
            diffReasons: [],
          }),
      }),
    })
    await openTab('补货建议')
    const card = await screen.findByTestId('ours-card')
    expect(within(card).getByText('补货参数尚未配置（服务水平、提前期拆分）')).toBeInTheDocument()
    expect(within(card).getByText(/请保存新版本补齐/)).toBeInTheDocument()
    expect(screen.queryByTestId('calc-steps')).not.toBeInTheDocument()
  })

  it('库龄与费用：跨档时间线写出窗口与估算方式，无法估算时写原因', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/age-fees': () =>
          ok({
            state: 'OK',
            note: null,
            snapshotDate: '2026-10-20',
            granularity: 'FINE',
            buckets: [{ key: 'd0_90', label: '0-90 天', qty: 80 }],
            surchargeEstimate: 12.5,
            bands: [{ label: '181-270 天', amount: 12.5 }],
            longTerm6Month: null,
            longTerm12Month: null,
            crossings: [
              { boundaryDays: 181, toLabel: '181-270 天', qty: 20, earliestDate: '2026-10-25', latestDate: '2026-11-10', likelyCrossed: false, feeTier: true, estimatedIncrease: 4.2, note: null },
              {
                boundaryDays: 271,
                toLabel: '271-365 天',
                qty: 5,
                earliestDate: '2026-12-01',
                latestDate: '2026-12-31',
                likelyCrossed: false,
                feeTier: true,
                estimatedIncrease: null,
                note: '目标档当前没有库存，无法推算单价',
              },
            ],
          }),
      }),
    })
    await openTab('库龄与费用')
    expect(await screen.findByText(/2026-10-25 至 2026-11-10/)).toBeInTheDocument()
    expect(screen.getByText(/目标档当前没有库存，无法推算单价/)).toBeInTheDocument()
    expect(screen.getAllByText('尚无记录').length).toBeGreaterThan(0)
  })

  it('处置建议：我方与亚马逊并列；亚马逊没有记录时写“尚无记录”', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/disposition': () =>
          ok({
            amazon: { state: 'NO_DATA', action: null, salePrice: null, saleDays: null, removalQty: null, removalReason: null, savings: null, note: '没有库存规划报告' },
            ours: { state: 'OK', action: 'REDUCE_EXCESS', excessQty: 40, estimatedSavings: 18, formula: '40 ×（0.4 + 0.05）', note: '不含移除费与降价让利' },
          }),
      }),
    })
    await openTab('处置建议')
    expect(await screen.findByText('降价或移除冗余库存')).toBeInTheDocument()
    expect(within(screen.getByTestId('disposition-amazon')).getByText('没有库存规划报告')).toBeInTheDocument()
  })

  it('预测：写明方法、剔除的断货日与未纳入促销', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/inventory/inv1/forecast': () =>
          ok({
            state: 'OK',
            note: null,
            method: 'inventory-demand@1',
            source: 'ORDERS',
            history: [{ date: '2026-10-21', units: 3, stockout: true }],
            forecast: [{ date: '2026-10-23', low: 2, mid: 3, high: 4 }],
            exclusions: { stockoutDays: 2, stockoutNote: '断货日不计入日均', promotionNote: '没有促销日历，未剔除促销', seasonality: null },
          }),
      }),
    })
    await openTab('预测')
    expect(await screen.findByRole('img', { name: '日销历史与预测折线图' })).toBeInTheDocument()
    expect(screen.getByText(/已剔除近 30 天内 2 个断货日/)).toBeInTheDocument()
    expect(screen.getByText(/没有促销日历，未剔除促销/)).toBeInTheDocument()
  })

  it('变更与审计：显示库存规则的版本变更，并带评论区', async () => {
    mountApp({
      url: '/app/inventory/inv1',
      pages,
      handlers: handlers({
        '/events': () => ok({ items: [{ id: 'e1', kind: 'manual', occurredAt: '2026-10-01T00:00:00Z', title: '库存规则保存为第 2 版', actor: '林然', actorKind: 'USER' }], truncated: false }),
      }),
    })
    await openTab('变更与审计')
    expect(await screen.findByText('库存规则保存为第 2 版')).toBeInTheDocument()
    expect(screen.getByText(/人关注/)).toBeInTheDocument()
  })
})
