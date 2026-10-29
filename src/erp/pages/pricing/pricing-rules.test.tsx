import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { dryRunResponse, guardrail, listResponse, ok, pricingHandlers, ruleRun, ruleView } from './pricing-fixtures.test-helper'

// 价格护栏与定价规则（P4-11）：护栏的列表与保存（百分比按小数提交、改已有的带版本号）、规则的列表（自动模式开关没开写“只生成建议”）、
// 暂停与恢复（带版本号）、试运行不改价、执行记录里待确认的建议确认（价格锁定为建议价）或忽略。

const pages: LivePages = { PricingPage: { load: () => import('./PricingPage') } }
afterEach(() => vi.unstubAllGlobals())
const EDIT = /^修\s?改$/
const PAUSE = /^暂\s?停$/
const RESUME = /^恢\s?复$/
const DISMISS = /^忽\s?略$/

const open = async (tabName: string, extra: Record<string, Handler> = {}, me = defaultMe) => {
  const app = mountApp({ url: '/app/pricing', pages, me, handlers: pricingHandlers(() => listResponse(), extra) })
  const page = within(await screen.findByTestId('pricing-page'))
  await page.findByText('玻璃保鲜盒套装', {}, { timeout: 15_000 })
  fireEvent.click(page.getByRole('tab', { name: tabName }))
  return { app, page }
}

