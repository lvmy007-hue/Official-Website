import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { contact, supportCaseRow } from '../support/support-fixtures.test-helper'
import { caseList, caseRow, detail, ok, oppList, oppRow, stats } from './reimbursements-fixtures.test-helper'

// 赔付中心与案件详情（P2b-03）：6 个页签、机会与案件列表、没有数据的写法、生成案件与忽略、状态流转、
// 不能手工标已到账或手填实收、时限设置的默认值提示、证据包与匹配明细。

const pages: LivePages = {
  ReimbursementsPage: { load: () => import('./ReimbursementsPage') },
  ReimbursementDetailPage: { load: () => import('./ReimbursementDetailPage') },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/reimbursements/opportunities': () => ok(oppList()),
  '/reimbursements/stats': () => ok(stats()),
  '/reimbursements': () => ok(caseList()),
  '/reimbursements/c1': () => ok(detail()),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('赔付中心', () => {
  it('有 6 个页签；机会列表带范围参数与新鲜度；没有商品成本的机会写“无商品成本，无法估算”', { timeout: 30000 }, async () => {
    const app = mountApp({
      url: '/app/reimbursements?storeIds=st1',
      pages,
      handlers: handlers({ '/reimbursements/opportunities': () => ok(oppList([oppRow(), oppRow({ id: 'o2', sku: 'SKU-2', estimatedAmount: null, currency: null })])) }),
    })
    expect(await screen.findByText('SKU-2', {}, { timeout: 15000 })).toBeInTheDocument()
    for (const label of ['赔付机会', '待提交', '处理中', '已到账', '已拒绝', '全部案件']) expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    expect(screen.getByTestId('freshness-bar')).toBeInTheDocument()
    const call = app.calls.find(item => item.path === '/reimbursements/opportunities')!
    expect(new URLSearchParams(call.search).get('storeIds')).toBe('st1')
    expect(screen.getByText('无商品成本，无法估算')).toBeInTheDocument()
    expect(screen.getAllByText('库存台账 2026-08-01 丢失 3 件', { exact: false }).length).toBe(2)
  })

  it('没有机会：只写原因，没有示例行', async () => {
    mountApp({ url: '/app/reimbursements', pages, handlers: handlers({ '/reimbursements/opportunities': () => ok(oppList([])) }) })
    expect(await screen.findByText(/目前没有待处理的赔付机会/)).toBeInTheDocument()
    expect(document.querySelectorAll('table tbody tr.ant-table-row').length).toBe(0)
  })

  it('生成案件：带机会编号与填写的金额；已有案件的机会显示案件编号链接而不是按钮', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/reimbursements',
      pages,
      handlers: handlers({
        '/reimbursements': (_url, init) => {
          if (init?.method === 'POST') {
            bodies.push(JSON.parse(String(init.body)))
            return ok({ id: 'c9', caseNo: 'PC-1', version: 1 })
          }
          return ok(caseList())
        },
        '/reimbursements/opportunities': () =>
          ok(oppList([oppRow(), oppRow({ id: 'o3', sku: 'SKU-3', status: 'CASE_CREATED', statusLabel: '已生成案件', caseId: 'c3', caseNo: 'PC-20261023-ZZZZZ' })])),
      }),
    })
    const row = (await screen.findByText('SKU-1', {}, { timeout: 15000 })).closest('tr, [role=row]') as HTMLElement
    expect(screen.getByRole('link', { name: 'PC-20261023-ZZZZZ' })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: '生成案件' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '生成案件' }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({ opportunityId: 'o1', expectedAmount: 15, currency: 'USD' })
  })

  it('忽略必须填原因，请求带版本号', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/reimbursements',
      pages,
      handlers: handlers({
        '/reimbursements/opportunities/o1/ignore': (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)))
          return ok({ id: 'o1', version: 2 })
        },
      }),
    })
    const row = (await screen.findByText('SKU-1', {}, { timeout: 15000 })).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: '忽略' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /忽\s*略/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies.length).toBe(0)
    await userEvent.type(within(dialog).getByRole('textbox'), '已线下沟通')
    await userEvent.click(within(dialog).getByRole('button', { name: /忽\s*略/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({ version: 1, reason: '已线下沟通' })
  })

  it('案件列表：实收为 0 写“尚无到账”，应收没填写“尚未填写”，没回填编号写“尚未回填”，案件编号链到详情', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/reimbursements', pages, handlers: handlers({ '/reimbursements': () => ok(caseList([caseRow({ expectedAmount: null, currency: null })])) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '待提交' }, { timeout: 15000 }))
    const link = await screen.findByRole('link', { name: 'PC-20261023-ABCDE' })
    expect(link.getAttribute('href')).toMatch(/^\/app\/reimbursements\/c1(\?|$)/)
    const tr = link.closest('tr, [role=row]') as HTMLElement
    expect(within(tr).getByText('尚无到账')).toBeInTheDocument()
    expect(within(tr).getByText('尚未填写')).toBeInTheDocument()
    expect(within(tr).getByText('尚未回填')).toBeInTheDocument()
  })

  it('页签把状态分组交给服务端；没有案件时写原因', async () => {
    const tabs: Array<string | null> = []
    mountApp({
      url: '/app/reimbursements',
      pages,
      handlers: handlers({
        '/reimbursements': url => {
          tabs.push(url.searchParams.get('tab'))
          return ok(caseList([]))
        },
      }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '已到账' }, { timeout: 15000 }))
    expect(await screen.findByText(/还没有已到账的案件/)).toBeInTheDocument()
    expect(tabs).toContain('paid')
  })

  it('回收率没有已提交案件时写原因；成功率没有结论写“尚无有结论的案件”；费用多收写尚未接入；默认时限有提示', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/reimbursements', pages, handlers: handlers() })
    await userEvent.click(await screen.findByText('回收率与成功率', {}, { timeout: 15000 }))
    expect(await screen.findByText(/还没有已提交且填了应收金额的案件/)).toBeInTheDocument()
    expect(screen.getAllByText('尚无有结论的案件').length).toBeGreaterThan(0)
    expect(screen.getByText('费用多收（尚未接入）')).toBeInTheDocument()
    expect(screen.getByText('尚无已到账案件')).toBeInTheDocument()
    await userEvent.click(screen.getByText('机会时限设置'))
    expect(await screen.findByText(/当前使用系统默认时限/)).toBeInTheDocument()
  })

  it('有回收数据时按币种显示回收率；未归属赔付给出提示', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/reimbursements',
      pages,
      handlers: handlers({
        '/reimbursements/stats': () =>
          ok(
            stats({
              recovery: [{ currency: 'USD', expected: 100, received: 80, recoveryRate: 0.8, caseCount: 2 }],
              unmatched: { count: 2, byCurrency: [{ currency: 'USD', amount: 30 }] },
              avgPayDays: 12.5,
              paidSample: 2,
            }),
          ),
      }),
    })
    await userEvent.click(await screen.findByText('回收率与成功率', {}, { timeout: 15000 }))
    expect(await screen.findByText('80.0%')).toBeInTheDocument()
    expect(screen.getByText(/有 2 笔官方赔付明细没有对应案件/)).toBeInTheDocument()
    expect(screen.getByText('12.5 天（2 个案件）')).toBeInTheDocument()
  })

  it('没有写入权限：生成案件与忽略按钮禁用', async () => {
    mountApp({ url: '/app/reimbursements', pages, handlers: handlers({}, ['reimbursements.read']) })
    const row = (await screen.findByText('SKU-1', {}, { timeout: 15000 })).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: '生成案件' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: '忽略' })).toBeDisabled()
  })
})

