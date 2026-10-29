import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import type { Me } from '../../session/session'
import { ok, policyData, policyVersion } from './finance-policy-fixtures.test-helper'
import { settingsData } from './enterprise-settings-fixtures.test-helper'

// 企业设置页与财务口径页签（P2b-15）：页签齐全；当前口径逐项写明是否已用于计算；
// 提交、审批、驳回与撤回：先再次验证身份再调接口，按钮的可用与否以服务端 actions 为准；历史版本。

const pages: LivePages = { SettingsPage: { load: () => import('./SettingsPage') } }
const T = { timeout: 30000 }
const PATH = '/settings/finance-policy'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const limited = (permissions: string[]): Me => ({ ...defaultMe, permissions })
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>

function open(data: unknown, extra: Record<string, Handler> = {}, me?: Me) {
  const app = mountApp({ url: '/app/settings', pages, me, handlers: { [PATH]: () => ok(data), ...extra } })
  return app
}
async function toFinance() {
  await userEvent.click(await screen.findByRole('tab', { name: '财务口径' }, { timeout: 15000 }))
}

describe('企业设置页', () => {
  it('8 个页签按 9.12 的顺序；基本信息与数据保留已接入（以卡片展示）；接口开关与汇率给入口', T, async () => {
    open(policyData(), { '/settings': () => ok(settingsData()) })
    const tabs = await screen.findAllByRole('tab', {}, { timeout: 15000 })
    expect(tabs.map(tab => tab.textContent)).toEqual(['基本信息', '财务口径', '数据保留', '刷新策略', '风险规则版本', '内部访问模式', '接口与写入开关', '汇率'])
    expect(await screen.findByText('示例企业有限公司')).toBeInTheDocument()
    expect(screen.getByText('America/Los_Angeles')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '数据保留' }))
    expect(await screen.findByText('原始报告文件')).toBeInTheDocument()
    expect(screen.queryByText('尚未接入')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '汇率' }))
    expect(await screen.findByText(/前往“汇率”/)).toBeInTheDocument()
  })
})

