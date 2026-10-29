import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 销量统计、跨仓总览、进销存报表（P6-25）：汇总行来自服务端；没有权限的列不出现并说明原因；没有记录的格不显示成 0；数量不平衡标红。

const pages: LivePages = {
  SalesStatPage: { load: () => import('../analytics/SalesStatPage') },
  AllWarehousesPage: { load: () => import('./AllWarehousesPage') },
  InventoryMovementPage: { load: () => import('./InventoryMovementPage') },
}
afterEach(() => vi.unstubAllGlobals())

const ok = (data: unknown) => ({ body: { success: true, data } })
const freshness = { lastSuccessAt: '2026-10-22T01:00:00.000Z', sources: ['库存接口'], qualityIssues: 0 }
const grid = { '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }) }
const auth = (permissions: string[]) => ({ '/auth/me': () => ok({ ...defaultMe, permissions }) })

const salesStat = (over: Record<string, unknown> = {}) => ({
  freshness,
  state: 'OK',
  note: null,
  truncated: false,
  dimension: 'asin',
  metric: 'units',
  granularity: 'DAY',
  buckets: ['2026-10-01', '2026-10-02'],
  weekStart: 'MON',
  inventoryBasis: '可用库存 = 可售',
  rows: [
    {
      id: 'asin:B0A',
      dimension: 'asin',
      title: '无线鼠标',
      subtitle: null,
      imageUrl: null,
      asin: 'B0A',
      sku: null,
      storeName: '美国站',
      values: [5, null],
      total: 5,
      units: 5,
      availableStock: 40,
      turnoverDays: 16,
      gap: null,
    },
  ],
  summary: { values: [5, null], total: 5, availableStock: 40 },
  total: 1,
  page: 1,
  pageSize: 50,
  ...over,
})

const cells = { fbaSellable: 10, fbaReserved: null, fbaUnsellable: null, awdOnhand: null, domesticOnhand: 3, fbaInbound: null, awdInbound: null, firstMileTransit: 7, awdToFba: null }
const warehouses = (over: Record<string, unknown> = {}) => ({
  state: 'OK',
  note: null,
  items: [
    {
      id: 'sku:SKU-A',
      sku: 'SKU-A',
      title: '无线鼠标',
      cells,
      onHand: 13,
      inTransit: 7,
      total: 20,
      unitCost: 2,
      stockValue: 40,
      children: [{ id: 'fba', kind: 'FBA', label: '美国站', cells: { ...cells, domesticOnhand: null, firstMileTransit: null }, total: 10 }],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  summary: { cells, onHand: 13, inTransit: 7, total: 20, stockValue: 40 },
  restrictions: [],
  costRestricted: false,
  truncated: false,
  freshness,
  ...over,
})

const flows = { receipts: 10, shipments: -4, returns: 0, transfers: 0, adjustments: 0, other: 0 }
const movementRow = (over: Record<string, unknown> = {}) => ({
  id: 'SKU-A|2026-10',
  sku: 'SKU-A',
  asin: 'B0A',
  month: '2026-10',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  storeCount: 1,
  openingQty: 0,
  flows,
  endingQty: 6,
  expectedEnding: 6,
  difference: 0,
  balanced: true,
  shippedUnits: 4,
  turnoverDays: 46,
  sellThrough: 1.5,
  values: { opening: 0, flows: {}, ending: 12, difference: 0 },
  unitCost: 2,
  costVersionNo: 1,
  costEffectiveFrom: '2026-01-01',
  valueNote: null,
  ...over,
})
const movement = (items: unknown[], over: Record<string, unknown> = {}) => ({
  state: 'OK',
  note: null,
  items,
  total: items.length,
  page: 1,
  pageSize: 50,
  from: '2026-10-01',
  to: '2026-10-31',
  totals: { openingQty: 0, flows, endingQty: 6, difference: 0, openingValue: 0, endingValue: 12 },
  unbalancedCount: 0,
  costRestricted: false,
  truncated: false,
  freshness,
  ...over,
})

const run = (url: string, handlers: Record<string, Handler>) => mountApp({ url, pages, handlers })

describe('销量统计', () => {
  const handlers = (over: Record<string, Handler> = {}) => ({ ...auth(['analytics.read']), ...grid, '/analytics/sales-stat': () => ok(salesStat()), ...over })

  it('显示商品行、日期列与服务端合计', async () => {
    const app = run('/app/analytics/sales-stat', handlers())
    expect(await screen.findByText('无线鼠标', {}, { timeout: 15000 })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelectorAll('.ag-row-pinned').length).toBeGreaterThan(0))
    expect(app.calls.filter(call => call.path === '/analytics/sales-stat').length).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('SKU 维度下多 SKU 共用的 ASIN 写明原因', async () => {
    run('/app/analytics/sales-stat', handlers({ '/analytics/sales-stat': () => ok(salesStat({ note: '有 2 个 ASIN 在店铺下有多个 SKU，不含它们的销量' })) }))
    expect(await screen.findByTestId('ss-gap-note', {}, { timeout: 15000 })).toHaveTextContent('不含它们的销量')
  }, 30000)

  it('数据被截断时提示缩小范围', async () => {
    run('/app/analytics/sales-stat', handlers({ '/analytics/sales-stat': () => ok(salesStat({ truncated: true })) }))
    expect(await screen.findByText('范围内销售记录过多，只统计了前面的部分', {}, { timeout: 15000 })).toBeInTheDocument()
  }, 30000)
})

describe('跨仓总览', () => {
  const handlers = (over: Record<string, Handler> = {}) => ({ ...auth(['inventory.read']), ...grid, '/inventory/all-warehouses': () => ok(warehouses()), ...over })

  it('显示 SKU 行与服务端合计', async () => {
    const app = run('/app/inventory/all-warehouses', handlers())
    expect(await screen.findByText('SKU-A', {}, { timeout: 15000 })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelectorAll('.ag-row-pinned').length).toBeGreaterThan(0))
    expect(app.calls.some(call => call.path === '/inventory/all-warehouses')).toBe(true)
  }, 30000)

  it('没有仓库权限的列不出现，并说明原因', async () => {
    const restrictions = [{ metrics: ['domesticOnhand', 'firstMileTransit'], reason: '没有仓库读取权限，国内仓与头程在途没有显示' }]
    run('/app/inventory/all-warehouses', handlers({ '/inventory/all-warehouses': () => ok(warehouses({ restrictions })) }))
    expect(await screen.findByTestId('aw-restrictions', {}, { timeout: 15000 })).toHaveTextContent('没有仓库读取权限')
    expect(screen.queryByText('国内仓在库')).toBeNull()
  }, 30000)

  it('没有成本字段权限时不显示成本与货值', async () => {
    run('/app/inventory/all-warehouses', handlers({ '/inventory/all-warehouses': () => ok(warehouses({ costRestricted: true })) }))
    expect(await screen.findByTestId('aw-cost-restricted', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.queryByText('货值')).toBeNull()
  }, 30000)
})

describe('进销存报表', () => {
  const handlers = (items: unknown[], over: Record<string, unknown> = {}): Record<string, Handler> => ({
    ...auth(['inventory.read']),
    ...grid,
    '/inventory/movement': () => ok(movement(items, over)),
  })

  it('显示月份行与服务端合计', async () => {
    const app = run('/app/inventory/movement', handlers([movementRow()]))
    expect(await screen.findByText('2026-10', {}, { timeout: 15000 })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelectorAll('.ag-row-pinned').length).toBeGreaterThan(0))
    expect(app.calls.some(call => call.path === '/inventory/movement')).toBe(true)
  }, 30000)

  it('数量不平衡的行标红并显示差额，页面顶部给出行数', async () => {
    const bad = movementRow({ difference: 2, balanced: false, expectedEnding: 4 })
    run('/app/inventory/movement', handlers([bad], { unbalancedCount: 1 }))
    expect(await screen.findByTestId('mv-unbalanced', {}, { timeout: 15000 })).toHaveTextContent('1 行数量不平衡')
    expect(await screen.findByText('+2（期末应为 4）')).toBeInTheDocument()
  }, 30000)

  it('没有成本字段权限时不显示货值列', async () => {
    run('/app/inventory/movement', handlers([movementRow({ values: null })], { costRestricted: true }))
    expect(await screen.findByTestId('mv-cost-restricted', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.queryByText('期末货值')).toBeNull()
  }, 30000)
})
