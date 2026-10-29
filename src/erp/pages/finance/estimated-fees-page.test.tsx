import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ESTIMATED_FEE_NOTES, type CashflowFunnelResponse, type EstimatedFeeRow, type EstimatedFeesResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../promotions/promotions-fixtures.test-helper'
import { cashflow } from './cashflow-fixtures.test-helper'
import { feeBodyOf } from './estimated-fees-parts'

// 预估与自定义费用页（P6-20）：规则表、没有权限不能写、修改带版本号、删除带版本号、表单值转请求体；回款漏斗（回款率、预留金、未接入写法）。

const pages: LivePages = {
  EstimatedFeesPage: { load: () => import('./EstimatedFeesPage') },
  CashflowPage: { load: () => import('./CashflowPage') },
  SettlementDetailPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }

const fee = (over: Partial<EstimatedFeeRow> = {}): EstimatedFeeRow => ({
  id: 'e1',
  itemId: 'i1',
  itemName: '站外推广',
  itemPath: '推广费用 / 站外推广',
  scopeType: 'STORE',
  scopeId: 's1',
  scopeName: '美国主店',
  mode: 'FIXED',
  value: 300,
  currency: 'USD',
  period: 'MONTHLY',
  from: '2026-10-01',
  to: null,
  status: 'ACTIVE',
  note: '站外推广月预算',
  version: 2,
  createdBy: 'u1',
  updatedAt: '2026-10-20T00:00:00Z',
  ...over,
})
const listing = (
  rows: EstimatedFeeRow[] = [
    fee(),
    fee({
      id: 'e2',
      itemName: '服务费',
      itemPath: '其他 / 服务费',
      scopeType: 'SKU',
      scopeId: 'SKU-A',
      scopeName: 'SKU-A',
      mode: 'PERCENT_OF_SALES',
      value: 2.5,
      period: 'DAILY',
      to: '2026-12-31',
      status: 'INACTIVE',
      note: null,
    }),
  ],
): EstimatedFeesResponse & { page: number; pageSize: number } => ({
  rows,
  total: rows.length,
  page: 1,
  pageSize: 50,
  summary: { active: rows.filter(row => row.status === 'ACTIVE').length, inactive: rows.filter(row => row.status === 'INACTIVE').length },
  items: [
    { id: 'i1', name: '站外推广', path: '推广费用 / 站外推广' },
    { id: 'i2', name: '服务费', path: '其他 / 服务费' },
  ],
  stores: [{ id: 's1', name: '美国主店' }],
  notes: [...ESTIMATED_FEE_NOTES],
  canWrite: true,
  writeBlockedReason: null,
})
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/estimated-fees': () => ok(listing()),
  ...over,
})

describe('预估与自定义费用页', () => {
  it('规则表显示费用项、范围、方式与金额、生效区间、状态；写明冲销口径', T, async () => {
    mountApp({ url: '/app/finance/estimated-fees', pages, handlers: handlers() })
    expect(await screen.findByText('推广费用 / 站外推广', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('店铺：美国主店')).toBeInTheDocument()
    expect(screen.getByText('$300.00 / 月')).toBeInTheDocument()
    expect(screen.getByText('2026-10-01 至 长期')).toBeInTheDocument()
    expect(screen.getByText('销售额的 2.5%')).toBeInTheDocument()
    expect(screen.getByText('停用')).toBeInTheDocument()
    expect(await screen.findByTestId('estimated-fees-notes', {}, WAIT)).toHaveTextContent('这一期的预估自动不再计入')
  })

  it('没有规则时写明没有实际账单的费用不会进入利润', T, async () => {
    mountApp({ url: '/app/finance/estimated-fees', pages, handlers: handlers({ '/finance/estimated-fees': () => ok(listing([])) }) })
    expect(await screen.findByText(/没有实际账单的费用不会进入利润/, {}, WAIT)).toBeInTheDocument()
  })

  it('没有 finance.estimatedfee.write 权限时新建、导入、修改、删除都不能点', T, async () => {
    mountApp({ url: '/app/finance/estimated-fees', pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByText('推广费用 / 站外推广', {}, WAIT)
    expect(screen.getByRole('button', { name: /新建规则/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /文件导入/ })).toBeDisabled()
    for (const button of screen.getAllByRole('button', { name: /修\s?改|删\s?除/ })) expect(button).toBeDisabled()
  })

  it('修改：带上规则编号与打开页面时看到的版本号', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: '/app/finance/estimated-fees',
      pages,
      handlers: handlers({
        '/finance/estimated-fees': (_url, init) => {
          if (init?.method === 'PUT') {
            bodies.push(JSON.parse(String(init.body)))
            return ok({ row: fee({ version: 3 }), recomputeNote: '新规则在下一次重算后生效。' })
          }
          return ok(listing())
        },
      }),
    })
    const user = userEvent.setup()
    await screen.findByText('推广费用 / 站外推广', {}, WAIT)
    const edit = (await screen.findAllByRole('button', { name: /修\s?改/ }, WAIT)).find(button => !(button as HTMLButtonElement).disabled) as HTMLElement
    await user.click(edit)
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1), WAIT)
    expect(bodies[0]).toMatchObject({
      id: 'e1',
      version: 2,
      itemId: 'i1',
      scopeType: 'STORE',
      scopeId: 's1',
      mode: 'FIXED',
      value: 300,
      period: 'MONTHLY',
      from: '2026-10-01',
      to: null,
      status: 'ACTIVE',
      note: '站外推广月预算',
    })
  })

  it('删除：id 与版本号走查询参数', T, async () => {
    const calls: string[] = []
    mountApp({
      url: '/app/finance/estimated-fees',
      pages,
      handlers: handlers({
        '/finance/estimated-fees': (url, init) => {
          if (init?.method === 'DELETE') {
            calls.push(url.search)
            return ok({ id: 'e1', recomputeNote: '已删除' })
          }
          return ok(listing())
        },
      }),
    })
    const user = userEvent.setup()
    await screen.findByText('推广费用 / 站外推广', {}, WAIT)
    const remove = (await screen.findAllByRole('button', { name: /删\s?除/ }, WAIT)).find(button => !(button as HTMLButtonElement).disabled) as HTMLElement
    await user.click(remove)
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.click(within(dialog).getByRole('button', { name: /^删\s?除$/ }))
    await waitFor(() => expect(calls).toEqual(['?id=e1&version=2']), WAIT)
  })
})