describe('价格护栏', () => {
  it('列出护栏：范围、各项限制（不设写“不限”）、状态', async () => {
    const { page } = await open('价格护栏', {
      '/pricing/guardrails': () =>
        ok({ items: [guardrail(), guardrail({ id: 'g2', scope: 'SKU', scopeRef: 'SKU-1', minPrice: null, maxPrice: 40, minMarginPct: null, maxChangePct: null, enabled: false })], truncated: false }),
    })
    const first = (await page.findByText('整个店铺')).closest('tr, [role=row]') as HTMLElement
    expect(first).toHaveTextContent('$20.00')
    expect(first).toHaveTextContent('10.0%')
    expect(first).toHaveTextContent('启用')
    const second = page.getByText('SKU：SKU-1').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('$40.00')
    expect(second).toHaveTextContent('不限')
    expect(second).toHaveTextContent('停用')
  })

  it('修改已有护栏：百分比按小数提交，并带上版本号', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { page } = await open('价格护栏', {
      '/pricing/guardrails': (_url, init) => {
        if (init?.method === 'PUT') {
          bodies.push(JSON.parse(String(init.body)))
          return ok(guardrail({ version: 3 }))
        }
        return ok({ items: [guardrail()], truncated: false })
      },
    })
    fireEvent.click(await page.findByRole('button', { name: EDIT }))
    const dialog = within(await screen.findByRole('dialog'))
    const margin = dialog.getByRole('spinbutton', { name: '最低利润率' })
    await userEvent.clear(margin)
    await userEvent.type(margin, '15')
    await userEvent.click(dialog.getByRole('button', { name: /保\s?存/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ storeId: 'st1', scope: 'STORE', scopeRef: '', minPrice: 20, minMarginPct: 0.15, maxChangePct: 0.1, enabled: true, expectedVersion: 2 })
  })

  it('服务端拒绝（至少设置一项）：显示原因，不关闭窗口', async () => {
    const { page } = await open('价格护栏', {
      '/pricing/guardrails': (_url, init) =>
        init?.method === 'PUT' ? { status: 422, body: { error: { code: 'VALIDATION_FAILED', message: '至少设置一项限制' } } } : ok({ items: [guardrail()], truncated: false }),
    })
    fireEvent.click(await page.findByRole('button', { name: EDIT }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('button', { name: /保\s?存/ }))
    expect(await dialog.findByText(/至少设置一项限制/)).toBeInTheDocument()
  })

  it('没有规则写入权限：新增与修改禁用', async () => {
    const { page } = await open('价格护栏', {}, { ...defaultMe, permissions: ['pricing.read'] })
    expect(await page.findByRole('button', { name: '新增护栏' })).toBeDisabled()
    expect(await page.findByRole('button', { name: EDIT })).toBeDisabled()
  })
})

describe('定价规则', () => {
  const autoRule = ruleView({ id: 'rule2', name: '自动跟价', mode: 'AUTO', modeLabel: '自动执行', autoReady: false, autoNote: '“自动调价”开关未开启', pendingSuggestions: 0 })

  it('列出规则：策略、适用商品、状态、待确认建议；自动模式开关没开写“只生成建议”', async () => {
    const { page } = await open('定价规则', { '/pricing/rules': () => ok({ items: [ruleView(), autoRule], truncated: false }) })
    const first = (await page.findByText('跟随预期价')).closest('tr, [role=row]') as HTMLElement
    expect(first).toHaveTextContent('与预期价格持平')
    expect(first).toHaveTextContent('全部商品')
    expect(first).toHaveTextContent('启用中')
    expect(first).toHaveTextContent('1 条')
    const second = page.getByText('自动跟价').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('只生成建议')
    expect(second).toHaveTextContent('单次 ≤ 5.0%')
  })

  it('暂停：PATCH 带版本号与新状态；恢复熔断的规则要确认并写明原因', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const broken = ruleView({ id: 'rule3', name: '熔断的规则', status: 'BREAKER', statusLabel: '已熔断', breakerReason: '连续失败 3 次', pendingSuggestions: 0 })
    const handler: Handler = (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok(ruleView())
    }
    const { page } = await open('定价规则', {
      '/pricing/rules': () => ok({ items: [ruleView(), broken], truncated: false }),
      '/pricing/rules/rule1': handler,
      '/pricing/rules/rule3': handler,
    })
    const first = (await page.findByText('跟随预期价')).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(first).getByRole('button', { name: PAUSE }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ expectedVersion: 3, status: 'PAUSED' })
    const second = page.getByText('熔断的规则').closest('tr, [role=row]') as HTMLElement
    expect(second).toHaveTextContent('连续失败 3 次')
    await userEvent.click(within(second).getByRole('button', { name: RESUME }))
    expect(await screen.findByText(/请先确认原因已经处理/)).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /确认恢复/ }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual({ expectedVersion: 3, status: 'ACTIVE' })
  })

  it('试运行：提交天数，显示逐日命中与逐个商品，写明不改价', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { page } = await open('定价规则', {
      '/pricing/rules/rule1/dry-run': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return ok(dryRunResponse())
      },
    })
    const row = (await page.findByText('跟随预期价')).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: '试运行' }))
    const drawer = within(await screen.findByTestId('pricing-dry-run'))
    await userEvent.click(drawer.getByRole('button', { name: '开始试运行' }))
    expect(await drawer.findByText('试运行不会改价。')).toBeInTheDocument()
    expect(bodies[0]).toEqual({ days: 7 })
    expect(drawer.getByText('2026-10-23')).toBeInTheDocument()
    expect(drawer.getAllByText('命中').length).toBeGreaterThan(0)
  })

  it('执行记录：待确认的建议“确认调价”进入改价抽屉，价格锁定为建议价；已执行的显示前后对照', async () => {
    const applied = ruleRun({
      id: 'rr2',
      outcome: 'APPLIED',
      outcomeLabel: '已执行',
      suggestedPrice: 24.5,
      compare: {
        state: 'OK',
        note: null,
        before: { days: 7, unitsPerDay: 3, sessions: 600, conversionPct: 0.1, buyBoxPct: 0.5 },
        after: { days: 7, unitsPerDay: 4, sessions: 650, conversionPct: 0.12, buyBoxPct: 0.6 },
      },
    })
    const { page } = await open('定价规则', { '/pricing/rules/rule1/runs': () => ok({ items: [ruleRun(), applied], pageInfo: { hasMore: false, nextCursor: null, approxTotal: 2 } }) })
    const row = (await page.findByText('跟随预期价')).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: '执行记录' }))
    const drawer = within(await screen.findByTestId('pricing-rule-runs'))
    expect(await drawer.findByTestId('price-compare')).toHaveTextContent('日均销量 3.0')
    await userEvent.click(drawer.getByRole('button', { name: '确认调价' }))
    const change = within(await screen.findByTestId('price-change-drawer'))
    expect(change.getByRole('spinbutton', { name: '新价格' })).toHaveValue('23.99')
    expect(change.getByRole('spinbutton', { name: '新价格' })).toBeDisabled()
    expect(change.getByText(/规则建议（人工确认）/)).toBeInTheDocument()
  })

  it('忽略建议：要确认，请求发到 dismiss', async () => {
    const dismissed: string[] = []
    const { page } = await open('定价规则', {
      '/pricing/rules/rule1/runs': () => ok({ items: [ruleRun()], pageInfo: { hasMore: false, nextCursor: null, approxTotal: 1 } }),
      '/pricing/rule-runs/rr1/dismiss': () => {
        dismissed.push('rr1')
        return ok({})
      },
    })
    const row = (await page.findByText('跟随预期价')).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: '执行记录' }))
    const drawer = within(await screen.findByTestId('pricing-rule-runs'))
    await userEvent.click(await drawer.findByRole('button', { name: DISMISS }))
    await userEvent.click(await screen.findByRole('button', { name: /确认忽略/ }))
    await waitFor(() => expect(dismissed).toEqual(['rr1']))
  })

  it('新建规则：百分比按小数提交；参数不合法在页面就拦住', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { page } = await open('定价规则', {
      '/pricing/rules': (_url, init) => {
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)))
          return ok(ruleView())
        }
        return ok({ items: [ruleView()], truncated: false })
      },
    })
    await userEvent.click(await page.findByRole('button', { name: '新建规则' }))
    const drawer = within(await screen.findByTestId('pricing-rule-drawer'))
    await userEvent.click(drawer.getByRole('button', { name: /保\s?存/ }))
    expect(await drawer.findByText('请填写规则名称')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.type(drawer.getByRole('textbox', { name: '规则名称' }), '跟价')
    await userEvent.click(drawer.getByRole('button', { name: /保\s?存/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({
      storeId: 'st1',
      name: '跟价',
      mode: 'MANUAL',
      strategy: 'FOLLOW_EXPECTED',
      params: { offsetPct: 0 },
      scope: { all: true, skus: [], asins: [] },
      maxChangePct: 0.05,
      dailyLimit: 1,
      status: 'PAUSED',
    })
  })
})
