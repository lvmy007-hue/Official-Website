import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './fee-fixtures.test-helper'
import { actionsOf, checklistOf, detailOf, periodOf } from './periods-fixtures.test-helper'

// 期间关账详情（P2b-13）：身份区与状态说明；完整性检查清单（不通过的项写依据、只有两项能放行）；动作（检查、确认放行、审批、驳回、锁定、重新开账）
// 按服务端给的可用状态启用或禁用、锁定与重新开账先再次验证身份、带版本号提交、服务端拒绝时不假装成功。

const pages: LivePages = { AccountingPeriodDetailPage: { load: () => import('./AccountingPeriodDetailPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const T = { timeout: 30000 }
const PATH = '/finance/periods/p1'
const allowed = { allowed: true, reason: null }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [PATH]: () => ok(detailOf()),
  ...over,
})
const open = (data: unknown, over: Record<string, Handler> = {}) => mountApp({ url: '/app/finance/periods/p1', pages, handlers: handlers({ [PATH]: () => ok(data), ...over }) })
const title = '美国主店 2026-09 关账'
const rowOf = (text: string) => screen.getByText(text).closest('[row-id]') as HTMLElement

/** 记录某个写接口收到的请求体。 */
const record =
  (bodies: unknown[], order: string[] = [], name = 'call'): Handler =>
  (_url, init) => {
    order.push(name)
    bodies.push(JSON.parse(String(init?.body ?? 'null')))
    return ok({ id: 'p1', version: 2, status: 'CLOSING', statusLabel: '关账中', passed: true })
  }

describe('身份区与状态', () => {
  it('没检查过：状态、日期范围、尚未检查、尚未审批、尚未关账；只有“运行完整性检查”可点，审批与锁定禁用', T, async () => {
    open(detailOf())
    expect(await screen.findByText(title, {}, { timeout: 15000 })).toBeInTheDocument()
    const identity = screen.getByTestId('identity')
    expect(within(identity).getByText('开放')).toBeInTheDocument()
    expect(within(identity).getByText('2026-09-01 ~ 2026-09-30')).toBeInTheDocument()
    expect(within(identity).getByText('尚未检查')).toBeInTheDocument()
    expect(within(identity).getByText('尚未审批')).toBeInTheDocument()
    expect(within(identity).getByText('尚未关账')).toBeInTheDocument()
    expect(screen.getByTestId('period-status-note')).toHaveTextContent('先做完整性检查')
    expect(screen.getByRole('button', { name: '运行完整性检查' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '审批通过' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '锁定关账' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '重新开账' })).toBeNull()
    expect(within(screen.getByRole('tabpanel')).getByText('尚未检查')).toBeInTheDocument()
  })

  it('重新开账的期间：显示上次重新开账的人、时间与原因；审批意见也显示', T, async () => {
    open(
      detailOf('REOPENED', {
        period: periodOf('REOPENED', {
          reopenedBy: '赵六',
          reopenedAt: '2026-10-10T08:00:00.000Z',
          reopenReason: '补录了一批退款',
          approvalDecision: 'REJECTED',
          approvedBy: '李四',
          approvalComment: '广告费不对',
        }),
      }),
    )
    await screen.findByText(title, {}, { timeout: 15000 })
    const note = screen.getByTestId('period-status-note')
    expect(note).toHaveTextContent('上次重新开账：赵六')
    expect(note).toHaveTextContent('原因：补录了一批退款')
    expect(note).toHaveTextContent('审批意见：广告费不对')
    expect(within(screen.getByTestId('identity')).getByText('已驳回', { exact: false })).toBeInTheDocument()
  })

  it('期间不存在：显示服务端给的原因', T, async () => {
    mountApp({ url: '/app/finance/periods/p1', pages, handlers: handlers({ [PATH]: () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: '没有这个关账期间' } } }) }) })
    expect(await screen.findByText(/没有这个关账期间/, {}, { timeout: 15000 })).toBeInTheDocument()
  })
})

