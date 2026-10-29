import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeSearchParser, type ApprovalListResponse, type ApprovalRow } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

// 审批收件箱页（P6-27）：左侧四个信箱带待处理数、顶部待处理 / 已处理、一行一张单据；抽屉里看摘要并直接审批
// （通过选填意见、驳回必须写原因、发起人自己点是撤回、财务口径要先再次验证身份）；没有数据时说明原因。

const pages: LivePages = { ApprovalsPage: { load: () => import('./ApprovalsPage'), search: ScopeSearchParser } }
afterEach(() => vi.unstubAllGlobals())
const T = { timeout: 30000 }
const WAIT = { timeout: 15000 }
// 抽屉本身也是 dialog，按弹窗标题找到审批表单的那一个
const modalOf = async (title: string) => (await screen.findByText(title)).closest('[role="dialog"]') as HTMLElement

const ok = (data: unknown) => ({ body: { success: true, data } })
const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: 'ap-1',
  type: 'FINANCE_POLICY',
  typeLabel: '财务口径变更',
  title: '财务口径变更：第 2 版',
  objectType: 'FinancePolicyVersion',
  objectId: 'v-2',
  status: 'PENDING',
  statusLabel: '待处理',
  summary: [
    { label: '生效日期', value: '2026-10-25' },
    { label: '变更 1', value: '存货计价方法：先进先出 → 月末加权平均' },
  ],
  requesterId: 'u-maker',
  requesterName: '发起小李',
  approverNames: ['审批小王'],
  ccNames: [],
  decidedByName: null,
  decidedAt: null,
  comment: null,
  createdAt: '2026-10-26T01:00:00Z',
  version: 3,
  canDecide: true,
  isRequester: false,
  detailPath: '/app/settings',
  ...over,
})
const list = (items: ApprovalRow[], over: Partial<ApprovalListResponse> = {}): ApprovalListResponse => ({
  state: items.length > 0 ? 'OK' : 'NO_DATA',
  note: items.length > 0 ? null : '没有需要你审批的单据',
  box: 'TODO',
  filter: 'PENDING',
  items,
  counts: { todoPending: items.length, sentPending: 2, ccPending: 0 },
  pageInfo: { pageSize: 30, nextCursor: null, hasMore: false, approxTotal: items.length },
  ...over,
})
const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: [] }),
  '/grid-views': () => ok({ items: [], canShare: false, limits: { user: 20, team: 30 } }),
  '/approvals': () => ok(list([approval()])),
  ...over,
})