describe('财务口径页签', () => {
  it('没有审批过的版本：写明用的是系统默认口径；逐项说明是否已用于计算；历史写“尚无记录”', T, async () => {
    open(policyData())
    await toFinance()
    expect(await screen.findByText('当前口径：系统默认（还没有审批过的版本）')).toBeInTheDocument()
    const row = (label: string) => screen.getByText(label, { selector: 'td, .ag-cell *' }).closest('tr, [role=row]') as HTMLElement
    expect(within(row('存货计价方法')).getByText('先进先出')).toBeInTheDocument()
    expect(within(row('存货计价方法')).getByText('已用于计算')).toBeInTheDocument()
    expect(within(row('汇率折算规则')).getByText(/只有这一种规则/)).toBeInTheDocument()
    expect(within(row('收入确认口径')).getByText('仅登记，尚未用于计算')).toBeInTheDocument()
    expect(within(row('店铺级费用分摊规则')).getByText('已用于计算')).toBeInTheDocument()
    expect(within(row('店铺级费用分摊规则')).getByText(/费用分摊规则”页按费用项配置/)).toBeInTheDocument()
    expect(within(row('广告分摊规则')).getByText('已用于计算')).toBeInTheDocument()
    expect(within(row('广告分摊规则')).getByText(/重算时按它分摊广告/)).toBeInTheDocument()
    expect(await screen.findByText(/尚无记录：还没有提交过口径修改/)).toBeInTheDocument()
    expect(await screen.findByText(/现有 0 个/)).toBeInTheDocument()
  })

  it('有生效版本：标题写版本与生效日，历史里显示发起人、原因、处理人与意见；撤回的写“已撤回”', T, async () => {
    const data = policyData({
      current: { source: 'VERSION', versionNo: 3, effectiveFrom: '2026-10-01', values: { ...policyVersion(), inventoryCostMethod: 'MONTH_AVG' }, inventoryMethodValid: true },
      latestVersionNo: 3,
      history: [
        policyVersion({ id: 'fp-3', versionNo: 3, status: 'ACTIVE' }),
        policyVersion({ id: 'fp-2', versionNo: 2, status: 'REJECTED', withdrawn: true, decisionComment: '写错了', reason: '想改广告分摊', decidedBy: 'u-maker', decidedByName: '王会计' }),
        policyVersion({ id: 'fp-1', versionNo: 1, status: 'REPLACED', decisionComment: null }),
      ],
      frozenPeriodCount: 2,
    })
    open(data)
    await toFinance()
    expect(await screen.findByText('当前口径：第 3 版（生效日 2026-10-01）')).toBeInTheDocument()
    expect(screen.getByText(/现有 2 个/)).toBeInTheDocument()
    const withdrawn = screen.getByText('第 2 版').closest('tr, [role=row]') as HTMLElement
    expect(within(withdrawn).getByText('已撤回')).toBeInTheDocument()
    expect(within(withdrawn).getByText('写错了')).toBeInTheDocument()
    expect(within(withdrawn).getByText('想改广告分摊')).toBeInTheDocument()
    const first = screen.getByText('第 1 版').closest('tr, [role=row]') as HTMLElement
    expect(within(first).getByText('已替换')).toBeInTheDocument()
    expect(within(first).getAllByText(/王会计/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('第 3 版').closest('tr, [role=row]')).toHaveTextContent('生效中')
  })

  it('存货计价取值不合法：显示警告', T, async () => {
    open(policyData({ current: { source: 'DEFAULT', versionNo: 0, effectiveFrom: null, values: policyData().current.values, inventoryMethodValid: false } }))
    await toFinance()
    expect(await screen.findByText(/取值不合法，利润计算现按先进先出处理/)).toBeInTheDocument()
  })

  it('服务端出错：显示错误与重试，不留空白', T, async () => {
    open(null, { [PATH]: () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) })
    await toFinance()
    expect((await screen.findAllByText(/服务暂时不可用/, {}, { timeout: 15000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })
})

describe('提交口径修改', () => {
  it('没有“修改财务口径”权限：按钮禁用', T, async () => {
    open(policyData({}, { canWrite: false }), {}, limited(['settings.read']))
    await toFinance()
    expect(await screen.findByRole('button', { name: /修\s*改\s*口\s*径/ })).toBeDisabled()
  })

  it('已有待审批的修改：提交按钮禁用', T, async () => {
    open(policyData({ pending: policyVersion({ status: 'PENDING', versionNo: 1, mine: false, decidedBy: null, decidedAt: null, decisionComment: null }), latestVersionNo: 1 }))
    await toFinance()
    expect(await screen.findByRole('button', { name: /修\s*改\s*口\s*径/ })).toBeDisabled()
  })

  it('先再次验证身份，再提交；请求带最新版本号、生效日与原因', T, async () => {
    const order: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    open(policyData({ latestVersionNo: 4 }), {
      '/auth/step-up': () => (order.push('step-up'), ok({ expiresAt: '2026-10-23T12:00:00Z' })),
      [PATH]: (_url, init) => {
        if (init?.method === 'PUT') {
          order.push('submit')
          bodies.push(bodyOf(init))
          return ok({ versionNo: 5, version: 1, status: 'PENDING', message: '已提交' })
        }
        return ok(policyData({ latestVersionNo: 4 }))
      },
    })
    await toFinance()
    await userEvent.click(await screen.findByRole('button', { name: /修\s*改\s*口\s*径/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '与会计师确认后调整')
    await userEvent.click(within(dialog).getByRole('button', { name: /提交审批/ }))
    expect(await within(dialog).findByText('请输入登录密码')).toBeInTheDocument()
    expect(order).toEqual([])
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /提交审批/ }))
    await waitFor(() => expect(order).toEqual(['step-up', 'submit']))
    expect(bodies[0]).toMatchObject({
      version: 4,
      effectiveFrom: '2026-10-23',
      revenueRecognition: 'ORDERED',
      inventoryCostMethod: 'FIFO',
      adsAllocationMode: 'BY_SALES',
      storeFeeAllocation: 'BY_SALES',
      reason: '与会计师确认后调整',
    })
    expect(bodies[0]).not.toHaveProperty('password')
  })

  it('服务端拒绝（例如生效日落在已关账期间）：弹窗不关，显示服务端给的原因', T, async () => {
    open(policyData(), {
      '/auth/step-up': () => ok({ expiresAt: '2026-10-23T12:00:00Z' }),
      [PATH]: (_url, init) => (init?.method === 'PUT' ? { status: 409, body: { error: { code: 'DATA_CONDITION_FAILED', message: '生效日落在已关账的期间' } } } : ok(policyData())),
    })
    await toFinance()
    await userEvent.click(await screen.findByRole('button', { name: /修\s*改\s*口\s*径/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '补一个原因')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /提交审批/ }))
    expect(await within(dialog).findByText(/生效日落在已关账的期间/)).toBeInTheDocument()
  })
})

describe('审批、驳回与撤回', () => {
  const pending = (over: Parameters<typeof policyVersion>[0] = {}) =>
    policyVersion({
      id: 'fp-2',
      versionNo: 2,
      status: 'PENDING',
      version: 1,
      inventoryCostMethod: 'MOVING_AVG',
      adsAllocationMode: 'BY_UNITS',
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      decisionComment: null,
      ...over,
    })

  it('别人发起的：显示相对当前口径的变化；审批要再次验证身份，请求带版本号与意见', T, async () => {
    const order: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    const data = policyData({ pending: pending(), latestVersionNo: 2 })
    open(data, {
      '/auth/step-up': () => (order.push('step-up'), ok({ expiresAt: '2026-10-23T12:00:00Z' })),
      [`${PATH}/2/approve`]: (_url, init) => (order.push('approve'), bodies.push(bodyOf(init)), ok({ versionNo: 2, status: 'ACTIVE', message: '已生效' })),
    })
    await toFinance()
    const card = await screen.findByTestId('policy-pending')
    expect(within(card).getByText('存货计价方法：先进先出 → 移动加权平均')).toBeInTheDocument()
    expect(within(card).getByText('广告分摊规则：按销售额 → 按销量')).toBeInTheDocument()
    expect(within(card).getByText('王会计')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: /审\s*批\s*通\s*过/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /审批意见/ }), '核对无误')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /通过并生效/ }))
    await waitFor(() => expect(order).toEqual(['step-up', 'approve']))
    expect(bodies[0]).toEqual({ decision: 'APPROVED', comment: '核对无误', version: 1 })
  })

  it('自己发起的：不能审批并说明原因；按钮叫“撤回修改”，必须写原因，请求是 REJECTED', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    const data = policyData({ pending: pending({ mine: true, createdBy: 'u-me' }), latestVersionNo: 2 }, { userId: 'u-me' })
    open(data, {
      '/auth/step-up': () => ok({ expiresAt: '2026-10-23T12:00:00Z' }),
      [`${PATH}/2/approve`]: (_url, init) => (bodies.push(bodyOf(init)), ok({ versionNo: 2, status: 'REJECTED', message: '已撤回' })),
    })
    await toFinance()
    const card = await screen.findByTestId('policy-pending')
    expect(within(card).getByRole('button', { name: /审\s*批\s*通\s*过/ })).toBeDisabled()
    expect(within(card).getByTestId('policy-approve-hint')).toHaveTextContent('发起人不能审批自己的修改')
    await userEvent.click(within(card).getByRole('button', { name: /撤\s*回\s*修\s*改/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('登录密码'), 'Passw0rd!')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认撤回/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies).toEqual([])
    await userEvent.type(within(dialog).getByRole('textbox', { name: /撤回原因/ }), '参数写错了')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认撤回/ }))
    await waitFor(() => expect(bodies).toEqual([{ decision: 'REJECTED', comment: '参数写错了', version: 1 }]))
  })

  it('别人发起的可以驳回：按钮叫“驳回”', T, async () => {
    open(policyData({ pending: pending(), latestVersionNo: 2 }))
    await toFinance()
    const card = await screen.findByTestId('policy-pending')
    expect(within(card).getByRole('button', { name: /驳\s*回/ })).toBeEnabled()
    expect(within(card).queryByRole('button', { name: /撤\s*回/ })).not.toBeInTheDocument()
  })
})
