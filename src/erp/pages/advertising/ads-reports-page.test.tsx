import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './ads-fixtures.test-helper'
import { listResponse, reportHandlers, sampleReports } from './ads-reports-fixtures.test-helper'

// 广告报表页（P3-15）：假服务端返回固定数据，验证任务列表（状态、失败原因、导入行数、警告、旧版任务）、历史可用起点、
// 创建与历史回补发出的请求、失败重试、没有权限时的禁用、模板库、迁移期核对（总览、差异明细、手动核对）、没有数据与读取失败。

const pages: LivePages = { AdsReportsPage: { load: () => import('./AdsReportsPage') } }
afterEach(() => vi.unstubAllGlobals())

const url = '/app/advertising/reports'
const open = async () => within(await screen.findByTestId('ads-reports-page'))
const rowOf = async (text: string) => {
  let row: HTMLElement | null = null
  await vi.waitFor(() => {
    row = screen.getByText(text).closest('tr, [role=row]')
    expect(row).not.toBeNull()
  }, 4000)
  return row as unknown as HTMLElement
}
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>
const confirm = (name: RegExp) => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }))

describe('广告报表：报告任务', () => {
  it('任务行：模板、来源、档案、时间范围、状态、导入行数与跳过数、警告；没有行数写“—”', async () => {
    mountApp({ url, pages, handlers: reportHandlers() })
    const ready = await rowOf('活动日报')
    expect(ready).toHaveTextContent('新报告接口')
    expect(ready).toHaveTextContent('美国账户')
    expect(ready).toHaveTextContent('Northstar US')
    expect(ready).toHaveTextContent('2026-09-01 至 2026-09-30')
    expect(ready).toHaveTextContent('已完成')
    expect(ready).toHaveTextContent('1,280（跳过 3）')
    expect(ready).toHaveTextContent('1 条警告')
    const pending = await rowOf('广告位日报')
    expect(pending).toHaveTextContent('排队中')
    expect(pending).toHaveTextContent('第 2 次')
    expect(pending).toHaveTextContent('—')
    expect(pending).not.toHaveTextContent(/\b0\b/)
  })

  it('失败任务写失败原因；新报告接口的失败任务有“重试”，旧版接口的失败任务没有', async () => {
    mountApp({ url, pages, handlers: reportHandlers() })
    const failed = await rowOf('搜索词日报')
    expect(failed).toHaveTextContent('失败')
    expect(failed).toHaveTextContent('报告里没有一行能按模板解析')
    expect(within(failed).getByRole('button', { name: /重试/ })).toBeEnabled()
    const legacy = await rowOf('spCampaigns')
    expect(legacy).toHaveTextContent('旧版接口')
    expect(legacy).toHaveTextContent('任务失败（FAILED）')
    expect(within(legacy).queryByRole('button', { name: /重试/ })).toBeInTheDocument()
    expect(within(legacy).getByRole('button', { name: /重试/ })).toBeDisabled()
  })

  it('历史可用起点：每个档案已经取得数据的最早日期；没取过数据写“尚未取得数据”，并说明保留期以实测为准', async () => {
    mountApp({ url, pages, handlers: reportHandlers() })
    const strip = await screen.findByTestId('ads-reports-history')
    await vi.waitFor(() => expect(strip).toHaveTextContent('美国账户 · Northstar US：2026-08-20'))
    expect(strip).toHaveTextContent('历史可用起点')
    expect(strip).toHaveTextContent('加拿大账户：尚未取得数据')
    expect(strip).toHaveTextContent('15 个月与 24 个月两种说法')
  })

  it('状态条带各状态条数；按状态与模板筛选随请求带出', async () => {
    const app = mountApp({ url, pages, handlers: reportHandlers() })
    const page = await open()
    expect(await page.findByText('全部（4）')).toBeInTheDocument()
    expect(page.getByText('失败（2）')).toBeInTheDocument()
    await userEvent.click(page.getByText('失败（2）'))
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/reports' && new URLSearchParams(call.search).get('status') === 'FAILED')).toBe(true))
  })

  it('没有任务：写“尚无”与原因，不画示例行', async () => {
    mountApp({
      url,
      pages,
      handlers: reportHandlers({}, () => listResponse({ state: 'NO_DATA', items: [], counts: { PENDING: 0, GENERATING: 0, READY: 0, FAILED: 0 }, note: '还没有创建过广告报告任务' })),
    })
    expect(await screen.findByText(/还没有创建过广告报告任务/)).toBeInTheDocument()
    expect(screen.queryByText('活动日报')).toBeNull()
  })

  it('读取失败：显示错误，不显示示例数据', async () => {
    mountApp({ url, pages, handlers: reportHandlers({ '/ads/reports': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('活动日报')).toBeNull()
  })
})

describe('广告报表：创建、回补与重试', () => {
  it('创建：默认带第一个可用档案、活动日报与最近 30 天；请求体与服务端一致', async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url,
      pages,
      handlers: reportHandlers({ '/ads/reports': (_u, init) => (init?.method === 'POST' ? (bodies.push(bodyOf(init)), ok({ report: sampleReports()[0], syncJobId: 'sj-1' })) : ok(listResponse())) }),
    })
    await rowOf('活动日报')
    const button = await screen.findByRole('button', { name: '创建报告任务' })
    await vi.waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByLabelText('开始日期')).toHaveValue('2026-09-23')
    expect(dialog.getByLabelText('结束日期')).toHaveValue('2026-10-22')
    await confirm(/^创\s*建$/)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ profileId: 'ap-a', templateKey: 'CAMPAIGN_DAILY', adProduct: 'SPONSORED_PRODUCTS', from: '2026-09-23', to: '2026-10-22' })
  })

  it('开始日期晚于结束日期：弹窗里提示，不发请求', async () => {
    const app = mountApp({ url, pages, handlers: reportHandlers() })
    await rowOf('活动日报')
    const button = await screen.findByRole('button', { name: '创建报告任务' })
    await vi.waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('开始日期'), { target: { value: '2026-10-30' } })
    await confirm(/^创\s*建$/)
    expect(await screen.findByText('开始日期不能晚于结束日期')).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/ads/reports' && call.method === 'POST')).toBe(false)
  })

  it('服务端拒绝（时间范围超限）：弹窗里显示原因，不关闭', async () => {
    const reject = { status: 422, body: { error: { code: 'ADS_REPORT_WINDOW', message: '小时报告最多取最近 14 天' } } }
    mountApp({ url, pages, handlers: reportHandlers({ '/ads/reports': (_u, init) => (init?.method === 'POST' ? reject : ok(listResponse())) }) })
    await rowOf('活动日报')
    const button = await screen.findByRole('button', { name: '创建报告任务' })
    await vi.waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    await confirm(/^创\s*建$/)
    expect(await screen.findByText(/小时报告最多取最近 14 天/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('补历史数据：默认往前 24 个月，请求体带档案、产品与月数', async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url, pages, handlers: reportHandlers({ '/ads/reports/backfill': (_u, init) => (bodies.push(bodyOf(init)), ok({ reports: [], windows: [] })) }) })
    await rowOf('活动日报')
    const button = await screen.findByRole('button', { name: '补历史数据' })
    await vi.waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    expect(await screen.findByText(/按 120 天切片/)).toBeInTheDocument()
    await confirm(/开始补数据/)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ profileId: 'ap-a', adProduct: 'SPONSORED_PRODUCTS', months: 24 })
  })

  it('重试：确认后向该任务的重试接口发请求', async () => {
    const app = mountApp({ url, pages, handlers: reportHandlers() })
    const failed = await rowOf('搜索词日报')
    await userEvent.click(within(failed).getByRole('button', { name: /重试/ }))
    await confirm(/^重\s*试$/)
    await vi.waitFor(() => expect(app.calls.some(call => call.path === '/ads/reports/rp-2/retry' && call.method === 'POST')).toBe(true))
  })

  it('没有 ads.report 权限：创建、补数据、重试都不可用', async () => {
    mountApp({ url, pages, me: { ...defaultMe, permissions: ['ads.read'] }, handlers: reportHandlers() })
    const failed = await rowOf('搜索词日报')
    expect(await screen.findByRole('button', { name: '创建报告任务' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '补历史数据' })).toBeDisabled()
    expect(within(failed).getByRole('button', { name: /重试/ })).toBeDisabled()
  })
})

