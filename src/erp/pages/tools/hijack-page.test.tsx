import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeSearchParser, type HijackListResponse, type HijackRow, type HijackWhitelistResponse, type StackingResponse, type StackingRowView } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, promotionList } from '../promotions/promotions-fixtures.test-helper'
import { listResponse, pricingHandlers } from '../pricing/pricing-fixtures.test-helper'

// 跟卖监控、促销叠加与定价情形矩阵的页面（P6-17）：
// 跟卖：延迟说明常驻、表格行内容（卖家只有引用不是编号原文）、汇总、白名单页签的新增与权限；
// 促销叠加：快捷筛选卡带条数、点卡片按 flag 重新取数；
// 矩阵：规则抽屉里打开矩阵出现五种情形，没有会调价的格子时提示原因、不提交。

const pages: LivePages = {
  HijackMonitorPage: { load: () => import('./HijackMonitorPage'), search: ScopeSearchParser },
  PromotionsPage: { load: () => import('../promotions/PromotionsPage') },
  PricingPage: { load: () => import('../pricing/PricingPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }

const hijackRow = (over: Partial<HijackRow> = {}): HijackRow => ({
  id: 'o1',
  storeId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-HJ-1',
  asin: 'B0HIJACK01',
  title: '玻璃保鲜盒套装',
  sellerKey: '0123456789abcdef',
  sellerRef: '卖家 012345',
  whitelisted: false,
  firstSeenAt: '2026-10-26T01:00:00Z',
  lastSeenAt: '2026-10-27T01:00:00Z',
  goneAt: null,
  status: 'active',
  price: 17.5,
  currency: 'USD',
  isFba: false,
  hasBuybox: true,
  ...over,
})
const hijackList = (over: Partial<HijackListResponse> = {}): HijackListResponse => ({
  state: 'OK',
  note: null,
  items: [hijackRow()],
  pageInfo: { pageSize: 100, nextCursor: null, hasMore: false, approxTotal: 1 },
  summary: { active: 3, gone: 1, whitelisted: 1, activeNotWhitelisted: 2 },
  maxDelayHours: 2,
  delayNote: '数据来自官方竞争摘要，不抓前台页面，最长延迟 2 小时（同步每 2 小时一次）。',
  canManage: true,
  manageBlockedReason: null,
  ...over,
})
const whitelist = (over: Partial<HijackWhitelistResponse> = {}): HijackWhitelistResponse => ({
  items: [{ id: 'w1', sellerKey: 'fedcba9876543210', sellerRef: '卖家 fedcba', sellerHint: 'A1…G7', note: '自己的欧洲店', createdBy: 'u1', createdAt: '2026-10-20T00:00:00Z', activeSkus: 2 }],
  page: 1,
  pageSize: 50,
  total: 1,
  limit: 200,
  canManage: true,
  manageBlockedReason: null,
  ...over,
})
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/tools/hijack': () => ok(hijackList()),
  '/tools/hijack/whitelist': () => ok(whitelist()),
  ...over,
})

describe('跟卖监控页', () => {
  it('写明最长延迟；表格给 SKU、卖家引用、报价、FBA 与购物车；汇总写需要关注的数量', T, async () => {
    mountApp({ url: '/app/tools/hijack', pages, handlers: handlers() })
    expect(await screen.findByText('SKU-HJ-1', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByTestId('hijack-delay')).toHaveTextContent('最长延迟 2 小时')
    expect(screen.getByTestId('hijack-delay')).toHaveTextContent('不抓前台页面')
    expect(screen.getByTestId('hijack-summary')).toHaveTextContent('需要关注 2')
    expect(screen.getByTestId('hijack-summary')).toHaveTextContent('已消失 1')
    const row = screen.getByText('SKU-HJ-1').closest('.ag-row') as HTMLElement
    expect(within(row).getByText('卖家 012345')).toBeInTheDocument()
    expect(within(row).getByText('$17.50')).toBeInTheDocument()
    expect(within(row).getByText('仍在报价')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('0123456789abcdef')
  })

  it('没有记录：写原因，不是空白也不是 0', T, async () => {
    mountApp({
      url: '/app/tools/hijack',
      pages,
      handlers: handlers({
        '/tools/hijack': () => ok(hijackList({ items: [], state: 'NO_DATA', note: '还没有观察到其他报价方', summary: { active: 0, gone: 0, whitelisted: 0, activeNotWhitelisted: 0 } })),
      }),
    })
    expect(await screen.findByText(/还没有观察到其他报价方/, {}, WAIT)).toBeInTheDocument()
  })

  it('白名单页签：列出卖家与现在仍在报价的商品数；新增按大写卖家编号提交', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: '/app/tools/hijack',
      pages,
      handlers: handlers({
        '/tools/hijack/whitelist': (_url, init) => {
          if (init?.method === 'POST') {
            bodies.push(JSON.parse(String(init.body)))
            return ok(whitelist().items[0])
          }
          return ok(whitelist())
        },
      }),
    })
    await screen.findByText('SKU-HJ-1', {}, WAIT)
    fireEvent.click(screen.getByRole('tab', { name: '白名单' }))
    const panel = within(await screen.findByTestId('hijack-whitelist'))
    expect(await panel.findByText('自己的欧洲店', {}, WAIT)).toBeInTheDocument()
    expect(panel.getByText(/1 \/ 200/)).toBeInTheDocument()
    await userEvent.click(panel.getByRole('button', { name: /添加卖家/ }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('卖家编号'), 'a1b2c3d4e5f6g7')
    await userEvent.type(dialog.getByLabelText('备注（可选）'), '自己的欧洲店')
    await userEvent.click(dialog.getByRole('button', { name: /添\s?加/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ sellerId: 'A1B2C3D4E5F6G7', note: '自己的欧洲店' })
  })

  it('没有管理权限：添加与移出都禁用', T, async () => {
    mountApp({ url: '/app/tools/hijack', pages, handlers: handlers({}, ['tools.read']) })
    await screen.findByText('SKU-HJ-1', {}, WAIT)
    fireEvent.click(screen.getByRole('tab', { name: '白名单' }))
    const panel = within(await screen.findByTestId('hijack-whitelist'))
    await panel.findByText('自己的欧洲店', {}, WAIT)
    expect(panel.getByRole('button', { name: /添加卖家/ })).toBeDisabled()
    expect(panel.getByRole('button', { name: /移出白名单/ })).toBeDisabled()
  })
})

const stackRow = (over: Partial<StackingRowView> = {}): StackingRowView => ({
  id: 'st1|B0STACK001',
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0STACK001',
  title: '不锈钢保温杯',
  promotionCount: 2,
  peakCount: 2,
  peakFrom: '2026-11-01T00:00:00Z',
  peakTo: '2026-11-05T00:00:00Z',
  depth: 0.44,
  unknownDepth: 0,
  promotions: [
    { id: 'p1', promotionId: 'PM-1', title: '十月秒杀', type: 'LIGHTNING_DEAL', status: 'RUNNING', startAt: '2026-10-20T00:00:00Z', endAt: '2026-11-05T00:00:00Z', depth: 0.2 },
    { id: 'p2', promotionId: 'PM-2', title: '会员日折扣', type: 'PRICE_DISCOUNT', status: 'UPCOMING', startAt: '2026-11-01T00:00:00Z', endAt: '2026-11-10T00:00:00Z', depth: 0.3 },
  ],
  stacked: true,
  deep: true,
  ...over,
})
const stackingResponse = (over: Partial<StackingResponse> = {}): StackingResponse => ({
  state: 'OK',
  note: null,
  items: [stackRow()],
  pageInfo: { pageSize: 100, nextCursor: null, hasMore: false, approxTotal: 1 },
  summary: { asins: 4, stacked: 2, deep: 1, any: 3, minStack: 2, minDepthPct: 0.3 },
  truncated: false,
  basis: '只算进行中与即将开始的促销。',
  catalogNote: '整个目录范围的促销没有商品清单，无法判断落在哪个 ASIN，不计入叠加。',
  ...over,
})

describe('促销页的叠加情况', () => {
  it('三张快捷筛选卡带条数；表格给叠加个数、折扣深度、叠加时段与各促销', T, async () => {
    mountApp({ url: '/app/promotions', pages, handlers: handlers({ '/promotions': () => ok(promotionList()), '/promotions/stacking': () => ok(stackingResponse()) }) })
    await screen.findByText('十月秒杀', {}, WAIT)
    fireEvent.click(screen.getByRole('tab', { name: '叠加情况' }))
    expect(await screen.findByText('B0STACK001', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByTestId('stacking-card-stacked')).toHaveTextContent('2')
    expect(screen.getByTestId('stacking-card-deep')).toHaveTextContent('1')
    expect(screen.getByTestId('stacking-card-any')).toHaveTextContent('3')
    expect(screen.getByTestId('stacking-card-stacked')).toHaveTextContent('同期叠加 2 个以上促销')
    const row = screen.getByText('B0STACK001').closest('.ag-row') as HTMLElement
    expect(within(row).getByText('44%')).toBeInTheDocument()
    expect(within(row).getByText(/十月秒杀（20%）；会员日折扣（30%）/)).toBeInTheDocument()
    expect(screen.getByText(/整个目录范围的促销没有商品清单/)).toBeInTheDocument()
  })

  it('点“叠加”卡片按 flag=stacked 重新取数，再点取消', T, async () => {
    const urls: string[] = []
    mountApp({
      url: '/app/promotions',
      pages,
      handlers: handlers({
        '/promotions': () => ok(promotionList()),
        '/promotions/stacking': url => (urls.push(String(url)), ok(stackingResponse())),
      }),
    })
    await screen.findByText('十月秒杀', {}, WAIT)
    fireEvent.click(screen.getByRole('tab', { name: '叠加情况' }))
    await screen.findByText('B0STACK001', {}, WAIT)
    fireEvent.click(screen.getByTestId('stacking-card-stacked'))
    await waitFor(() => expect(urls.some(url => url.includes('flag=stacked'))).toBe(true))
    expect(screen.getByTestId('stacking-card-stacked')).toHaveAttribute('aria-pressed', 'true')
    const before = urls.length
    fireEvent.click(screen.getByTestId('stacking-card-stacked'))
    await waitFor(() => expect(urls.length).toBeGreaterThan(before))
    expect(urls[urls.length - 1]).not.toContain('flag=')
  })
})

describe('定价规则的情形矩阵', () => {
  it('打开矩阵出现五种情形；没有会调价的格子时提示原因、不提交', T, async () => {
    const posts: unknown[] = []
    mountApp({
      url: '/app/pricing',
      pages,
      handlers: pricingHandlers(() => listResponse(), {
        '/pricing/rules': (_url, init) => {
          if (init?.method === 'POST') {
            posts.push(init.body)
            return ok({})
          }
          return ok({ items: [], truncated: false })
        },
      }),
    })
    const page = within(await screen.findByTestId('pricing-page'))
    await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15000 })
    fireEvent.click(page.getByRole('tab', { name: '定价规则' }))
    await userEvent.click(await page.findByRole('button', { name: /新建规则/ }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('规则名称'), '情形矩阵')
    await userEvent.click(dialog.getByRole('switch', { name: '按情形矩阵定价' }))
    for (const label of ['失去推荐报价时', '我是最低价时', '对方低于我的最低价时', '对方介于我的最低价和最高价之间', '对方高于我的最高价时']) expect(dialog.getByText(label)).toBeInTheDocument()
    expect(dialog.getByLabelText('基础价')).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /保\s?存/ }))
    expect(await dialog.findByText(/矩阵里没有任何会调价的格子/)).toBeInTheDocument()
    expect(posts).toHaveLength(0)
  })
})
