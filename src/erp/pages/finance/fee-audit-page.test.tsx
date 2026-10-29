import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { occurrences, rowTextOf } from '../../test/grid-rows'
import { auditList, auditRow, auditSummary } from './fee-audit-fixtures.test-helper'
import { ok } from './fee-fixtures.test-helper'

// 费用核查页（P2b-06）：4 个页签与疑似数、汇总与口径说明、展开依据（明细、尺寸对比、限制）、没有数据的写法、
// 筛选与游标翻页、转为赔付机会（权限、请求、已转的显示）、尺寸分段变化。

const pages: LivePages = { FeeAuditPage: { load: () => import('./FeeAuditPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/finance/fee-audit': () => ok(auditList()),
  ...over,
})
const PAGE = '/app/finance/fee-audit'

describe('费用核查列表', () => {
  it('4 个页签带疑似数；请求带类别与默认排序；汇总、口径、核查日与新鲜度', { timeout: 30000 }, async () => {
    const app = mountApp({ url: `${PAGE}?storeIds=st1`, pages, handlers: handlers() })
    expect(await screen.findByText('SKU-1', {}, { timeout: 15000 })).toBeInTheDocument()
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['配送费（疑似 1）', '佣金（疑似 0）', '仓储费（疑似 0）', '入仓配置费（疑似 0）'])
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    expect(screen.getByText(/预估配送费报告（R-23）/)).toBeInTheDocument()
    expect(screen.getByText(/参与核查/)).toBeInTheDocument()
    expect(screen.getByText(/当前显示的核查日：2026-10-23/)).toBeInTheDocument()
    const params = new URLSearchParams(app.calls.find(item => item.path === '/finance/fee-audit')!.search)
    expect(params.get('storeIds')).toBe('st1')
    expect(params.get('kind')).toBe('FULFILLMENT')
    expect(params.get('sort')).toBe('overchargeAmount:desc')
    expect(params.get('pageSize')).toBe('100')
    expect(rowTextOf(screen.getByText('SKU-1'))).toContain('疑似多收')
  })

  it('点一行：右侧抽屉里显示依据说明、多收明细、尺寸对比与限制都显示；没有登记尺寸写明原因', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    await userEvent.click(await screen.findByText('SKU-1', {}, { timeout: 15000 }))
    expect(await screen.findByText(/5 行订单按预估配送费核对/)).toBeInTheDocument()
    expect(screen.getByText('111-0000001-0000001')).toBeInTheDocument()
    expect(screen.getByText('没有登记尺寸，无法对比')).toBeInTheDocument()
    expect(screen.getByText(/上次 Small Standard/)).toBeInTheDocument()
    expect(screen.getByText('有 1 行订单缺少数量，未参与核对')).toBeInTheDocument()
  })

  it('没有数据：只写原因，没有示例行，不出现 0 元', { timeout: 30000 }, async () => {
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/fee-audit': () => ok(auditList([], { summary: auditSummary({ FULFILLMENT: { subjects: 0, suspected: 0, occurrences: 0, overcharge: [] } }), sizeTierChanges: [] })),
      }),
    })
    expect(await screen.findByText(/尚无费用核查结果：需要先有预估配送费/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getByText('这一类尚无核查结果')).toBeInTheDocument()
    expect(document.querySelectorAll('[row-id]').length).toBe(0)
    expect(document.body.textContent).not.toContain('$0.00')
    expect(screen.getByText(/最近 14 天没有发现尺寸分段变化/)).toBeInTheDocument()
  })

  it('切换页签换类别并从第一块重取；搜索与状态筛选发给服务端', { timeout: 30000 }, async () => {
    const seen: Array<{ kind: string | null; q: string | null; status: string | null; cursor: string | null }> = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/fee-audit': url => {
          const params = url.searchParams
          seen.push({ kind: params.get('kind'), q: params.get('q'), status: params.get('status'), cursor: params.get('cursor') })
          return ok(auditList([auditRow()]))
        },
      }),
    })
    await screen.findByText('SKU-1', {}, { timeout: 15000 })
    await userEvent.click(screen.getByRole('tab', { name: /仓储费/ }))
    await waitFor(() => expect(seen.some(item => item.kind === 'STORAGE')).toBe(true))
    expect(seen.filter(item => item.kind === 'STORAGE')[0].cursor).toBeNull()
    expect(screen.getByText(/月度仓储费按体积收/)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索费用核查' }), 'SKU-1{Enter}')
    await waitFor(() => expect(seen.some(item => item.q === 'SKU-1')).toBe(true))
  })
})

describe('转为赔付机会', () => {
  it('疑似多收的行有按钮；提交到该行的接口', { timeout: 30000 }, async () => {
    const calls: string[] = []
    mountApp({
      url: PAGE,
      pages,
      handlers: handlers({
        '/finance/fee-audit/fa1/reimbursement': (_url, init) => {
          calls.push(String(init?.method))
          return ok({ id: 'fa1', status: 'APPEALED', opportunityId: 'op1', created: true })
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: '转为赔付机会' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/不代表亚马逊会认可/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /转为机会/ }))
    await waitFor(() => expect(calls).toEqual(['POST']))
  })

  it('没有赔付写权限：服务端不给 canConvert，按钮不出现', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/fee-audit': () => ok(auditList([auditRow()], { canConvert: false })) }, ['finance.read']) })
    await screen.findByText('SKU-1', {}, { timeout: 15000 })
    expect(screen.queryByRole('button', { name: '转为赔付机会' })).not.toBeInTheDocument()
  })

  it('已转过的行：不再有按钮，有读权限时链到赔付中心；正常的行写“无”', { timeout: 30000 }, async () => {
    const appealed = auditRow({ status: 'APPEALED', statusLabel: '已转赔付机会', opportunityId: 'op1' })
    const normal = auditRow({ id: 'fa3', sku: 'SKU-3', subjectKey: 'SKU-3', status: 'NORMAL', statusLabel: '正常', occurrences: 0, overchargeAmount: 0, diffAmount: 0 })
    mountApp({ url: PAGE, pages, handlers: handlers({ '/finance/fee-audit': () => ok(auditList([appealed, normal])) }) })
    await screen.findByText('SKU-1', {}, { timeout: 15000 })
    expect(screen.queryByRole('button', { name: '转为赔付机会' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '在赔付中心跟进' }).getAttribute('href')).toMatch(/^\/app\/reimbursements/)
    expect(rowTextOf(screen.getByText('SKU-3'))).toContain('无')
  })
})

describe('尺寸分段变化', () => {
  it('列出最近变化的 SKU：原分段、现分段与日期', { timeout: 30000 }, async () => {
    mountApp({ url: PAGE, pages, handlers: handlers() })
    const row = rowTextOf(await screen.findByText('SKU-9', {}, { timeout: 15000 }))
    expect(occurrences(row, 'Small Standard')).toBe(1)
    expect(occurrences(row, 'Large Standard')).toBe(1)
    expect(row).toContain('2026-10-22')
  })
})
