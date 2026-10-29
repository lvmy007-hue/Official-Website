import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { failedRow, ok, queuesResponse, rateLimitsResponse, syncDetail, syncList, syncRow } from './sync-fixtures.test-helper'

// 同步中心（P5-06）：任务列表（状态、尝试次数、日志摘要、失败原因、重试）、数据域概况、队列监控、限速状态、任务详情。
// 没有数据的写法：尚无记录 / 尚未接入 / 尚无统计，任何时候都不拿 0 冒充。

const pages: LivePages = {
  SyncCenterPage: { load: () => import('./SyncCenterPage') },
  SyncJobDetailPage: { load: () => import('./SyncJobDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['*'] }),
  '/sync/jobs': () => ok(syncList([syncRow(), failedRow()])),
  '/sync/jobs/j2': () => ok(syncDetail()),
  '/sync/queues': () => ok(queuesResponse()),
  '/sync/rate-limits': () => ok(rateLimitsResponse()),
  ...over,
})
const T = { timeout: 30000 }
const W = { timeout: 15000 }
const paramOf = (search: string, key: string) => new URLSearchParams(search).get(key)

describe('同步中心：任务列表', () => {
  it('每行一个真实任务：状态、尝试次数、请求编号、日志摘要、失败原因；失败的可以重试，成功的不能', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers() })
    const failed = (await screen.findByText('库存同步', {}, W)).closest('[role=row]') as HTMLElement
    expect(within(failed).getByText('失败')).toBeInTheDocument()
    expect(within(failed).getByText('5 / 5')).toBeInTheDocument()
    expect(within(failed).getByText('req-2')).toBeInTheDocument()
    expect(within(failed).getAllByText(/亚马逊授权已过期，请重新授权/).length).toBeGreaterThan(0)
    expect(within(failed).getByText(/AUTH_EXPIRED/)).toBeInTheDocument()
    expect(within(failed).getByText('已进入失败任务')).toBeInTheDocument()
    expect(within(failed).getByRole('button', { name: /重\s*试/ })).toBeEnabled()
    const done = screen.getByText('订单同步').closest('[role=row]') as HTMLElement
    expect(within(done).getByText('已完成')).toBeInTheDocument()
    expect(within(done).getByText('1 / 1')).toBeInTheDocument()
    expect(within(done).getByText('执行完成')).toBeInTheDocument()
    expect(within(done).getByRole('button', { name: /重\s*试/ })).toBeDisabled()
    expect(within(screen.getByTestId('state-chips')).getByText(/^失败（1）$/)).toBeInTheDocument()
    expect(within(screen.getByTestId('state-chips')).getByText(/^已完成（1）$/)).toBeInTheDocument()
  })

  it('还没有执行过的任务写“尚未执行”，没有进度写“尚无进度”，没有日志写“尚无记录”', T, async () => {
    const queued = syncRow({
      id: 'j3',
      typeLabel: '定价与购物车同步',
      state: 'QUEUED',
      status: 'PENDING',
      attempts: 0,
      progressCurrent: 0,
      progressTotal: 0,
      logSummary: null,
      startedAt: null,
      finishedAt: null,
    })
    mountApp({ url: '/app/sync', pages, handlers: handlers({ '/sync/jobs': () => ok(syncList([queued])) }) })
    const row = (await screen.findByText('定价与购物车同步', {}, W)).closest('[role=row]') as HTMLElement
    expect(within(row).getByText('排队中')).toBeInTheDocument()
    expect(within(row).getByText('尚未执行')).toBeInTheDocument()
    expect(within(row).getByText('尚无进度')).toBeInTheDocument()
    expect(within(row).getByText('尚无记录')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /重\s*试/ })).toBeDisabled()
  })

  it('没有任何任务：写“尚无记录”，不写 0 行的假表格', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers({ '/sync/jobs': () => ok(syncList([])) }) })
    expect(await screen.findByText(/尚无记录：还没有同步任务/, {}, W)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('数据域概况：19 个数据域齐全；没交付的写“尚未接入”，没有任务的写“尚无记录”，有任务的写近 24 小时成败', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers() })
    const cards = await screen.findByTestId('domain-cards', {}, W)
    expect(within(cards).getAllByRole('button')).toHaveLength(19)
    const stream = within(cards).getByRole('button', { name: '数据域 营销数据流' })
    expect(within(stream).getByText('尚未接入', { selector: '.ant-tag' })).toBeInTheDocument()
    expect(within(stream).getByText(/接收端建成前没有同步任务/)).toBeInTheDocument()
    const ads = within(cards).getByRole('button', { name: '数据域 广告实体' })
    // 广告实体与报表的落库同步器已交付（P5-12A）：不再标“部分接入”，没有任务就写“尚无记录”
    expect(within(ads).queryByText('部分接入')).not.toBeInTheDocument()
    expect(within(ads).queryByText('尚未接入')).not.toBeInTheDocument()
    expect(within(ads).getByText('尚无记录')).toBeInTheDocument()
    expect(within(within(cards).getByRole('button', { name: '数据域 广告报表' })).getByText('尚无记录')).toBeInTheDocument()
    expect(within(within(cards).getByRole('button', { name: '数据域 上游仓储' })).getByText('尚无记录')).toBeInTheDocument()
    const orders = within(cards).getByRole('button', { name: '数据域 订单' })
    expect(within(orders).getByText(/成功 1 · 失败 0 · 进行中 0/)).toBeInTheDocument()
    expect(within(within(cards).getByRole('button', { name: '数据域 库存' })).getByText('亚马逊授权已过期，请重新授权')).toBeInTheDocument()
  })

  it('点数据域卡片、状态、搜索时带上 domain、state、q 参数；再点一次卡片取消筛选', T, async () => {
    const app = mountApp({ url: '/app/sync', pages, handlers: handlers() })
    const cards = await screen.findByTestId('domain-cards', {}, W)
    await userEvent.click(within(cards).getByRole('button', { name: '数据域 订单' }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/sync/jobs' && paramOf(call.search, 'domain') === 'ORDERS')).toBe(true))
    await userEvent.click(within(screen.getByTestId('state-chips')).getByText(/^失败/))
    await waitFor(() => expect(app.calls.some(call => call.path === '/sync/jobs' && paramOf(call.search, 'state') === 'FAILED' && paramOf(call.search, 'domain') === 'ORDERS')).toBe(true))
    await userEvent.type(screen.getByLabelText('搜索任务'), 'req-2{enter}')
    await waitFor(() => expect(app.calls.some(call => call.path === '/sync/jobs' && paramOf(call.search, 'q') === 'req-2')).toBe(true))
    await userEvent.click(within(screen.getByTestId('domain-cards')).getByRole('button', { name: '数据域 订单' }))
    await waitFor(() => expect(app.calls.filter(call => call.path === '/sync/jobs').slice(-1)[0]!.search).not.toContain('domain='))
  })

  it('重试：先确认，确认后向服务端发 POST；写入类任务的确认框提醒会重新提交写入', T, async () => {
    const calls: string[] = []
    const write = failedRow({ id: 'j9', typeLabel: '刊登与价格写入', type: 'LISTING_WRITE', writeType: true })
    mountApp({
      url: '/app/sync',
      pages,
      handlers: handlers({
        '/sync/jobs': () => ok(syncList([write])),
        '/sync/jobs/j9/retry': (_url, init) => (calls.push(init?.method ?? ''), ok({})),
      }),
    })
    const row = (await screen.findByText('刊登与价格写入', {}, W)).closest('[role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: /重\s*试/ }))
    expect(await screen.findByText(/重新提交一次写入/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '确认重试' }))
    await waitFor(() => expect(calls).toEqual(['POST']))
  })

  it('只读成员：重试是禁用的，仍能看到全部信息', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers({ '/auth/me': () => ok({ ...defaultMe, permissions: ['sync.read'] }) }) })
    const row = (await screen.findByText('库存同步', {}, W)).closest('[role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: /重\s*试/ })).toBeDisabled()
    expect(within(row).getByText('req-2')).toBeInTheDocument()
  })
})

