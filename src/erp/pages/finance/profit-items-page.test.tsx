import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProfitItemRow, ProfitItemsResponse, ProfitUnmappedResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../promotions/promotions-fixtures.test-helper'

// 利润项目字典页（P6-18）：项目树与映射用表格展示；改动先暂存，保存时带上打开页面时的版本；没有权限时不能改。

const pages: LivePages = { ProfitItemsPage: { load: () => import('./ProfitItemsPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }

const item = (over: Partial<ProfitItemRow>): ProfitItemRow => ({
  id: 'i1',
  parentId: null,
  level: 1,
  name: '收入',
  group: 'REVENUE',
  groupLabel: '收入',
  sign: 1,
  isSystem: true,
  systemKey: 'G_REVENUE',
  sort: 10,
  txCount30d: 0,
  mappedTypes: 0,
  acceptsMapping: true,
  ...over,
})
const dictionary = (over: Partial<ProfitItemsResponse> = {}): ProfitItemsResponse => ({
  version: 3,
  items: [item({}), item({ id: 'i2', parentId: 'i1', level: 2, name: '销售收入', systemKey: 'REVENUE', mappedTypes: 1, txCount30d: 12 })],
  mappings: [{ transactionType: 'NON_FEE/Principal', label: '非费用（销售收入、税、运费收入等） · Principal', itemId: 'i2', txCount30d: 12 }],
  unmappedCount: 1,
  totalTxCount30d: 15,
  canManage: true,
  manageBlockedReason: null,
  limits: { maxItems: 200, maxDepth: 3, nameMax: 40 },
  seeded: false,
  note: '映射与新项目保存后，利润日表在下一次重算时才按新口径拆分。',
  ...over,
})
const unmapped = (): ProfitUnmappedResponse => ({
  items: [{ transactionType: 'COMMISSION/NewFee', label: '销售佣金 · NewFee', txCount30d: 3, defaultItemId: 'i2', defaultItemName: '销售佣金', lastPostedAt: '2026-10-26T00:00:00Z' }],
  page: 1,
  pageSize: 50,
  total: 1,
  note: '没有映射的交易类型仍按内置口径计入利润。',
})
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/profit-items': () => ok(dictionary()),
  '/finance/profit-items/unmapped': () => ok(unmapped()),
  ...over,
})

describe('利润项目字典页', () => {
  it('显示字典版本、未映射提醒与项目树；写明改动何时生效', T, async () => {
    mountApp({ url: '/app/finance/profit-items', pages, handlers: handlers() })
    expect(await screen.findByText('销售收入', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByTestId('profit-items-summary')).toHaveTextContent('字典版本 3')
    expect(screen.getByTestId('profit-items-summary')).toHaveTextContent('还有 1 个交易类型未映射')
    expect(screen.getByTestId('profit-items-note')).toHaveTextContent('下一次重算')
  })

  it('改名先暂存，保存时带上版本号写入', T, async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/finance/profit-items',
      pages,
      handlers: handlers({
        '/finance/profit-items': (_url, init) => {
          if (init?.method === 'PUT') {
            bodies.push(JSON.parse(String(init.body)))
            return ok({ version: 4, idMap: {}, items: 2, mappings: 1, recomputeNote: '新口径在下一次重算后生效。' })
          }
          return ok(dictionary())
        },
      }),
    })
    const user = userEvent.setup()
    await screen.findByText('销售收入', {}, WAIT)
    // 操作列固定在右侧，在另一块 DOM 里；项目按树顺序排列，第二行是“销售收入”
    const renames = await screen.findAllByRole('button', { name: /改\s?名/ }, WAIT)
    await user.click(renames[1] as HTMLElement)
    const input = await screen.findByLabelText('项目名称')
    await user.clear(input)
    await user.type(input, '商品销售')
    await user.click(screen.getByRole('button', { name: /确\s?定/ }))
    expect(await screen.findByText('有未保存的改动', {}, WAIT)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /保存字典/ }))
    await user.click(await screen.findByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1), WAIT)
    const body = bodies[0] as { version: number; items: Array<{ id: string; name: string }>; mappings: unknown[] }
    expect(body.version).toBe(3)
    expect(body.items.find(entry => entry.id === 'i2')?.name).toBe('商品销售')
    expect(body.mappings).toEqual([{ transactionType: 'NON_FEE/Principal', itemId: 'i2' }])
  })

  it('没有 finance.profititem.manage 权限时，保存与改名都不能点', T, async () => {
    mountApp({ url: '/app/finance/profit-items', pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByText('销售收入', {}, WAIT)
    expect(screen.getByRole('button', { name: /保存字典/ })).toBeDisabled()
  })
})