describe('完整性检查', () => {
  it('运行检查：请求体为空对象', T, async () => {
    const bodies: unknown[] = []
    open(detailOf(), { [`${PATH}/check`]: record(bodies) })
    await userEvent.click(await screen.findByRole('button', { name: '运行完整性检查' }, { timeout: 15000 }))
    await waitFor(() => expect(bodies).toEqual([{}]))
  })

  const failing = () =>
    detailOf('OPEN', {
      period: periodOf('OPEN', { checkPassed: false }),
      checklist: checklistOf(
        {
          COST_COVERAGE: { state: 'FAIL', baseState: 'FAIL', summary: '成本覆盖率 90%，低于 95%', details: ['SKU-A 缺成本'] },
          ADS_ALLOCATED: { state: 'NOT_CONNECTED', baseState: 'NOT_CONNECTED', summary: '广告分摊尚未接入' },
          RECON_EXCEPTIONS: {
            state: 'ACKNOWLEDGED',
            baseState: 'FAIL',
            summary: '2 条对账异常未处理',
            acknowledgement: { by: '王五', at: '2026-10-06T08:00:00.000Z', note: '已人工核对', value: 2 },
          },
        },
        false,
      ),
    })

  it('六项逐项写依据：没通过的写原因与明细；缺口项不能放行；已放行的写人、时间与原因', T, async () => {
    open(failing())
    await screen.findByTestId('period-checklist', {}, { timeout: 15000 })
    expect(screen.getByTestId('period-checklist')).toHaveTextContent('有项目未通过，期间保持开放')
    const cost = rowOf('成本覆盖率达标')
    expect(within(cost).getByText('未通过')).toBeInTheDocument()
    expect(within(cost).getByText('成本覆盖率 90%，低于 95%')).toBeInTheDocument()
    expect(within(cost).getByText('SKU-A 缺成本')).toBeInTheDocument()
    expect(within(cost).getByText('不能放行，须补齐')).toBeInTheDocument()
    expect(within(rowOf('各数据域同步完整')).getAllByText('通过').length).toBeGreaterThan(0)
    const ads = rowOf('广告分摊完成')
    expect(within(ads).getByText('尚未接入')).toBeInTheDocument()
    expect(within(ads).getByRole('button', { name: '确认放行' })).toBeEnabled()
    const recon = rowOf('对账异常已处理或已确认')
    expect(within(recon).getByText('已确认放行')).toBeInTheDocument()
    expect(within(recon).getByText('原因：已人工核对')).toBeInTheDocument()
    expect(within(recon).getByText(/王五/)).toBeInTheDocument()
    expect(within(recon).queryByRole('button', { name: '确认放行' })).toBeNull()
  })

  it('确认放行：原因必填；请求带检查项编号与原因', T, async () => {
    const bodies: unknown[] = []
    open(failing(), { [`${PATH}/check`]: record(bodies) })
    await screen.findByTestId('period-checklist', {}, { timeout: 15000 })
    await userEvent.click(within(rowOf('广告分摊完成')).getByRole('button', { name: '确认放行' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认放行并重新检查' }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.type(within(dialog).getByLabelText('放行原因'), '广告分摊上线前按店铺口径核对过')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认放行并重新检查' }))
    await waitFor(() => expect(bodies).toEqual([{ acknowledgements: [{ key: 'ADS_ALLOCATED', note: '广告分摊上线前按店铺口径核对过' }] }]))
  })
})