describe('同步中心：队列监控与限速状态', () => {
  it('队列监控：积压与本企业占用、近 1 小时吞吐；不适用的队列写“不适用”；并发槽位', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '队列监控' }, W))
    const orders = (await screen.findByText('订单同步', { selector: '.ag-cell div' }, W)).closest('[role=row]') as HTMLElement
    expect(within(orders).getByText('6')).toBeInTheDocument()
    expect(within(orders).getByText('20')).toBeInTheDocument()
    expect(within(orders).getByText('50%')).toBeInTheDocument()
    const exportsRow = screen.getByText('导出').closest('[role=row]') as HTMLElement
    expect(within(exportsRow).getAllByText('不适用').length).toBe(4)
    expect(screen.getByTestId('concurrency')).toHaveTextContent('1 / 2')
    expect(screen.getByText(/积压数是整个平台的合计/)).toBeInTheDocument()
  })

  it('队列读不到：如实提示，不画一张全是 0 的表', T, async () => {
    mountApp({
      url: '/app/sync',
      pages,
      handlers: handlers({ '/sync/queues': () => ok(queuesResponse({ state: 'UNAVAILABLE', note: '队列服务暂时读不到：后台任务不受影响，稍后刷新再看', queues: [], concurrency: null })) }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '队列监控' }, W))
    expect(await screen.findByTestId('queues-unavailable', {}, W)).toHaveTextContent('暂时读不到')
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('限速状态：剩余令牌、速率、冻结与最近限速；没有限速过写“尚无记录”', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '限速状态' }, W))
    const orders = (await screen.findByText('orders', {}, W)).closest('[role=row]') as HTMLElement
    expect(within(orders).getByText('1.5 / 2')).toBeInTheDocument()
    expect(within(orders).getByText('0.5 次/秒')).toBeInTheDocument()
    expect(within(orders).getByText('正常')).toBeInTheDocument()
    expect(within(orders).getByText('尚无记录', { selector: 'span' })).toBeInTheDocument()
    const finance = screen.getByText('finance').closest('[role=row]') as HTMLElement
    expect(within(finance).getByText(/限速冻结至/)).toBeInTheDocument()
  })

  it('没有令牌桶：写“尚无记录”；缓存读不到：提示且不画表', T, async () => {
    mountApp({ url: '/app/sync', pages, handlers: handlers({ '/sync/rate-limits': () => ok(rateLimitsResponse({ state: 'NO_DATA', note: '尚无记录：近一小时没有向亚马逊发起过请求', items: [] })) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '限速状态' }, W))
    expect(await screen.findByText(/尚无记录：近一小时没有向亚马逊发起过请求/, {}, W)).toBeInTheDocument()
  })

  it('限速状态读不到：如实提示', T, async () => {
    mountApp({
      url: '/app/sync',
      pages,
      handlers: handlers({ '/sync/rate-limits': () => ok(rateLimitsResponse({ state: 'UNAVAILABLE', note: '限速状态暂时读不到：后台任务不受影响，稍后刷新再看', items: [] })) }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '限速状态' }, W))
    expect(await screen.findByTestId('rate-unavailable', {}, W)).toHaveTextContent('暂时读不到')
  })
})

