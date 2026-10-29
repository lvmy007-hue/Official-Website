import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, reportDetail, reportList, reportRow } from './reports-fixtures.test-helper'

// 报表中心列表与详情（P5-03）：没有数据的写法、业务域与状态条数、取消/重试/下载动作的前置条件、创建表单按数据周期出现日期框、详情的时间线与统计。

const pages: LivePages = {
  ReportCenterPage: { load: () => import('./ReportCenterPage') },
  ReportJobDetailPage: { load: () => import('./ReportJobDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['*'] }),
  '/reports': () => ok(reportList()),
  '/reports/r1': () => ok(reportDetail()),
  ...over,
})
const T = { timeout: 30000 }
const W = { timeout: 15000 }

describe('报表中心列表', () => {
  it('列出任务：状态、文件、解析、导入行数、保留期、申请条件、创建人；业务域与状态带条数', T, async () => {
    const items = [
      reportRow(),
      reportRow({
        id: 'r2',
        label: '库存规划报告',
        status: 'FAILED',
        fileState: 'NONE',
        parseState: 'NOT_STARTED',
        importedRows: null,
        retentionUntil: null,
        failureCode: 'FATAL',
        failureText: '亚马逊侧生成报告失败',
        canRetry: true,
        canDownload: false,
        createdByName: null,
        analysisPath: null,
      }),
    ]
    mountApp({ url: '/app/reports', pages, handlers: handlers({ '/reports': () => ok(reportList(items)) }) })
    expect(await screen.findByText('库存规划报告', {}, W)).toBeInTheDocument()
    const failed = screen.getByText('库存规划报告').closest('tr, [role=row]') as HTMLElement
    expect(within(failed).getByText('失败')).toBeInTheDocument()
    expect(within(failed).getByText(/亚马逊侧生成报告失败（FATAL）/)).toBeInTheDocument()
    expect(within(failed).getByText('尚无统计')).toBeInTheDocument()
    expect(within(failed).getByText('没有留存')).toBeInTheDocument()
    expect(within(failed).getByText('系统')).toBeInTheDocument()
    expect(within(failed).getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
    expect(within(failed).getByRole('button', { name: '下载原始文件' })).toBeDisabled()
    const done = screen.getByText('客户退货报告').closest('tr, [role=row]') as HTMLElement
    expect(within(done).getByText('已留存')).toBeInTheDocument()
    expect(within(done).getByText('118')).toBeInTheDocument()
    expect(within(done).getByText('2027-01-20')).toBeInTheDocument()
    expect(within(done).getByText('王运营')).toBeInTheDocument()
    expect(within(done).getByText('所需角色：Amazon Fulfillment')).toBeInTheDocument()
    expect(within(done).getByRole('button', { name: '下载原始文件' })).toBeEnabled()
    expect(within(done).getByText('去分析页')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '亚马逊物流（2）' })).toBeInTheDocument()
    expect(within(screen.getByTestId('status-chips')).getByText(/^失败（1）$/)).toBeInTheDocument()
  })

  it('没有任何任务：写“尚无记录”，不写 0 行的假表格', T, async () => {
    mountApp({ url: '/app/reports', pages, handlers: handlers({ '/reports': () => ok(reportList([])) }) })
    expect(await screen.findByText(/尚无记录：还没有创建过报告/, {}, W)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('切换业务域与状态时带上 domain、status 参数', T, async () => {
    const app = mountApp({ url: '/app/reports', pages, handlers: handlers() })
    expect(await screen.findByText('客户退货报告', {}, W)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /^亚马逊物流/ }))
    await waitFor(() => expect(app.calls.some(call => call.path === '/reports' && new URLSearchParams(call.search).get('domain') === 'LOGISTICS')).toBe(true))
    await userEvent.click(within(screen.getByTestId('status-chips')).getByText(/^已完成/))
    await waitFor(() => expect(app.calls.some(call => call.path === '/reports' && new URLSearchParams(call.search).get('status') === 'READY')).toBe(true))
  })

  it('读取窗口被截断：提示缩小范围', T, async () => {
    mountApp({ url: '/app/reports', pages, handlers: handlers({ '/reports': () => ok(reportList([reportRow()], { truncated: true })) }) })
    expect(await screen.findByText(/更早的任务没有合并进列表/, {}, W)).toBeInTheDocument()
  })

  it('取消：先确认，确认后向服务端发 POST', T, async () => {
    const calls: string[] = []
    const items = [
      reportRow({
        id: 'r3',
        label: '库存报告（全部）',
        status: 'GENERATING',
        parseState: 'NOT_STARTED',
        fileState: 'NONE',
        canCancel: true,
        canDownload: false,
        importedRows: null,
        retentionUntil: null,
      }),
    ]
    mountApp({
      url: '/app/reports',
      pages,
      handlers: handlers({
        '/reports': () => ok(reportList(items)),
        '/reports/r3/cancel': (_u, init) => (calls.push(init?.method ?? ''), ok({})),
      }),
    })
    const row = (await screen.findByText('库存报告（全部）', {}, W)).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: /取\s*消/ }))
    await userEvent.click(await screen.findByRole('button', { name: '确认取消' }))
    await waitFor(() => expect(calls).toEqual(['POST']))
  })

  it('只读成员：创建、取消、重试都是禁用的，下载仍可用', T, async () => {
    const items = [reportRow({ status: 'FAILED', canRetry: true, canCancel: false })]
    mountApp({
      url: '/app/reports',
      pages,
      handlers: handlers({ '/auth/me': () => ok({ ...defaultMe, permissions: ['reports.read'] }), '/reports': () => ok(reportList(items)) }),
    })
    const row = (await screen.findByText('客户退货报告', {}, W)).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: /重\s*试/ })).toBeDisabled()
    expect(within(row).getByRole('button', { name: '下载原始文件' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /创建报告/ })).toBeDisabled()
  })

  it('创建：快照类型不出现日期框；起止日期类型出现，请求体与服务端一致', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({
      url: '/app/reports',
      pages,
      handlers: handlers({
        '/reports': (_u, init) => (init?.method === 'POST' ? (bodies.push(JSON.parse(String(init.body))), ok({ report: reportRow({ id: 'r9' }), syncJobId: 'sj9' })) : ok(reportList())),
      }),
    })
    await screen.findByText('客户退货报告', {}, W)
    await userEvent.click(await screen.findByRole('button', { name: /创建报告/ }))
    const dialog = within(await screen.findByRole('dialog'))
    const combo = dialog.getByRole('combobox', { name: '报告类型' })
    await userEvent.click(combo)
    await userEvent.type(combo, '库存规划')
    await userEvent.click(await screen.findByTitle('库存规划报告'))
    expect(await dialog.findByText(/当前快照/)).toBeInTheDocument()
    expect(dialog.queryByLabelText('开始日期')).toBeNull()
    await userEvent.click(combo)
    await userEvent.type(combo, '{Control>}a{/Control}客户退货')
    await userEvent.click(await screen.findByTitle('客户退货报告'))
    fireEvent.change(await dialog.findByLabelText('开始日期'), { target: { value: '2026-10-01' } })
    fireEvent.change(dialog.getByLabelText('结束日期'), { target: { value: '2026-10-07' } })
    await userEvent.click(screen.getByRole('button', { name: /^(确\s*认|提\s*交|创\s*建|确\s*定)$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', from: '2026-10-01', to: '2026-10-07' })
  })
})