describe('赔付案件详情', () => {
  it('身份区、步骤、识别依据、证据引用；未回填案件编号与亚马逊支持案件“尚未接入”；金额没有数据不写 0', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/reimbursements/c1', pages, handlers: handlers() })
    expect(await screen.findByText('赔付案件 PC-20261023-ABCDE', {}, { timeout: 15000 })).toBeInTheDocument()
    const overview = screen.getByTestId('case-overview')
    expect(within(overview).getByText('尚未回填')).toBeInTheDocument()
    expect(within(overview).getByText(/库存台账出现“丢失”调整/)).toBeInTheDocument()
    expect(within(overview).getByText(/这个赔付案件还没有回填亚马逊案件编号/)).toBeInTheDocument()
    expect(screen.getAllByText('尚无到账').length).toBeGreaterThan(0)
    expect(screen.getByText('待提交', { selector: '.ant-steps-item-title' })).toBeInTheDocument()
  })

  it('回填了案件编号且支持案件已同步：概览里显示案件、状态与最近沟通', { timeout: 30000 }, async () => {
    const view = { state: 'OK' as const, case: supportCaseRow({ reimbursementCaseId: 'c1', reimbursementCaseNo: 'PC-20261023-ABCDE' }), contacts: [contact()] }
    mountApp({ url: '/app/reimbursements/c1', pages, handlers: handlers({ '/reimbursements/c1': () => ok(detail({ supportCases: view })) }) })
    const link = await screen.findByTestId('support-link', {}, { timeout: 15000 })
    expect(within(link).getByText('123456789')).toBeInTheDocument()
    expect(within(link).getByText('等待亚马逊处理')).toBeInTheDocument()
    expect(within(link).getByText('请补充入库证据')).toBeInTheDocument()
  })

  it('更新状态只能选服务端给的状态，不含已到账；提交带版本号', { timeout: 30000 }, async () => {
    const bodies: unknown[] = []
    mountApp({
      url: '/app/reimbursements/c1',
      pages,
      handlers: handlers({
        '/reimbursements/c1': (_url, init) => {
          if (init?.method === 'PATCH') {
            bodies.push(JSON.parse(String(init.body)))
            return ok({ id: 'c1', version: 4, status: 'SUBMITTED' })
          }
          return ok(detail())
        },
      }),
    })
    await userEvent.click(await screen.findByRole('button', { name: '更新状态' }, { timeout: 15000 }))
    await userEvent.click(await screen.findByRole('combobox', { name: '改为' }))
    expect(screen.queryByText('已到账', { selector: '.ant-select-item-option-content' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByText('已提交', { selector: '.ant-select-item-option-content' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /更\s*新/ }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({ version: 3, status: 'SUBMITTED' })
  })

  it('已到账的案件：更新状态与修改金额都禁用，没有手填实收的入口', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/reimbursements/c1',
      pages,
      handlers: handlers({ '/reimbursements/c1': () => ok(detail({ case: caseRow({ status: 'PAID', statusLabel: '已到账', receivedAmount: 15, approvedAmount: 15 }), nextStatuses: [] })) }),
    })
    expect(await screen.findByRole('button', { name: '更新状态' }, { timeout: 15000 })).toBeDisabled()
    expect(screen.getByRole('button', { name: '修改应收与备注' })).toBeDisabled()
    expect(screen.queryByText(/手填实收/)).not.toBeInTheDocument()
  })

  it('官方赔付匹配：有明细显示匹配依据；没有明细写原因', { timeout: 30000 }, async () => {
    mountApp({
      url: '/app/reimbursements/c1',
      pages,
      handlers: handlers({
        '/reimbursements/c1': () =>
          ok(
            detail({
              records: [
                {
                  id: 'r1',
                  reimbursementId: 'R100',
                  sku: 'SKU-1',
                  reason: 'Lost_Warehouse',
                  quantity: 3,
                  amount: 15,
                  currency: 'USD',
                  approvedAt: '2026-10-20T00:00:00.000Z',
                  matchBasis: 'CASE_ID',
                  matchBasisLabel: '案件编号一致',
                },
              ],
            }),
          ),
      }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '官方赔付匹配' }, { timeout: 15000 }))
    expect(await screen.findByText('R100')).toBeInTheDocument()
    expect(screen.getByText('案件编号一致')).toBeInTheDocument()
  })

  it('证据包：没有证据包写原因；有证据包显示文件状态，文件未完成时下载禁用', { timeout: 30000 }, async () => {
    mountApp({ url: '/app/reimbursements/c1', pages, handlers: handlers() })
    await userEvent.click(await screen.findByRole('tab', { name: '证据与附件' }, { timeout: 15000 }))
    expect(await screen.findByText(/还没有生成过证据包/)).toBeInTheDocument()
    expect(screen.getByText('还没有附件')).toBeInTheDocument()
  })

  it('证据包列表：已完成可下载，生成中禁用', { timeout: 30000 }, async () => {
    const packs = [
      { id: 'p1', generatedAt: '2026-10-22T00:00:00.000Z', generatedBy: '张三', lineCount: 12, exportJobId: 'j1', exportStatus: 'DONE', exportStatusLabel: '已完成', downloadable: true },
      { id: 'p2', generatedAt: '2026-10-23T00:00:00.000Z', generatedBy: '张三', lineCount: 12, exportJobId: 'j2', exportStatus: 'RUNNING', exportStatusLabel: '生成中', downloadable: false },
    ]
    mountApp({ url: '/app/reimbursements/c1', pages, handlers: handlers({ '/reimbursements/c1': () => ok(detail({ packs })) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '证据与附件' }, { timeout: 15000 }))
    const done = (await screen.findByText('已完成')).closest('tr, [role=row]') as HTMLElement
    const running = screen.getByText('生成中').closest('tr, [role=row]') as HTMLElement
    expect(within(done).getByRole('button', { name: '下载' })).toBeEnabled()
    expect(within(running).getByRole('button', { name: '下载' })).toBeDisabled()
  })

  it('读取失败：显示原因与重试，不显示空白案件', async () => {
    mountApp({
      url: '/app/reimbursements/c1',
      pages,
      handlers: handlers({ '/reimbursements/c1': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: '案件不存在或不在你的数据范围内' } } }) }),
    })
    expect(await screen.findByText(/案件不存在或不在你的数据范围内/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})