describe('同步任务详情', () => {
  it('参数、时间线（中文失败原因）、流程分步、错误详情与死信', T, async () => {
    mountApp({ url: '/app/sync/j2', pages, handlers: handlers() })
    expect(await screen.findByText('同步任务：库存同步', {}, W)).toBeInTheDocument()
    const params = await screen.findByTestId('sync-params', {}, W)
    expect(within(params).getByText('ATVPDKIKX0DER')).toBeInTheDocument()
    expect(within(params).getByText('已保存（重试时从断点继续）')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '时间线与分步' }))
    const timeline = await screen.findByTestId('sync-timeline')
    expect(within(timeline).getByText('开始执行')).toBeInTheDocument()
    expect(within(timeline).getByText('任务失败')).toBeInTheDocument()
    expect(within(timeline).getByText(/第 1\/5 次尝试失败/)).toBeInTheDocument()
    expect(within(screen.getByTestId('sync-workflows')).getByText('fetch-inventory')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '错误详情' }))
    const error = await screen.findByTestId('sync-error')
    expect(within(error).getByText(/已进入失败任务：队列 sync-inventory，用尽 5 次尝试/)).toBeInTheDocument()
    expect(within(error).getByText(/AUTHORIZED/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeEnabled()
  })

  it('没有统计写“尚无统计”，没有关联报告写明原因；旧任务的说明条幅', T, async () => {
    mountApp({ url: '/app/sync/j2', pages, handlers: handlers({ '/sync/jobs/j2': () => ok(syncDetail({ timeline: [], notes: ['该任务没有过程记录：创建于功能上线之前，或还没有开始执行。'] })) }) })
    expect(await screen.findByText(/该任务没有过程记录/, {}, W)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '时间线与分步' }))
    expect(await screen.findByText(/尚无记录：任务还没有开始执行/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '写入统计' }))
    expect(await screen.findByText(/尚无统计/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '关联报告任务' }))
    expect(await screen.findByText(/没有关联的报告任务/)).toBeInTheDocument()
  })

  it('写入统计与关联报告任务：有就列出，报告任务带链接地址', T, async () => {
    const detail = syncDetail({
      job: syncRow({ id: 'j5', type: 'FBA_REPORT_CREATE', typeLabel: '亚马逊报告申请', state: 'SUCCEEDED' }),
      stats: [{ key: 'imported', label: '导入行数', value: 1234 }],
      reports: [{ id: 'r9', kind: 'SP_API', label: '客户退货报告', status: 'READY', path: '/app/reports/r9' }],
      deadLetter: null,
    })
    mountApp({ url: '/app/sync/j5', pages, handlers: handlers({ '/sync/jobs/j5': () => ok(detail) }) })
    expect(await screen.findByText('同步任务：亚马逊报告申请', {}, W)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '写入统计' }))
    expect(within(await screen.findByTestId('sync-stats')).getByText('1,234')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '关联报告任务' }))
    expect(await screen.findByText('客户退货报告')).toBeInTheDocument()
  })

  it('找不到任务：显示服务端给的原因', T, async () => {
    mountApp({ url: '/app/sync/zz', pages, handlers: handlers({ '/sync/jobs/zz': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '同步任务不存在或无权访问' } } }) }) })
    expect(await screen.findByText(/同步任务不存在或无权访问/, {}, W)).toBeInTheDocument()
  })
})
