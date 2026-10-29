import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { bidGrid, listHandlers, listResponse, offGrid, runRow, simulateResponse, strategyRow } from './ads-dayparting-fixtures.test-helper'

// 分时策略页（P3-12）：假服务端返回固定数据，验证热力图（有数据、数据流没接入、没数据）、策略列表与此刻应执行的值、
// 执行未接入的说明、创建与修改发出的请求（含版本号）、效果模拟（模型估算标注与假设）、只读成员看不到写入入口、读取失败。

const pages: LivePages = { AdsDaypartingPage: { load: () => import('./AdsDaypartingPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/dayparting'
const open = async () => within(await screen.findByTestId('ads-dayparting-page'))
const rowOf = async (page: ReturnType<typeof within>, name: string) => (await page.findByText(name)).closest('tr, [role=row]') as HTMLElement

describe('分时策略页：热力图', () => {
  it('有数据：按星期 × 小时显示花费；没有数据的格子是“—”；可切换指标', async () => {
    mountApp({ url, pages, handlers: listHandlers() })
    const page = await open()
    const grid = await page.findByTestId('dayparting-heatmap')
    expect(within(grid).getByText('$12')).toBeInTheDocument()
    expect(within(grid).getByText('$40')).toBeInTheDocument()
    expect(within(grid).getAllByText('—').length).toBe(166)
    fireEvent.mouseDown(page.getByRole('combobox', { name: '分时指标' }))
    fireEvent.click(await screen.findByText('转化（订单）', { selector: '.ant-select-item-option-content' }))
    expect(within(grid).getByText('3')).toBeInTheDocument()
    expect(within(grid).queryByText('$12')).toBeNull()
  })

  it('数据流没接入：整块写“尚未接入”和原因，不画格子；配置了但没有数据写“尚无记录”', async () => {
    const heatmap = { state: 'NOT_CONNECTED' as const, note: '营销数据流接收端尚未配置', zone: 'UTC', historyDays: 14, cells: [] }
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ streamConnected: false, heatmap })) })
    const section = within(await screen.findByTestId('dayparting-heatmap-section'))
    expect(await section.findByText('尚未接入')).toBeInTheDocument()
    expect(section.getByText('营销数据流接收端尚未配置')).toBeInTheDocument()
    expect(screen.queryByTestId('dayparting-heatmap')).toBeNull()
  })

  it('配置了但近 14 天没有小时指标：写“尚无记录”', async () => {
    const heatmap = { state: 'NO_DATA' as const, note: '近 14 天没有活动级的小时指标', zone: 'UTC', historyDays: 14, cells: [] }
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ heatmap })) })
    const section = within(await screen.findByTestId('dayparting-heatmap-section'))
    expect(await section.findByText('尚无记录')).toBeInTheDocument()
    expect(screen.queryByTestId('dayparting-heatmap')).toBeNull()
  })
})