describe('审批与锁定', () => {
  const closing = (over: Parameters<typeof actionsOf>[0] = {}) =>
    detailOf('CLOSING', { period: periodOf('CLOSING', { version: 4, checkPassed: true, checkedBy: '张三' }), checklist: checklistOf(), actions: actionsOf({ approve: allowed, ...over }) })

  it('审批通过：带版本号和意见', T, async () => {
    const bodies: unknown[] = []
    open(closing(), { [`${PATH}/approve`]: record(bodies) })
    await userEvent.click(await screen.findByRole('button', { name: '审批通过' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('审批意见'), '同意关账')
    await userEvent.click(within(dialog).getByRole('button', { name: /通\s*过/ }))
    await waitFor(() => expect(bodies).toEqual([{ version: 4, decision: 'APPROVED', comment: '同意关账' }]))
  })

  it('审批通过不写意见：请求里没有 comment', T, async () => {
    const bodies: unknown[] = []
    open(closing(), { [`${PATH}/approve`]: record(bodies) })
    await userEvent.click(await screen.findByRole('button', { name: '审批通过' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /通\s*过/ }))
    await waitFor(() => expect(bodies).toEqual([{ version: 4, decision: 'APPROVED' }]))
  })

  it('驳回：意见必填；请求是 REJECTED 加意见', T, async () => {
    const bodies: unknown[] = []
    open(closing(), { [`${PATH}/approve`]: record(bodies) })
    await userEvent.click(await screen.findByRole('button', { name: /驳\s*回/ }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /驳\s*回/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.type(within(dialog).getByLabelText('驳回意见'), '广告费对不上')
    await userEvent.click(within(dialog).getByRole('button', { name: /驳\s*回/ }))
    await waitFor(() => expect(bodies).toEqual([{ version: 4, decision: 'REJECTED', comment: '广告费对不上' }]))
  })

  it('服务端拒绝（审批人不能是检查人）：弹窗里显示原因，不关闭', T, async () => {
    open(closing(), { [`${PATH}/approve`]: () => ({ status: 409, body: { error: { code: 'CONFLICT', message: '审批人不能是运行检查的人' } } }) })
    await userEvent.click(await screen.findByRole('button', { name: '审批通过' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /通\s*过/ }))
    expect(await within(dialog).findByText(/审批人不能是运行检查的人/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('服务端说不能审批：按钮禁用', T, async () => {
    open(closing({ approve: { allowed: false, reason: '审批人不能是运行检查的人' } }))
    await screen.findByText(title, {}, { timeout: 15000 })
    expect(screen.getByRole('button', { name: '审批通过' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /驳\s*回/ })).toBeDisabled()
  })

  it('锁定：必须勾选确认并再次验证身份；先验证再提交，带版本号', T, async () => {
    const order: string[] = []
    const bodies: unknown[] = []
    open(closing({ close: allowed }), {
      '/auth/step-up': () => (order.push('step-up'), ok({ expiresAt: '2026-10-23T12:00:00Z' })),
      [`${PATH}/close`]: record(bodies, order, 'close'),
    })
    await userEvent.click(await screen.findByRole('button', { name: '锁定关账' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /锁\s*定/ }))
    expect(await within(dialog).findByText('请先勾选确认')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: /锁\s*定/ }))
    await waitFor(() => expect(order).toEqual(['step-up', 'close']))
    expect(bodies).toEqual([{ version: 4 }])
  })

  it('密码不对：不调用锁定接口', T, async () => {
    const bodies: unknown[] = []
    open(closing({ close: allowed }), {
      '/auth/step-up': () => ({ status: 401, body: { error: { code: 'STEP_UP_FAILED', message: '密码不正确' } } }),
      [`${PATH}/close`]: record(bodies),
    })
    await userEvent.click(await screen.findByRole('button', { name: '锁定关账' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'bad')
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: /锁\s*定/ }))
    expect(await within(dialog).findByText(/密码不正确/)).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
  })

  it('没有关账权限（即使服务端说可以）：锁定、审批、驳回都禁用', T, async () => {
    mountApp({ url: '/app/finance/periods/p1', pages, handlers: handlers({ [PATH]: () => ok(closing({ close: allowed })) }, ['finance.read']) })
    await screen.findByText(title, {}, { timeout: 15000 })
    for (const name of ['锁定关账', '审批通过', /驳\s*回/]) expect(screen.getByRole('button', { name })).toBeDisabled()
  })
})

describe('已关账与重新开账', () => {
  const closed = () =>
    detailOf('CLOSED', {
      period: periodOf('CLOSED', { version: 7, closeCount: 1, closedBy: '李四', closedAt: '2026-10-08T09:00:00.000Z', checkPassed: true }),
      actions: actionsOf({ reopen: allowed }),
    })

  it('只剩“重新开账”；检查、审批、锁定都不出现', T, async () => {
    open(closed())
    await screen.findByText(title, {}, { timeout: 15000 })
    expect(screen.getByRole('button', { name: '重新开账' })).toBeEnabled()
    for (const name of ['运行完整性检查', '审批通过', '锁定关账']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByTestId('period-status-note')).toHaveTextContent('最近关账：李四')
  })

  it('重新开账：原因必填，先再次验证身份，再带版本号与原因提交', T, async () => {
    const order: string[] = []
    const bodies: unknown[] = []
    open(closed(), {
      '/auth/step-up': () => (order.push('step-up'), ok({ expiresAt: '2026-10-23T12:00:00Z' })),
      [`${PATH}/reopen`]: record(bodies, order, 'reopen'),
    })
    await userEvent.click(await screen.findByRole('button', { name: '重新开账' }, { timeout: 15000 }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '重新开账' }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.type(within(dialog).getByLabelText('重新开账原因'), '补录了一批九月的退款')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: '重新开账' }))
    await waitFor(() => expect(order).toEqual(['step-up', 'reopen']))
    expect(bodies).toEqual([{ version: 7, reason: '补录了一批九月的退款' }])
  })

  it('没有重新开账权限：按钮禁用', T, async () => {
    open(detailOf('CLOSED', { period: periodOf('CLOSED'), actions: actionsOf({ reopen: { allowed: false, reason: '缺少权限：finance.period.reopen' } }) }))
    await screen.findByText(title, {}, { timeout: 15000 })
    expect(screen.getByRole('button', { name: '重新开账' })).toBeDisabled()
  })
})