describe('表单值转请求体', () => {
  const base = { itemId: 'i1', scopeType: 'SKU', scopeId: ' SKU-A ', mode: 'FIXED', value: 10, period: 'MONTHLY', from: ' 2026-10-01 ', to: '', status: 'ACTIVE', note: '' }
  it('去掉首尾空格，空截止日与空备注是 null', () => {
    expect(feeBodyOf(base)).toEqual({ itemId: 'i1', scopeType: 'SKU', scopeId: 'SKU-A', mode: 'FIXED', value: 10, period: 'MONTHLY', from: '2026-10-01', to: null, status: 'ACTIVE', note: null })
  })
  it('比例规则的周期固定按日', () => {
    expect(feeBodyOf({ ...base, mode: 'PERCENT_OF_SALES', value: 2.5, period: 'MONTHLY' })).toMatchObject({ mode: 'PERCENT_OF_SALES', period: 'DAILY', value: 2.5 })
  })
})

const funnel = (over: Partial<CashflowFunnelResponse> = {}): CashflowFunnelResponse => ({
  state: 'OK',
  note: null,
  asOf: '2026-10-20',
  from: '2026-07-23',
  to: '2026-10-20',
  windowDays: 90,
  currency: 'USD',
  currencies: ['USD'],
  stages: [
    { key: 'POSTED', label: '已入账交易净额', note: '入账合计', amount: 800, count: 2 },
    { key: 'RELEASED', label: '其中已释放', note: '已释放', amount: 500, count: 1 },
    { key: 'DEFERRED', label: '其中递延中', note: '递延', amount: 300, count: 1 },
    { key: 'ANNOUNCED', label: '已公布打款（结算单）', note: '已公布', amount: 1000, count: 2 },
    { key: 'PAID', label: '其中已到账（打款日已过）', note: '已到账', amount: 800, count: 1 },
    { key: 'UPCOMING', label: '应收未到账（打款日未到）', note: '应收', amount: 200, count: 1 },
  ],
  payoutRate: { value: 0.8, paid: 800, announced: 1000, note: '已到账 ÷ 已公布' },
  reserve: { state: 'OK', held: 100, returned: 30, unreturned: 70, count: 2, note: '未退还 = 扣留 − 返还' },
  assumptions: ['漏斗各级是同一个最近 90 天窗口里的规模对比。'],
  freshness: cashflow().freshness,
  ...over,
})

describe('回款漏斗（回款与现金流页）', () => {
  const open = (body: CashflowFunnelResponse) =>
    mountApp({ url: '/app/finance/cashflow', pages, handlers: handlers({ '/finance/cashflow': () => ok(cashflow()), '/finance/cashflow/funnel': () => ok(body) }) })

  it('显示回款率、各环节金额与未退还预留金', T, async () => {
    open(funnel())
    const section = await screen.findByTestId('cashflow-funnel', {}, WAIT)
    expect(await within(section).findByTestId('funnel-rate', {}, WAIT)).toHaveTextContent('80.0%')
    expect(within(section).getByText('应收未到账（打款日未到）')).toBeInTheDocument()
    expect(within(section).getByText('$200.00')).toBeInTheDocument()
    expect(within(section).getByTestId('funnel-reserve')).toHaveTextContent('$70.00')
  })

  it('没有来源的环节写“尚未接入”，预留金没有记录写“无预留金交易”，都不是 0', T, async () => {
    open(
      funnel({
        stages: funnel().stages.map(stage => (stage.key === 'POSTED' ? { ...stage, amount: null, count: 0 } : stage)),
        payoutRate: { value: null, paid: null, announced: null, note: '窗口内没有已公布打款额的结算单，不给回款率' },
        reserve: { state: 'NONE', held: null, returned: null, unreturned: null, count: 0, note: '最近 180 天没有预留金交易' },
      }),
    )
    const section = await screen.findByTestId('cashflow-funnel', {}, WAIT)
    expect(await within(section).findByText('尚未接入', {}, WAIT)).toBeInTheDocument()
    expect(within(section).getByTestId('funnel-rate')).toHaveTextContent('暂无')
    expect(within(section).getByTestId('funnel-reserve')).toHaveTextContent('无预留金交易')
  })
})
