import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DEFAULT_PROFIT_FORMULA,
  FORMULA_KEYS,
  BRIDGE_DEFS,
  describeFormula,
  formulaTags,
  type BusinessRulesResponse,
  type MetricVersionList,
  type MetricVersionView,
  type ProfitFormulaResponse,
} from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../promotions/promotions-fixtures.test-helper'

// 利润公式页与业务口径页（P6-31）：当前口径文字、勾选后提交带最新版本号、待审批提示与审批动作、没有权限不能改。

const pages: LivePages = {
  ProfitFormulaPage: { load: () => import('../finance/ProfitFormulaPage') },
  BusinessRulesPage: { load: () => import('./BusinessRulesPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }

const version = (over: Partial<MetricVersionView> = {}): MetricVersionView => ({
  id: 'mv1',
  kind: 'PROFIT_FORMULA',
  kindLabel: '利润公式',
  versionNo: 2,
  status: 'PENDING_APPROVAL',
  statusLabel: '待审批',
  effectiveFrom: null,
  summary: '毛利润新增：站外推广',
  reason: '把推广算进毛利',
  createdBy: 'u9',
  createdByName: '小王',
  createdAt: '2026-10-20T08:00:00Z',
  approvedBy: null,
  approvedByName: null,
  version: 1,
  withdrawn: false,
  mine: false,
  config: {},
  ...over,
})
const formula = (over: Partial<ProfitFormulaResponse> = {}): ProfitFormulaResponse => ({
  current: {
    kind: 'PROFIT_FORMULA',
    versionNo: 0,
    source: 'DEFAULT',
    config: DEFAULT_PROFIT_FORMULA,
    tags: formulaTags(DEFAULT_PROFIT_FORMULA),
    texts: describeFormula(DEFAULT_PROFIT_FORMULA),
    effectiveFrom: null,
  },
  pending: null,
  rows: FORMULA_KEYS.map(key => ({
    key,
    label: BRIDGE_DEFS[key].label,
    direction: BRIDGE_DEFS[key].direction,
    inGross: DEFAULT_PROFIT_FORMULA.gross.includes(key),
    inDenominator: DEFAULT_PROFIT_FORMULA.denominator.includes(key),
  })),
  latestVersionNo: 1,
  history: [],
  canWrite: true,
  canApprove: true,
  writeBlockedReason: null,
  note: '净利润与利润率不受这里影响。',
  ...over,
})
const history = (items: MetricVersionView[] = []): MetricVersionList => ({ items, page: 1, pageSize: 50, total: items.length })
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/profit-formula': () => ok(formula()),
  '/metric-versions': () => ok(history()),
  ...over,
})

describe('利润公式页', () => {
  it('显示当前口径的公式文字，没有历史时写明用系统默认', T, async () => {
    mountApp({ url: '/app/finance/profit-formula', pages, handlers: handlers() })
    const current = await screen.findByTestId('formula-current', {}, WAIT)
    expect(current).toHaveTextContent('系统默认')
    expect(current).toHaveTextContent(describeFormula(DEFAULT_PROFIT_FORMULA).gross)
    expect(await screen.findByText(/当前使用系统默认口径/, {}, WAIT)).toBeInTheDocument()
  })

  it('有待审批的修改时显示提示，别人提交的可以通过，且勾选框不能改', T, async () => {
    mountApp({ url: '/app/finance/profit-formula', pages, handlers: handlers({ '/finance/profit-formula': () => ok(formula({ pending: version() })) }) })
    const alert = await screen.findByTestId('metric-pending', {}, WAIT)
    expect(alert).toHaveTextContent('第 2 版待审批')
    expect(within(alert).getByRole('button', { name: /通\s?过/ })).toBeEnabled()
    for (const box of await screen.findAllByRole('checkbox', {}, WAIT)) expect(box).toBeDisabled()
  })

  it('自己提交的修改不能自己通过', T, async () => {
    mountApp({ url: '/app/finance/profit-formula', pages, handlers: handlers({ '/finance/profit-formula': () => ok(formula({ pending: version({ mine: true }) })) }) })
    const alert = await screen.findByTestId('metric-pending', {}, WAIT)
    expect(within(alert).getByRole('button', { name: /通\s?过/ })).toBeDisabled()
    expect(within(alert).getByRole('button', { name: /撤\s?回/ })).toBeEnabled()
  })

  it('没有 finance.policy.write 权限时不能提交', T, async () => {
    mountApp({ url: '/app/finance/profit-formula', pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByTestId('formula-current', {}, WAIT)
    expect(screen.getByRole('button', { name: /提交审批/ })).toBeDisabled()
  })

  it('勾选一项后可以提交，请求带上最新版本号与勾选结果', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: '/app/finance/profit-formula',
      pages,
      handlers: handlers({
        '/auth/step-up': () => ok({ verified: true }),
        '/finance/profit-formula': (_url, init) => {
          if (init?.method === 'PUT') {
            bodies.push(JSON.parse(String(init.body)))
            return ok({ kind: 'PROFIT_FORMULA', versionNo: 2, status: 'PENDING_APPROVAL', version: 1, message: '已提交' })
          }
          return ok(formula())
        },
      }),
    })
    const user = userEvent.setup()
    const extra = FORMULA_KEYS.find(key => !DEFAULT_PROFIT_FORMULA.gross.includes(key) && BRIDGE_DEFS[key].direction === 'COST') as (typeof FORMULA_KEYS)[number]
    await user.click(await screen.findByRole('checkbox', { name: `计入毛利润：${BRIDGE_DEFS[extra].label}` }, WAIT))
    await user.click(screen.getByRole('button', { name: /提交审批/ }))
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.type(within(dialog).getByLabelText('修改原因'), '把这一项算进毛利')
    await user.type(within(dialog).getByLabelText('登录密码'), 'secret-pass')
    await user.click(within(dialog).getByRole('button', { name: /^提\s?交$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1), WAIT)
    expect(bodies[0]).toMatchObject({ version: 1, reason: '把这一项算进毛利' })
    expect(bodies[0]?.gross).toContain(extra)
  })
})

const rules = (over: Partial<BusinessRulesResponse> = {}): BusinessRulesResponse => ({
  current: { kind: 'BUSINESS_RULES', versionNo: 0, source: 'DEFAULT', effectiveFrom: null },
  cards: [
    {
      key: 'netSales',
      label: '净销售额',
      value: { deduct: ['REFUNDS'] },
      valueText: '销售额 − 退款',
      defaultText: '销售额 − 退款',
      impact: ['利润总览', '经营控制台'],
      options: [
        { value: 'REFUNDS', label: '退款' },
        { value: 'PROMOTION', label: '促销费用' },
      ],
      multiple: true,
      pendingValue: null,
    },
    {
      key: 'weekStart',
      label: '周起始日',
      value: { day: 'MON' },
      valueText: '周一',
      defaultText: '周一',
      impact: ['趋势图的按周分组'],
      options: [
        { value: 'MON', label: '周一' },
        { value: 'SUN', label: '周日' },
      ],
      multiple: false,
      pendingValue: null,
    },
  ],
  pending: null,
  latestVersionNo: 0,
  history: [],
  canWrite: true,
  canApprove: true,
  writeBlockedReason: null,
  note: '已关账月份的快照不改动。',
  ...over,
})
const ruleHandlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']) => handlers({ '/settings/business-rules': () => ok(rules()), ...over }, permissions)

describe('业务口径页', () => {
  it('每项口径显示当前值、系统默认与影响范围', T, async () => {
    mountApp({ url: '/app/settings/business-rules', pages, handlers: ruleHandlers() })
    const card = await screen.findByTestId('rule-netSales', {}, WAIT)
    expect(card).toHaveTextContent('销售额 − 退款')
    expect(card).toHaveTextContent('利润总览、经营控制台')
    expect(await screen.findByTestId('rule-weekStart', {}, WAIT)).toHaveTextContent('周一')
  })

  it('没有 settings.business.write 权限时不能编辑', T, async () => {
    mountApp({ url: '/app/settings/business-rules', pages, handlers: ruleHandlers({}, ['settings.read']) })
    await screen.findByTestId('rule-netSales', {}, WAIT)
    for (const button of screen.getAllByRole('button', { name: /编\s?辑/ })) expect(button).toBeDisabled()
  })

  it('有待审批的修改时编辑按钮禁用并显示审批提示', T, async () => {
    mountApp({
      url: '/app/settings/business-rules',
      pages,
      handlers: ruleHandlers({ '/settings/business-rules': () => ok(rules({ pending: version({ kind: 'BUSINESS_RULES', summary: '周起始日改为周日' }) })) }),
    })
    expect(await screen.findByTestId('metric-pending', {}, WAIT)).toHaveTextContent('周起始日改为周日')
    for (const button of screen.getAllByRole('button', { name: /编\s?辑/ })) expect(button).toBeDisabled()
  })
})
