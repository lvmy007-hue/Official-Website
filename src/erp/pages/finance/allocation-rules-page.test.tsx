import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ALLOCATION_RULE_BASES, ALLOCATION_RULE_BASIS_LABEL, ALLOCATION_RULE_NOTES, type AllocationPreviewResponse, type AllocationRuleRow, type AllocationRulesResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from '../promotions/promotions-fixtures.test-helper'
import { manualWeightsText, parseManualWeights, ruleBodyOf } from './allocation-rules-parts'

// 费用分摊规则页（P6-19）：规则表（费用项、依据、生效月、已关账不能改）、修改带版本号、没有权限不能改、预览请求与结果、手动比例文本解析。

const pages: LivePages = { AllocationRulesPage: { load: () => import('./AllocationRulesPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }

const rule = (over: Partial<AllocationRuleRow> = {}): AllocationRuleRow => ({
  id: 'r1',
  feeItemId: 'f1',
  feeItemName: '仓储费',
  feeItemPath: '平台费用 / 仓储费',
  basis: 'SALES_AMOUNT',
  basisLabel: '按销售额',
  manualWeights: null,
  effectiveMonth: '2026-07',
  version: 2,
  locked: false,
  createdBy: 'u1',
  updatedAt: '2026-10-20T00:00:00Z',
  ...over,
})
const listing = (
  rows: AllocationRuleRow[] = [rule(), rule({ id: 'r2', feeItemId: 'f2', feeItemName: '订阅费', feeItemPath: '其他 / 订阅费', effectiveMonth: '2026-03', locked: true })],
): AllocationRulesResponse & { page: number; pageSize: number } => ({
  rows,
  total: rows.length,
  page: 1,
  pageSize: 50,
  feeItems: [
    { id: 'f1', name: '仓储费', path: '平台费用 / 仓储费', storeLevelLines90d: 12 },
    { id: 'f2', name: '订阅费', path: '其他 / 订阅费', storeLevelLines90d: 3 },
  ],
  bases: ALLOCATION_RULE_BASES.map(value => ({ value, label: ALLOCATION_RULE_BASIS_LABEL[value] })),
  notes: [...ALLOCATION_RULE_NOTES],
})
const preview = (): AllocationPreviewResponse => ({
  month: '2026-07',
  feeItemId: 'f1',
  feeItemName: '仓储费',
  basis: 'SALES_UNITS',
  totalAmount: -10,
  allocatedAmount: -10,
  unallocatedAmount: 0,
  currentBasis: 'SALES_AMOUNT',
  locked: false,
  rows: [
    { sellerAccountId: 's1', sku: 'SKU-A', share: 0.6, amount: -6, currentAmount: -7.5, diff: 1.5 },
    { sellerAccountId: 's1', sku: 'SKU-B', share: 0.4, amount: -4, currentAmount: -2.5, diff: -1.5 },
  ],
  truncated: false,
  notes: ['预览只读，不会保存规则。'],
})
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/allocation-rules': () => ok(listing()),
  ...over,
})

describe('费用分摊规则页', () => {
  it('规则表显示费用项、依据、生效月；已关账的规则标明不能改；页头写明分摊只改归属', T, async () => {
    mountApp({ url: '/app/finance/allocation-rules', pages, handlers: handlers() })
    expect(await screen.findByText('平台费用 / 仓储费', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('其他 / 订阅费')).toBeInTheDocument()
    expect(screen.getByText('2026-07')).toBeInTheDocument()
    expect(screen.getByText('已关账（不能改）')).toBeInTheDocument()
    expect(screen.getAllByText('先重开关账').length).toBeGreaterThanOrEqual(1)
    expect(await screen.findByTestId('allocation-rules-notes', {}, WAIT)).toHaveTextContent('分摊只改变费用归属，不改变总额')
  })

  it('没有规则时写明店铺级费用留在店铺级行', T, async () => {
    mountApp({ url: '/app/finance/allocation-rules', pages, handlers: handlers({ '/finance/allocation-rules': () => ok(listing([])) }) })
    expect(await screen.findByText(/店铺级费用会留在店铺级行/, {}, WAIT)).toBeInTheDocument()
  })

  it('没有 finance.policy.write 权限时新建与修改都不能点', T, async () => {
    mountApp({ url: '/app/finance/allocation-rules', pages, handlers: handlers({}, ['finance.read']) })
    await screen.findByText('平台费用 / 仓储费', {}, WAIT)
    expect(screen.getByRole('button', { name: /新建规则/ })).toBeDisabled()
    for (const button of screen.getAllByRole('button', { name: /修\s?改/ })) expect(button).toBeDisabled()
  })

  it('修改依据：带上规则编号与打开页面时看到的版本号', T, async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/finance/allocation-rules',
      pages,
      handlers: handlers({
        '/finance/allocation-rules': (_url, init) => {
          if (init?.method === 'PUT') {
            bodies.push(JSON.parse(String(init.body)))
            return ok({ rule: rule({ basis: 'SALES_UNITS', basisLabel: '按销量', version: 3 }), recomputeNote: '新规则在下一次重算后生效。' })
          }
          return ok(listing())
        },
      }),
    })
    const user = userEvent.setup()
    await screen.findByText('平台费用 / 仓储费', {}, WAIT)
    const edit = (await screen.findAllByRole('button', { name: /修\s?改/ }, WAIT)).find(button => !(button as HTMLButtonElement).disabled) as HTMLElement
    await user.click(edit)
    const dialog = await screen.findByRole('dialog', {}, WAIT)
    await user.click(within(dialog).getByRole('combobox'))
    await user.click(await screen.findByTitle('按销量', {}, WAIT))
    await user.click(within(dialog).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1), WAIT)
    expect(bodies[0]).toEqual({ id: 'r1', version: 2, basis: 'SALES_UNITS' })
  })

  it('分摊预览：提交费用项、月份与依据，显示总额、留在店铺级的金额与对比表', T, async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/finance/allocation-rules',
      pages,
      handlers: handlers({
        '/finance/allocation-rules/preview': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return ok(preview())
        },
      }),
    })
    const user = userEvent.setup()
    await screen.findByText('平台费用 / 仓储费', {}, WAIT)
    await user.click(screen.getByRole('tab', { name: '分摊预览' }))
    const section = await screen.findByTestId('allocation-preview', {}, WAIT)
    await user.click(within(section).getAllByRole('combobox')[0] as HTMLElement)
    await user.click(await screen.findByTitle('平台费用 / 仓储费', {}, WAIT))
    await user.click(within(section).getByRole('button', { name: /预\s?览/ }))
    await waitFor(() => expect(bodies).toHaveLength(1), WAIT)
    expect(bodies[0]).toEqual({ month: new Date().toISOString().slice(0, 7), rule: { feeItemId: 'f1', basis: 'SALES_AMOUNT' } })
    expect(await screen.findByTestId('allocation-preview-summary', {}, WAIT)).toHaveTextContent('留在店铺级')
    expect(await screen.findByText('SKU-A', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByTestId('allocation-preview-notes')).toHaveTextContent('预览只读')
  })
})