describe('审批收件箱页', () => {
  it('一行一张单据：标题、类型、状态、发起人、审批人；信箱显示待处理数；没有权限点也能打开', T, async () => {
    mountApp({ url: '/app/approvals', pages, handlers: handlers() })
    expect(await screen.findByText('财务口径变更：第 2 版', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('发起小李')).toBeInTheDocument()
    expect(screen.getByText('审批小王')).toBeInTheDocument()
    const menu = screen.getByTestId('approval-boxes')
    for (const label of ['我审批的', '我发起的', '抄送我的', '我处理过的']) expect(within(menu).getByText(label)).toBeInTheDocument()
    await waitFor(() => expect(within(menu).getByText('2')).toBeInTheDocument())
  })

  it('切换信箱与状态：带着 box、state 重新取数', T, async () => {
    const urls: string[] = []
    mountApp({
      url: '/app/approvals',
      pages,
      handlers: handlers({
        '/approvals': url => (urls.push(String(url)), ok(list([approval()]))),
      }),
    })
    await screen.findByText('财务口径变更：第 2 版', {}, WAIT)
    expect(urls[0]).toContain('box=TODO')
    expect(urls[0]).toContain('state=PENDING')
    await userEvent.click(screen.getByText('我发起的'))
    await waitFor(() => expect(urls.some(url => url.includes('box=SENT'))).toBe(true), WAIT)
    await userEvent.click(screen.getByRole('tab', { name: '已处理' }))
    await waitFor(() => expect(urls.some(url => url.includes('box=SENT') && url.includes('state=DONE'))).toBe(true), WAIT)
  })

  it('没有单据：说明原因，不显示 0 冒充有数据', T, async () => {
    mountApp({ url: '/app/approvals', pages, handlers: handlers({ '/approvals': () => ok(list([])) }) })
    expect(await screen.findByText(/没有需要你审批的单据/, {}, WAIT)).toBeInTheDocument()
  })

  it('点一行打开抽屉：显示摘要与原单据入口；是审批人有通过与驳回按钮', T, async () => {
    mountApp({ url: '/app/approvals', pages, handlers: handlers() })
    await userEvent.click(await screen.findByText('财务口径变更：第 2 版', {}, WAIT))
    const drawer = await screen.findByTestId('approval-drawer')
    const summary = within(drawer).getByTestId('approval-summary')
    expect(within(summary).getByText('生效日期')).toBeInTheDocument()
    expect(within(summary).getByText('存货计价方法：先进先出 → 月末加权平均')).toBeInTheDocument()
    expect(within(drawer).getByText('查看原单据')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: /^通\s?过$/ })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: /^驳\s?回$/ })).toBeEnabled()
  })

  it('发起人看到“撤回”而没有“通过”；不是审批人只读并说明', T, async () => {
    mountApp({ url: '/app/approvals', pages, handlers: handlers({ '/approvals': () => ok(list([approval({ isRequester: true })])) }) })
    await userEvent.click(await screen.findByText('财务口径变更：第 2 版', {}, WAIT))
    const drawer = await screen.findByTestId('approval-drawer')
    expect(within(drawer).getByRole('button', { name: /^撤\s?回$/ })).toBeEnabled()
    expect(within(drawer).queryByRole('button', { name: /^通\s?过$/ })).toBeNull()
  })

  it('不是审批人：不显示审批按钮，说明只能查看', T, async () => {
    mountApp({ url: '/app/approvals', pages, handlers: handlers({ '/approvals': () => ok(list([approval({ canDecide: false })])) }) })
    await userEvent.click(await screen.findByText('财务口径变更：第 2 版', {}, WAIT))
    const drawer = await screen.findByTestId('approval-drawer')
    expect(within(drawer).getByText('你不是这张单据的审批人，只能查看')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /^通\s?过$/ })).toBeNull()
  })

  it('通过：财务口径先再次验证身份，再提交，带着收件箱记录的版本号与意见', T, async () => {
    const order: string[] = []
    let body: Record<string, unknown> | null = null
    mountApp({
      url: '/app/approvals',
      pages,
      handlers: handlers({
        '/auth/step-up': () => (order.push('step-up'), ok({ expiresAt: '2026-10-28T12:00:00Z' })),
        '/approvals/ap-1/decision': (_url, init) => {
          order.push('decision')
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return ok({ id: 'ap-1', status: 'APPROVED', statusLabel: '已通过', message: '已通过' })
        },
      }),
    })
    await userEvent.click(await screen.findByText('财务口径变更：第 2 版', {}, WAIT))
    const drawer = await screen.findByTestId('approval-drawer')
    await userEvent.click(within(drawer).getByRole('button', { name: /^通\s?过$/ }))
    const dialog = await modalOf('通过：财务口径变更：第 2 版')
    await userEvent.type(within(dialog).getByLabelText('审批意见'), '同意')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /^通\s?过$/ }))
    await waitFor(() => expect(order).toEqual(['step-up', 'decision']), WAIT)
    expect(body).toEqual({ decision: 'APPROVED', comment: '同意', version: 3 })
  })

  it('驳回必须写原因；关账审批不需要再次验证身份', T, async () => {
    let body: Record<string, unknown> | null = null
    let stepUp = 0
    mountApp({
      url: '/app/approvals',
      pages,
      handlers: handlers({
        '/approvals': () =>
          ok(list([approval({ id: 'ap-2', type: 'PERIOD_CLOSE', typeLabel: '期间关账', title: '美国主店 2025-03 关账审批', objectType: 'AccountingPeriod', detailPath: '/app/finance/periods/p1' })])),
        '/auth/step-up': () => (stepUp++, ok({})),
        '/approvals/ap-2/decision': (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return ok({ id: 'ap-2', status: 'REJECTED', statusLabel: '已驳回', message: '已驳回' })
        },
      }),
    })
    await userEvent.click(await screen.findByText('美国主店 2025-03 关账审批', {}, WAIT))
    const drawer = await screen.findByTestId('approval-drawer')
    await userEvent.click(within(drawer).getByRole('button', { name: /^驳\s?回$/ }))
    const dialog = await modalOf('驳回：美国主店 2025-03 关账审批')
    await userEvent.click(within(dialog).getByRole('button', { name: /^驳\s?回$/ }))
    expect(body).toBeNull()
    await userEvent.type(within(dialog).getByRole('textbox'), '利润对不上，重新核对')
    await userEvent.click(within(dialog).getByRole('button', { name: /^驳\s?回$/ }))
    await waitFor(() => expect(body).not.toBeNull(), WAIT)
    expect(body).toEqual({ decision: 'REJECTED', comment: '利润对不上，重新核对', version: 3 })
    expect(stepUp).toBe(0)
  })
})