describe('分时策略页：策略列表与执行说明', () => {
  it('策略行：名称、状态、版本、账户、类型与对象、取值概况、此刻应执行、更新人', async () => {
    mountApp({ url, pages, handlers: listHandlers() })
    const page = await open()
    const first = await rowOf(page, '夜间关停')
    expect(first).toHaveTextContent('已启用')
    expect(first).toHaveTextContent('第 3 版')
    expect(first).toHaveTextContent('美国账户')
    expect(first).toHaveTextContent('Northstar US')
    expect(first).toHaveTextContent('按时段启停 · 活动')
    expect(first).toHaveTextContent('春季推广、夏季推广')
    expect(first).toHaveTextContent('启停：暂停 6 个小时格，启用 162 个')
    expect(first).toHaveTextContent('启用') // 周五 10 点（UTC）不在暂停的时段
    expect(first).toHaveTextContent('林然')
    const second = await rowOf(page, '广告组倍率')
    expect(second).toHaveTextContent('已暂停')
    expect(second).toHaveTextContent('按时段调整竞价（系数） · 广告组')
    expect(second).toHaveTextContent('核心词组')
    expect(second).toHaveTextContent('竞价系数：提高 1 格，降低 1 格，不变 166 格')
  })

  it('页面顶部说明策略每小时执行、需要写入开关；执行记录没有时写“尚无记录”和原因，不写 0 条', async () => {
    mountApp({ url, pages, handlers: listHandlers() })
    const note = await screen.findByTestId('dayparting-execution-note')
    expect(note).toHaveTextContent('策略的执行')
    expect(note).toHaveTextContent('分时策略执行')
    expect(note).toHaveTextContent('活动级竞价系数没有对应的亚马逊字段')
    const runs = within(await screen.findByTestId('dayparting-runs'))
    expect((await runs.findAllByText(/尚无记录/)).length).toBeGreaterThan(0)
    expect(runs.getByText(/已启用的策略每小时执行一次/)).toBeInTheDocument()
    expect(screen.getByTestId('dayparting-assumptions')).toHaveTextContent('模型估算，不是亚马逊的预测')
  })

  it('有执行记录：列出时间、策略、对象、结果；没有名称的对象写“尚无记录”', async () => {
    const runs = { state: 'OK' as const, note: null, items: [runRow(), runRow({ id: 'run-2', entityName: null, outcome: 'APPLIED', executed: true, message: null })] }
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ runs })) })
    const section = within(await screen.findByTestId('dayparting-runs'))
    const rows = await section.findAllByText('夜间关停')
    expect(rows).toHaveLength(2)
    expect(section.getByText('已跳过')).toBeInTheDocument()
    expect(section.getByText('已执行')).toBeInTheDocument()
    expect(section.getByText('尚无记录')).toBeInTheDocument()
  })

  it('还没有策略：写明原因，不画示例行', async () => {
    const strategies = { state: 'NO_DATA' as const, note: '还没有创建分时策略；可以先看上面的热力图找出高峰与低谷时段，再新建策略', items: [], truncated: false }
    mountApp({ url, pages, handlers: listHandlers(() => listResponse({ strategies })) })
    expect(await screen.findByText(/还没有创建分时策略/)).toBeInTheDocument()
    expect(screen.queryByText('夜间关停')).toBeNull()
  })

  it('只读成员：没有新建与编辑入口，仍可模拟', async () => {
    mountApp({ url, pages, me: { ...defaultMe, permissions: ['ads.read'] }, handlers: listHandlers(() => listResponse({ canWrite: false })) })
    const page = await open()
    await rowOf(page, '夜间关停')
    expect(page.queryByRole('button', { name: '新建策略' })).toBeNull()
    expect(page.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(page.getAllByRole('button', { name: '模拟效果' }).length).toBe(2)
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({ url, pages, handlers: { '/ads/dayparting': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) } })
    expect((await screen.findAllByText(/服务暂时不可用/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('夜间关停')).toBeNull()
  })
})

describe('分时策略页：效果模拟', () => {
  it('显示“模型估算”标注、历史实际与按策略估算的对照、模型假设', async () => {
    const app = mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting/st-1/simulate': () => ok(simulateResponse()) }) })
    const page = await open()
    await rowOf(page, '夜间关停')
    fireEvent.click(page.getAllByRole('button', { name: '模拟效果' })[0]!)
    const result = within(await screen.findByTestId('dayparting-simulation'))
    expect(result.getByText('模型估算，不是亚马逊的预测')).toBeInTheDocument()
    const spend = result.getByText('花费').closest('tr, [role=row]') as HTMLElement
    expect(spend).toHaveTextContent('$52.00')
    expect(spend).toHaveTextContent('$40.00')
    expect(result.getByText(/策略改动了其中的 6 格取值/)).toBeInTheDocument()
    expect(result.getAllByText(/不考虑预算省下后挪到其他时段/).length).toBeGreaterThan(0)
    expect(app.calls.some(call => call.path === '/ads/dayparting/st-1/simulate' && call.method === 'POST')).toBe(true)
  })

  it('没有历史：写原因，不画估算数字', async () => {
    const empty = simulateResponse({ state: 'NOT_CONNECTED', note: '营销数据流接收端尚未配置，没有小时级历史，无法估算', baseline: null, estimated: null, coveredCells: 0 })
    mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting/st-1/simulate': () => ok(empty) }) })
    const page = await open()
    await rowOf(page, '夜间关停')
    fireEvent.click(page.getAllByRole('button', { name: '模拟效果' })[0]!)
    const result = within(await screen.findByTestId('dayparting-simulation'))
    expect(await result.findByText('尚未接入')).toBeInTheDocument()
    expect(result.getByText(/没有小时级历史，无法估算/)).toBeInTheDocument()
    expect(result.queryByText('按策略估算')).toBeNull()
  })

  it('模拟失败：显示服务端给的原因', async () => {
    const failing = { status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '分时策略不存在' } } }
    mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting/st-1/simulate': () => failing }) })
    const page = await open()
    await rowOf(page, '夜间关停')
    fireEvent.click(page.getAllByRole('button', { name: '模拟效果' })[0]!)
    expect(await screen.findByText('分时策略不存在')).toBeInTheDocument()
  })
})

