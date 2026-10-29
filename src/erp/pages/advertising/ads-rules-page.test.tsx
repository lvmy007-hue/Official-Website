import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { campaignSpec, listHandlers, listResponse, ruleRow } from './ads-rules-fixtures.test-helper'

// 自动规则列表页（P3-13）：假服务端返回固定数据，验证列表内容、自动执行未接入的说明、没有数据与读取失败、
// 创建与修改发出的请求（含版本号、护栏）、自动模式在开关没开时不可选、只读成员看不到写入入口。

const pages: LivePages = { AdsRulesPage: { load: () => import('./AdsRulesPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/rules'
const open = async () => within(await screen.findByTestId('ads-rules-page'))
const rowOf = async (page: ReturnType<typeof within>, name: string) => (await page.findByText(name)).closest('tr, [role=row]') as HTMLElement
const submit = () => userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

describe('自动规则页：列表', () => {
  it('规则行：名称、状态、模式、账户、条件与动作摘要、最近评估；没评估过写“尚未评估”', async () => {
    mountApp({ url, pages, handlers: listHandlers() })
    const page = await open()
    const first = await rowOf(page, '高 ACoS 活动暂停')
    expect(first).toHaveTextContent('已启用')
    expect(first).toHaveTextContent('建议模式')
    expect(first).toHaveTextContent('美国账户')
    expect(first).toHaveTextContent('Northstar US')
    expect(first).toHaveTextContent('近 7 天广告成本销售比 > 40%')
    expect(first).toHaveTextContent('每天一次')
    expect(first).toHaveTextContent('评估 12 个，命中 3 个')
    const second = await rowOf(page, '搜索词否定')
    expect(second).toHaveTextContent('已暂停')
    expect(second).toHaveTextContent('尚未评估')
  })

  it('页面顶部说明自动执行需要的开关，以及搜索词层级只生成待办', async () => {
    mountApp({ url, pages, handlers: listHandlers() })
    const note = await screen.findByTestId('rules-execution-note')
    expect(note).toHaveTextContent('自动规则执行')
    expect(note).toHaveTextContent('只生成待办')
  })

  it('还没有规则：写明原因，不画示例行', async () => {
    const rules = { state: 'NO_DATA' as const, note: '还没有创建自动规则', items: [], truncated: false }
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ rules })) })
    expect(await screen.findByText(/还没有创建自动规则/)).toBeInTheDocument()
    expect(screen.queryByText('高 ACoS 活动暂停')).toBeNull()
  })

  it('只读成员：没有新建与编辑入口，仍可进入详情', async () => {
    mountApp({ url, pages, me: { ...defaultMe, permissions: ['ads.read'] }, handlers: listHandlers(() => listResponse({ canWrite: false })) })
    const page = await open()
    await rowOf(page, '高 ACoS 活动暂停')
    expect(page.queryByRole('button', { name: '新建规则' })).toBeNull()
    expect(page.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(page.getAllByRole('link', { name: '详情' }).length).toBe(2)
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({ url, pages, handlers: { '/ads/rules': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('高 ACoS 活动暂停')).toBeNull()
  })
})

describe('自动规则页：创建与修改', () => {
  it('创建：选账户，填阈值，请求体带条件、动作与护栏；自动模式在开关没开时不可选并写原因', async () => {
    const bodies: Array<Record<string, any>> = []
    const post = (_url: URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok({ rule: ruleRow({ id: 'r-9' }) })
    }
    const app = mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/rules': (u, init) => (init?.method === 'POST' ? post(u, init) : ok(listResponse())) }) })
    const page = await open()
    await rowOf(page, '高 ACoS 活动暂停')
    await userEvent.click(page.getByRole('button', { name: '新建规则' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('radio', { name: '自动执行模式' })).toBeDisabled()
    expect(dialog.getAllByText(/写入开关“自动规则执行”未开启/).length).toBeGreaterThan(0)
    await userEvent.type(dialog.getByLabelText('规则名称'), '高花费暂停')
    fireEvent.mouseDown(dialog.getByLabelText('广告账户'))
    fireEvent.click(await screen.findByText('美国账户（Northstar US）', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(dialog.getByLabelText('阈值'), '40')
    await submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({
      name: '高花费暂停',
      adsProfileId: 'ap-a',
      level: 'CAMPAIGN',
      mode: 'SUGGEST',
      status: 'PAUSED',
      frequency: 'DAILY',
      conditions: [{ metric: 'acos', windowDays: 7, op: 'gt', value: 40 }],
      textFilters: [],
      campaignIds: [],
      action: { type: 'PAUSE' },
      guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 20 },
    })
    expect(app.calls.some(call => call.path === '/ads/rules' && call.method === 'POST')).toBe(true)
  })

  it('改成搜索词层级：动作换成否定或加词；调整竞价必须设置单次幅度上限', async () => {
    mountApp({ url, pages, handlers: listHandlers() })
    const page = await open()
    await rowOf(page, '高 ACoS 活动暂停')
    await userEvent.click(page.getByRole('button', { name: '新建规则' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.click(dialog.getByRole('radio', { name: '搜索词' }))
    expect(await dialog.findByText('添加否定投放')).toBeInTheDocument()
    expect(dialog.getByRole('radio', { name: '否定精确' })).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('radio', { name: '投放词（关键词与投放）' }))
    expect(await dialog.findByText('调整竞价')).toBeInTheDocument()
    await userEvent.type(dialog.getByLabelText('规则名称'), '降价')
    fireEvent.mouseDown(dialog.getByLabelText('广告账户'))
    fireEvent.click(await screen.findByText('美国账户（Northstar US）', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(dialog.getByLabelText('阈值'), '40')
    await userEvent.type(dialog.getByLabelText('调整幅度'), '-10')
    await submit()
    expect(await screen.findByText('调整竞价或预算必须设置幅度上限')).toBeInTheDocument()
  })

  it('服务端拒绝（需要写入开关）：弹窗里显示原因，不关闭', async () => {
    const reject = (_url: URL, init?: RequestInit) =>
      init?.method === 'POST' ? { status: 409, body: { error: { code: 'WRITE_SWITCH_OFF', message: '自动执行模式需要先开启“自动规则执行”写入开关' } } } : ok(listResponse())
    mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/rules': reject }) })
    const page = await open()
    await rowOf(page, '高 ACoS 活动暂停')
    await userEvent.click(page.getByRole('button', { name: '新建规则' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('规则名称'), '高花费暂停')
    fireEvent.mouseDown(dialog.getByLabelText('广告账户'))
    fireEvent.click(await screen.findByText('美国账户（Northstar US）', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(dialog.getByLabelText('阈值'), '40')
    await submit()
    expect(await screen.findByText(/需要先开启“自动规则执行”写入开关/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('修改：带版本号，只送可改的字段（不送账户与层级），已有的护栏带回', async () => {
    const bodies: Array<Record<string, any>> = []
    const patch = (_url: URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok({ rule: ruleRow({ version: 3 }) })
    }
    const spec = campaignSpec({ action: { type: 'ADJUST_BUDGET', mode: 'PERCENT', value: -20 }, guardrails: { minValue: 5, maxValue: 50, maxChangePercent: 30, dailyLimit: 10 } })
    const handlers = listHandlers(() => listResponse({ rules: { state: 'OK', note: null, items: [ruleRow({ spec })], truncated: false } }), { '/ads/rules/r-1': patch })
    mountApp({ url, pages, handlers })
    const page = await open()
    const row = await rowOf(page, '高 ACoS 活动暂停')
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    const name = dialog.getByLabelText('规则名称')
    expect(name).toHaveValue('高 ACoS 活动暂停')
    expect(dialog.getByLabelText('单次调整幅度上限')).toHaveValue('30')
    expect(dialog.getByLabelText('广告账户')).toBeDisabled()
    await userEvent.clear(name)
    await userEvent.type(name, '高 ACoS 降预算')
    await userEvent.click(dialog.getByRole('radio', { name: '已暂停' }))
    await submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({
      version: 2,
      name: '高 ACoS 降预算',
      status: 'PAUSED',
      action: { type: 'ADJUST_BUDGET', mode: 'PERCENT', value: -20 },
      guardrails: { minValue: 5, maxValue: 50, maxChangePercent: 30, dailyLimit: 10 },
    })
    for (const key of ['adsProfileId', 'level']) expect(bodies[0]).not.toHaveProperty(key)
  })
})