describe('手动比例文本', () => {
  it('每行 SKU 加权重，分隔符可以是空格、逗号、冒号；格式不对、权重为 0、SKU 重复、为空都给出明确原因', () => {
    expect(parseManualWeights('SKU-A 3\nSKU-B,1\nSKU C：2.5')).toEqual({ weights: { 'SKU-A': 3, 'SKU-B': 1, 'SKU C': 2.5 } })
    expect(parseManualWeights('')).toEqual({ error: '手动比例至少填写一个 SKU' })
    expect(parseManualWeights('SKU-A')).toMatchObject({ error: expect.stringContaining('第 1 行格式不对') })
    expect(parseManualWeights('SKU-A 0')).toMatchObject({ error: expect.stringContaining('权重必须大于 0') })
    expect(parseManualWeights('SKU-A 1\nSKU-A 2')).toMatchObject({ error: expect.stringContaining('重复') })
  })
  it('回写成文本再解析结果不变；非手动依据不带比例，手动依据解析失败抛错', () => {
    const weights = { 'SKU-A': 3, 'SKU-B': 1.5 }
    expect(parseManualWeights(manualWeightsText(weights))).toEqual({ weights })
    expect(ruleBodyOf({ basis: 'SALES_UNITS', manualText: 'SKU-A 1' })).toEqual({ basis: 'SALES_UNITS' })
    expect(ruleBodyOf({ basis: 'MANUAL', manualText: 'SKU-A 2' })).toEqual({ basis: 'MANUAL', manualWeights: { 'SKU-A': 2 } })
    expect(() => ruleBodyOf({ basis: 'MANUAL', manualText: '' })).toThrow('手动比例至少填写一个 SKU')
  })
})