describe('广告报表：模板库与迁移核对', () => {
  it('模板库：8 个模板的粒度、维度、导入后的数据集；档案是否可用与历史可用起点', async () => {
    mountApp({ url, pages, handlers: reportHandlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '模板库' }))
    const library = await screen.findByTestId('ads-reports-library')
    expect(within(library).getByText('活动小时报')).toBeInTheDocument()
    expect(within(library).getByText('转化商品日报')).toBeInTheDocument()
    expect(library).toHaveTextContent('活动日指标')
    expect(library).toHaveTextContent('还没有发现统一接口的广告账户编号')
    expect(library).toHaveTextContent('2026-08-20')
    expect(library).toHaveTextContent('尚未取得数据')
  })

  it('迁移核对：停止日期说明、旧通道与连续通过、四类差异条数；没核对过写“尚未核对”', async () => {
    mountApp({ url, pages, handlers: reportHandlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '迁移核对' }))
    expect(await screen.findByTestId('ads-parity-sunset')).toHaveTextContent('2027 年 6 月 30 日')
    const parity = screen.getByTestId('ads-reports-parity')
    expect(parity).toHaveTextContent('3 / 7')
    expect(parity).toHaveTextContent('尚未核对')
    expect(parity).toHaveTextContent('时间口径 1')
    expect(parity).toHaveTextContent('未解释 1')
    expect(parity).toHaveTextContent('2026-09-17 至 2026-09-30')
  })

  it('差异明细：未解释排在最前；旧版没有的值写“空”', async () => {
    mountApp({ url, pages, handlers: reportHandlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '迁移核对' }))
    await userEvent.click(await screen.findByRole('button', { name: /查看差异/ }))
    const drawer = await screen.findByTestId('ads-parity-diffs')
    const rows = await within(drawer).findAllByRole('row')
    expect(rows[1]).toHaveTextContent('未解释')
    expect(rows[2]).toHaveTextContent('范围')
    expect(rows[2]).toHaveTextContent('空')
    expect(rows[3]).toHaveTextContent('时区不同导致日期错位')
  })

  it('立即核对：只给能核对的档案；确认后发出手动核对请求', async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url, pages, handlers: reportHandlers({ '/ads/parity/run': (_u, init) => (bodies.push(bodyOf(init)), ok({ syncJobId: 'sj-2' })) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '迁移核对' }))
    expect(await screen.findByRole('button', { name: '立即核对 加拿大账户' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '立即核对 美国账户' }))
    await confirm(/排队核对/)
    await vi.waitFor(() => expect(bodies).toEqual([{ profileId: 'ap-a' }]))
  })
})