describe('分时策略页：创建与修改', () => {
  const submit = () => userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

  it('创建：选账户与活动，在格子里画出暂停时段，请求体带 168 格；只列出所选账户下的活动', async () => {
    const bodies: Array<Record<string, any>> = []
    const post = (_url: URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok({ strategy: strategyRow({ id: 'st-9', name: '晚间关停' }) })
    }
    const app = mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting': (u, init) => (init?.method === 'POST' ? post(u, init) : ok(listResponse())) }) })
    const page = await open()
    await rowOf(page, '夜间关停')
    await userEvent.click(page.getByRole('button', { name: '新建策略' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('策略名称'), '晚间关停')
    fireEvent.mouseDown(dialog.getByLabelText('广告账户'))
    fireEvent.click(await screen.findByText('美国账户（Northstar US）', { selector: '.ant-select-item-option-content' }))
    fireEvent.mouseDown(dialog.getByLabelText(/作用的活动/))
    fireEvent.click(await screen.findByText('春季推广', { selector: '.ant-select-item-option-content' }))
    expect(screen.queryByText('别的账户的活动', { selector: '.ant-select-item-option-content' })).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: '周一 0 时 启用' }))
    expect(dialog.getByRole('button', { name: '周一 0 时 暂停' })).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '整行 周日' }))
    await submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ name: '晚间关停', adsProfileId: 'ap-a', kind: 'ON_OFF', level: 'CAMPAIGN', targetIds: ['cam-1'], status: 'PAUSED' })
    expect(bodies[0]!.grid).toHaveLength(168)
    expect(bodies[0]!.grid[0]).toBe(0)
    expect(bodies[0]!.grid.slice(144, 168).every((value: number) => value === 0)).toBe(true)
    expect(bodies[0]!.grid.filter((value: number) => value === 0)).toHaveLength(25)
    expect(bodies[0]).not.toHaveProperty('baseBid')
    expect(app.calls.some(call => call.path === '/ads/dayparting' && call.method === 'POST')).toBe(true)
  })

  it('服务端拒绝（重名）：弹窗里显示原因，不关闭', async () => {
    const reject = (_url: URL, init?: RequestInit) =>
      init?.method === 'POST' ? { status: 409, body: { error: { code: 'CONFLICT', message: '这个广告账户下已经有同名的分时策略，请换一个名称' } } } : ok(listResponse())
    mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting': reject }) })
    const page = await open()
    await rowOf(page, '夜间关停')
    await userEvent.click(page.getByRole('button', { name: '新建策略' }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('策略名称'), '夜间关停')
    fireEvent.mouseDown(dialog.getByLabelText('广告账户'))
    fireEvent.click(await screen.findByText('美国账户（Northstar US）', { selector: '.ant-select-item-option-content' }))
    fireEvent.mouseDown(dialog.getByLabelText(/作用的活动/))
    fireEvent.click(await screen.findByText('春季推广', { selector: '.ant-select-item-option-content' }))
    fireEvent.click(dialog.getByRole('button', { name: '周一 0 时 启用' }))
    await submit()
    expect(await screen.findByText(/已经有同名的分时策略/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('修改启停策略：带版本号，只送可改的字段（不送账户、类型、层级）', async () => {
    const bodies: Array<Record<string, any>> = []
    const patch = (_url: URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok({ strategy: strategyRow({ version: 4 }) })
    }
    mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting/st-1': patch }) })
    const page = await open()
    const row = await rowOf(page, '夜间关停')
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    const name = dialog.getByLabelText('策略名称')
    expect(name).toHaveValue('夜间关停')
    await userEvent.clear(name)
    await userEvent.type(name, '夜间关停（新）')
    await submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ version: 3, name: '夜间关停（新）', status: 'ACTIVE', targetIds: ['cam-1', 'cam-2'], grid: offGrid() })
    for (const key of ['adsProfileId', 'kind', 'level', 'baseBid']) expect(bodies[0]).not.toHaveProperty(key)
  })

  it('修改广告组层级的倍率策略：对象在页面里不能改（不送 targetIds），基准竞价随版本号送出', async () => {
    const bodies: Array<Record<string, any>> = []
    const patch = (_url: URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok({ strategy: strategyRow({ id: 'st-2', kind: 'BID_MULTIPLIER', version: 4 }) })
    }
    mountApp({ url, pages, handlers: listHandlers(undefined, { '/ads/dayparting/st-2': patch }) })
    const page = await open()
    const row = await rowOf(page, '广告组倍率')
    await userEvent.click(within(row).getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByLabelText(/作用的广告组/)).toBeDisabled()
    expect(dialog.getByRole('button', { name: '周一 1 时 系数 1.5' })).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('radio', { name: '已启用' }))
    await submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ version: 3, baseBid: 1.2, status: 'ACTIVE', grid: bidGrid() })
    expect(bodies[0]).not.toHaveProperty('targetIds')
  })
})
