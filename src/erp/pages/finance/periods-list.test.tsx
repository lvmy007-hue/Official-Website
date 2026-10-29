import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { occurrences, rowTextOf } from '../../test/grid-rows'
import { ok } from './fee-fixtures.test-helper'
import { listOf, rowOf } from './periods-fixtures.test-helper'

// 期间关账列表（P2b-13）：每个店铺每个月一行，状态、最近检查、关账人与时间；没有就写“尚无记录”“尚未检查”，不写 0；状态筛选发给服务端；创建期间（前端先拦格式，服务端拒绝时在弹窗里显示原因）。

const pages: LivePages = {
  AccountingPeriodsPage: { load: () => import('./AccountingPeriodsPage') },
  AccountingPeriodDetailPage: { load: () => Promise.resolve({ default: () => null }) },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const T = { timeout: 30000 }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/finance/periods': () => ok(listOf()),
  ...over,
})

describe('期间列表', () => {
  it('一行一个期间：月份链接到详情、店铺、日期范围、状态；没检查过写“尚未检查”，没关过账写“尚无记录”；顶部各状态个数', T, async () => {
    const closed = rowOf({
      id: 'p2',
      month: '2026-08',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      status: 'CLOSED',
      statusLabel: '已关账',
      closedBy: '李四',
      closedAt: '2026-09-05T09:00:00.000Z',
      closeCount: 2,
      checkPassed: true,
    })
    const app = mountApp({ url: '/app/finance/periods?storeIds=s1', pages, handlers: handlers({ '/finance/periods': () => ok(listOf([rowOf(), closed])) }) })
    const link = await screen.findByRole('link', { name: '2026-09' }, { timeout: 15000 })
    expect(link.getAttribute('href')).toBe('/app/finance/periods/p1?storeIds=s1')
    expect(screen.getByTestId('period-summary')).toHaveTextContent('开放 1，关账中 1，已关账 2，重新开账 0')
    const open = rowTextOf(link)
    expect(open).toContain('美国主店')
    expect(open).toContain('2026-09-01 ~ 2026-09-30')
    expect(open).toContain('开放')
    expect(open).toContain('尚未检查')
    expect(occurrences(open, '尚无记录')).toBe(2)
    const done = rowTextOf(screen.getByRole('link', { name: '2026-08' }))
    expect(done).toContain('已关账')
    expect(done).toContain('已通过')
    expect(done).toContain('李四')
    const params = new URLSearchParams(app.calls.find(call => call.path === '/finance/periods')!.search)
    expect(params.get('storeIds')).toBe('s1')
    expect(params.get('page')).toBe('1')
    expect(params.get('pageSize')).toBe('50')
  })

  it('没有期间：只写原因，没有示例行', T, async () => {
    mountApp({ url: '/app/finance/periods', pages, handlers: handlers({ '/finance/periods': () => ok(listOf([], { summary: { OPEN: 0, CLOSING: 0, CLOSED: 0, REOPENED: 0 } })) }) })
    expect(await screen.findByText(/尚未创建关账期间/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
  })

  it('状态筛选发给服务端', T, async () => {
    const seen: Array<string | null> = []
    mountApp({
      url: '/app/finance/periods',
      pages,
      handlers: handlers({
        '/finance/periods': url => {
          seen.push(url.searchParams.get('status'))
          return ok(listOf())
        },
      }),
    })
    await screen.findByRole('link', { name: '2026-09' }, { timeout: 15000 })
    await userEvent.click(screen.getByRole('combobox', { name: '状态' }))
    await userEvent.click(await screen.findByTitle('已关账'))
    await waitFor(() => expect(seen).toContain('CLOSED'))
  })
})

describe('创建期间', () => {
  const post = (bodies: Array<Record<string, unknown>>): Record<string, Handler> => ({
    '/finance/periods': (_url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)))
        return { status: 201, body: { success: true, data: { id: 'p9', version: 1, status: 'OPEN', statusLabel: '开放' } } }
      }
      return ok(listOf())
    },
  })
  const openDialog = async () => {
    await screen.findByRole('link', { name: '2026-09' }, { timeout: 15000 })
    await userEvent.click(screen.getByRole('button', { name: '创建期间' }))
    return screen.findByRole('dialog')
  }

  it('选店铺、填月份：请求只带店铺编号与月份', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: '/app/finance/periods', pages, handlers: handlers(post(bodies)) })
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('combobox', { name: '店铺' }))
    await userEvent.click(await screen.findByTitle('加拿大店'))
    await userEvent.type(within(dialog).getByLabelText('月份'), '2026-10')
    await userEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => expect(bodies).toEqual([{ sellerAccountId: 's2', month: '2026-10' }]))
  })

  it('月份格式不对或没选店铺：前端拦下，不发请求', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    mountApp({ url: '/app/finance/periods', pages, handlers: handlers(post(bodies)) })
    const dialog = await openDialog()
    await userEvent.type(within(dialog).getByLabelText('月份'), '2026-13')
    await userEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }))
    expect(await within(dialog).findByText('月份格式应为 YYYY-MM（年-月）')).toBeInTheDocument()
    expect(within(dialog).getByText('请选择店铺')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
  })

  it('服务端拒绝（该月已有期间）：弹窗里显示原因，不关闭', T, async () => {
    mountApp({
      url: '/app/finance/periods',
      pages,
      handlers: handlers({
        '/finance/periods': (_url, init) => (init?.method === 'POST' ? { status: 409, body: { error: { code: 'CONFLICT', message: '该店铺这个月已经有关账期间' } } } : ok(listOf())),
      }),
    })
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('combobox', { name: '店铺' }))
    await userEvent.click(await screen.findByTitle('美国主店'))
    await userEvent.type(within(dialog).getByLabelText('月份'), '2026-09')
    await userEvent.click(within(dialog).getByRole('button', { name: /创\s*建/ }))
    expect(await within(dialog).findByText(/已经有关账期间/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('没有创建权限：按钮禁用', T, async () => {
    mountApp({ url: '/app/finance/periods', pages, handlers: handlers({ '/finance/periods': () => ok(listOf([rowOf()], { canCreate: false })) }) })
    await screen.findByRole('link', { name: '2026-09' }, { timeout: 15000 })
    expect(screen.getByRole('button', { name: '创建期间' })).toBeDisabled()
  })
})