describe('报告任务详情', () => {
  it('身份区、请求参数、关联同步任务、亚马逊侧时间线与本系统过程分开显示', T, async () => {
    mountApp({ url: '/app/reports/r1', pages, handlers: handlers() })
    expect(await screen.findByText('报告任务：客户退货报告', {}, W)).toBeInTheDocument()
    const request = screen.getByTestId('report-request')
    expect(within(request).getByText('ext-1')).toBeInTheDocument()
    expect(within(request).getByText('ATVPDKIKX0DER')).toBeInTheDocument()
    expect(within(screen.getByTestId('sync-job')).getByText('FBA_REPORT_CREATE')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '时间线' }))
    const amazon = await screen.findByTestId('amazon-timeline')
    expect(within(amazon).getByText('已向亚马逊申请')).toBeInTheDocument()
    expect(within(amazon).queryByText('导入完成')).toBeNull()
    expect(within(screen.getByTestId('local-timeline')).getByText('导入完成')).toBeInTheDocument()
  })

  it('导入统计：新增与更新写“未区分”；没有警告时说明检测范围；有警告逐条列出', T, async () => {
    const detail = reportDetail({
      warnings: [{ code: 'NEW_COLUMN', message: '新出现的字段：extra-col' }],
      stats: { read: null, imported: 118, skipped: null, ignored: null, added: null, updated: null, failed: null },
    })
    mountApp({ url: '/app/reports/r1', pages, handlers: handlers({ '/reports/r1': () => ok(detail) }) })
    await screen.findByText('报告任务：客户退货报告', {}, W)
    await userEvent.click(screen.getByRole('tab', { name: '导入统计与警告' }))
    const stats = await screen.findByTestId('report-stats')
    expect(within(stats).getByText(/未区分/)).toBeInTheDocument()
    expect(within(stats).getAllByText('尚无统计').length).toBeGreaterThan(0)
    expect(within(screen.getByTestId('report-warnings')).getByText('新出现的字段：extra-col')).toBeInTheDocument()
  })

  it('广告任务：没有亚马逊侧时间线时写明原因，说明文字原样显示', T, async () => {
    const detail = reportDetail({
      report: reportRow({ id: 'a1', source: 'ADS', domain: 'ADS', fileState: 'NOT_APPLICABLE', canDownload: false }),
      timeline: [{ at: '2026-10-20T02:00:00.000Z', stage: 'REQUESTED', label: '已创建任务', side: 'LOCAL' }],
      syncJob: null,
      notes: ['广告报告没有逐阶段的亚马逊侧状态记录'],
    })
    mountApp({ url: '/app/reports/a1', pages, handlers: handlers({ '/reports/a1': () => ok(detail) }) })
    expect(await screen.findByTestId('report-note', {}, W)).toHaveTextContent('没有逐阶段的亚马逊侧状态记录')
    expect(within(screen.getByTestId('sync-job')).getByText(/没有关联的同步任务/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '时间线' }))
    expect(await screen.findByText(/尚无亚马逊侧状态/)).toBeInTheDocument()
  })

  it('任务不存在：显示服务端的错误，不渲染空详情', T, async () => {
    mountApp({ url: '/app/reports/zz', pages, handlers: handlers({ '/reports/zz': () => ({ status: 404, body: { error: { code: 'REPORT_NOT_FOUND', message: '找不到这个报告任务' } } }) }) })
    expect(await screen.findByText(/找不到这个报告任务/, {}, W)).toBeInTheDocument()
  })
})
