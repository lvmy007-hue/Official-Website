import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import type { Me } from '../../session/session'
import { ok, settingsData } from './enterprise-settings-fixtures.test-helper'

// 企业设置页的基本信息、数据保留、刷新策略、风险规则版本、内部访问模式页签（P5-10）：
// 每个配置项一张卡片（配置名、当前值、影响范围、编辑入口）；只读项没有编辑入口并写明由谁控制；
// 修改只调 PATCH /settings，带读取时的版本号与原因，服务端拒绝时弹窗不关并显示原因。

const pages: LivePages = { SettingsPage: { load: () => import('./SettingsPage') } }
const T = { timeout: 30000 }
const PATH = '/settings'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const limited = (permissions: string[]): Me => ({ ...defaultMe, permissions })
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
const card = (id: string) => screen.getByTestId(`config-${id}`)

function open(data: unknown, extra: Record<string, Handler> = {}, me?: Me) {
  return mountApp({ url: '/app/settings', pages, me, handlers: { [PATH]: () => ok(data), ...extra } })
}
async function toTab(name: string) {
  await userEvent.click(await screen.findByRole('tab', { name }, { timeout: 15000 }))
}
const editButton = (id: string, label = /修\s*改/) => within(card(id)).getByRole('button', { name: label })

describe('基本信息页签', () => {
  it('每项一张卡片：名称与本地时区可改；企业标识、运行模式、数据口径时区、默认币种只读并写明由谁控制', T, async () => {
    open(settingsData())
    expect(await screen.findByText('示例企业有限公司', {}, { timeout: 15000 })).toBeInTheDocument()
    for (const id of ['name', 'localTimezone']) expect(within(card(id)).getByText(/影响范围：/)).toBeInTheDocument()
    expect(editButton('name')).toBeEnabled()
    expect(editButton('localTimezone')).toBeEnabled()
    for (const id of ['slug', 'mode', 'dataTimezone', 'currency']) {
      expect(within(card(id)).queryByRole('button')).not.toBeInTheDocument()
      expect(within(card(id)).getByText(/^只读：/)).toBeInTheDocument()
    }
    expect(within(card('dataTimezone')).getByText(/America\/Los_Angeles/)).toBeInTheDocument()
    expect(within(card('dataTimezone')).getByText(/改动会让已汇总的日数据口径错位/)).toBeInTheDocument()
    expect(within(card('currency')).getByText('美元（USD）')).toBeInTheDocument()
    expect(within(card('mode')).getByText('正式运行')).toBeInTheDocument()
  })

  it('修改企业名称：原因必填；提交带名称、读取时的版本号与原因；成功后重新取数', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    let name = '示例企业有限公司'
    open(null, {
      [PATH]: (_url, init) => {
        if (init?.method === 'PATCH') {
          bodies.push(bodyOf(init))
          name = String(bodyOf(init).name)
          return ok({ section: 'basic', version: 1760000001000 })
        }
        const data = settingsData()
        return ok({ ...data, basic: { ...data.basic, name } })
      },
    })
    await screen.findByText('示例企业有限公司', {}, { timeout: 15000 })
    await userEvent.click(editButton('name'))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('企业名称')
    await userEvent.clear(input)
    await userEvent.type(input, '新名称贸易有限公司')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    expect(await within(dialog).findByText('请填写原因')).toBeInTheDocument()
    expect(bodies).toEqual([])
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '公司更名')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ section: 'basic', name: '新名称贸易有限公司', version: 1760000000000, reason: '公司更名' })
    expect(await screen.findByText('新名称贸易有限公司')).toBeInTheDocument()
  })

  it('版本冲突：弹窗不关，显示服务端给的原因', T, async () => {
    open(settingsData(), {
      [PATH]: (_url, init) => (init?.method === 'PATCH' ? { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: '企业资料已被别人修改，请刷新后再试' } } } : ok(settingsData())),
    })
    await screen.findByText('示例企业有限公司', {}, { timeout: 15000 })
    await userEvent.click(editButton('name'))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '补一个原因')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    expect(await within(dialog).findByText(/企业资料已被别人修改/)).toBeInTheDocument()
  })

  it('没有 settings.write：编辑入口禁用，只读项照旧', T, async () => {
    open(settingsData({ canWrite: false }), {}, limited(['settings.read']))
    await screen.findByText('示例企业有限公司', {}, { timeout: 15000 })
    expect(editButton('name')).toBeDisabled()
    expect(editButton('localTimezone')).toBeDisabled()
  })

  it('没有 settings.read（服务端 403）：显示无权限，不显示卡片', T, async () => {
    open(null, { [PATH]: () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) })
    expect(await screen.findByText(/没有权限|无权/, {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.queryByTestId('config-name')).not.toBeInTheDocument()
  })
})

describe('数据保留页签', () => {
  it('三项可改的保留期与只读的审计日志；默认值有标记；每张卡片写明对已有数据的影响', T, async () => {
    open(settingsData({ retention: { exportFileDays: 14 } }))
    await toTab('数据保留')
    expect(await screen.findByText('原始报告文件')).toBeInTheDocument()
    expect(within(card('rawReportDays')).getByText(/400 天/)).toBeInTheDocument()
    expect(within(card('rawReportDays')).getByText('系统默认')).toBeInTheDocument()
    expect(within(card('exportFileDays')).getByText(/14 天/)).toBeInTheDocument()
    expect(within(card('exportFileDays')).queryByText('系统默认')).not.toBeInTheDocument()
    expect(within(card('customerInfoDays')).getByText(/只能缩短，不能延长/)).toBeInTheDocument()
    expect(within(card('auditLog')).getByText('不自动清理，只增不删')).toBeInTheDocument()
    expect(within(card('auditLog')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(card('auditLog')).getByText(/^只读：/)).toBeInTheDocument()
    expect(screen.getByText(/还没有人修改过，现在用的是系统默认/)).toBeInTheDocument()
  })

  it('修改买家信息的保留天数：提交三项完整取值（只改这一项）、版本号与原因；超出上限的数被收回到上限', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    open(null, {
      [PATH]: (_url, init) => {
        if (init?.method === 'PATCH') return (bodies.push(bodyOf(init)), ok({ section: 'retention', version: 1 }))
        const data = settingsData({ retention: { rawReportDays: 365 } })
        return ok({ ...data, retention: { ...data.retention, version: 4, updatedAt: '2026-10-21T08:00:00.000Z', updatedByName: '王经理' } })
      },
    })
    await toTab('数据保留')
    expect(await screen.findByText(/最近修改：王经理/)).toBeInTheDocument()
    await userEvent.click(editButton('customerInfoDays'))
    const dialog = await screen.findByRole('dialog')
    const days = within(dialog).getByLabelText('保留天数')
    await userEvent.clear(days)
    await userEvent.type(days, '31')
    await userEvent.tab()
    expect(days).toHaveValue('30') // 超出上限的数在离开输入框时被收回到上限
    await userEvent.type(within(dialog).getByRole('textbox', { name: /修改原因/ }), '合规要求缩短')
    expect(bodies).toEqual([])
    await userEvent.clear(days)
    await userEvent.type(days, '15')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ section: 'retention', values: { rawReportDays: 365, exportFileDays: 7, customerInfoDays: 15 }, version: 4, reason: '合规要求缩短' })
  })
})

describe('刷新策略页签', () => {
  it('每个数据域一张卡片，写明内置频率；已放慢与已暂停的特别标出；固定频率的定时任务只读列出', T, async () => {
    open(settingsData({ refresh: { FBA_ORDERS: { mode: 'EVERY', minutes: 720 }, FBA_ADS: { mode: 'PAUSED' } } }))
    await toTab('刷新策略')
    expect(await screen.findByText(/有 1 个数据域已暂停定时同步/)).toBeInTheDocument()
    expect(within(card('FBA_INVENTORY')).getByText(/每 30 分钟（系统内置）/)).toBeInTheDocument()
    expect(within(card('FBA_ORDERS')).getByText(/每 12 小时（已放慢）/)).toBeInTheDocument()
    expect(within(card('FBA_ADS')).getByText('已暂停')).toBeInTheDocument()
    expect(within(card('FBA_ADS')).getByText(/影响范围：/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /调\s*整/ })).toHaveLength(19) // 17 个原有数据域 + 广告实体、广告报表（P5-12A）
    expect(within(card('ADS_ENTITY_SYNC')).getByText(/每 2 小时（系统内置）/)).toBeInTheDocument()
    expect(within(card('ADS_REPORT_V1')).getByText(/每天（系统内置）/)).toBeInTheDocument()
    expect(within(card('fixed-汇率获取')).getByText('每 6 小时')).toBeInTheDocument()
    expect(within(card('fixed-汇率获取')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(card('fixed-汇率获取')).getByText(/^只读：/)).toBeInTheDocument()
  })

  it('放慢库存同步：只提交这一个数据域的修改，间隔选项都比内置的更长', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    open(settingsData(), { [PATH]: (_url, init) => (init?.method === 'PATCH' ? (bodies.push(bodyOf(init)), ok({ section: 'refresh', version: 1 })) : ok(settingsData())) })
    await toTab('刷新策略')
    await screen.findByText('库存')
    await userEvent.click(within(card('FBA_INVENTORY')).getByRole('button', { name: /调\s*整/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByLabelText('放慢到'))
    await userEvent.click(within(dialog).getByRole('combobox', { name: '同步间隔' }))
    // 库存内置 30 分钟：60 分钟起都可选
    expect(await screen.findByText('每 1 小时', { selector: '.ant-select-item-option-content' })).toBeInTheDocument()
    await userEvent.click(screen.getByText('每 6 小时', { selector: '.ant-select-item-option-content' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: /调整原因/ }), '库存一天看几次就够')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ section: 'refresh', changes: { FBA_INVENTORY: { mode: 'EVERY', minutes: 360 } }, version: 0, reason: '库存一天看几次就够' })
  })

  it('暂停定时同步；恢复系统内置时提交 DEFAULT', T, async () => {
    const bodies: Array<Record<string, unknown>> = []
    open(settingsData({ refresh: { FBA_ADS: { mode: 'PAUSED' } } }), {
      [PATH]: (_url, init) => (init?.method === 'PATCH' ? (bodies.push(bodyOf(init)), ok({ section: 'refresh', version: 2 })) : ok(settingsData({ refresh: { FBA_ADS: { mode: 'PAUSED' } } }))),
    })
    await toTab('刷新策略')
    await screen.findByText('广告')
    await userEvent.click(within(card('FBA_ADS')).getByRole('button', { name: /调\s*整/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('暂停定时同步')).toBeChecked()
    await userEvent.click(within(dialog).getByLabelText(/按系统内置/))
    await userEvent.type(within(dialog).getByRole('textbox', { name: /调整原因/ }), '广告恢复正常使用')
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ section: 'refresh', changes: { FBA_ADS: { mode: 'DEFAULT' } }, version: 0, reason: '广告恢复正常使用' })
  })
})

describe('风险规则版本与内部访问模式页签', () => {
  it('风险规则：显示条数与最近一次修改，给预警规则配置入口；没有管理权限时没有入口', T, async () => {
    const risk = { total: 12, enabled: 9, lastChange: { ruleName: '广告超预算', versionNo: 3, changedAt: '2026-10-22T08:00:00.000Z' } }
    open(settingsData({ risk }))
    await toTab('风险规则版本')
    expect(await screen.findByText('共 12 条，已启用 9 条')).toBeInTheDocument()
    expect(screen.getByText('广告超预算 · 第 3 版')).toBeInTheDocument()
    expect(within(card('riskRules')).getByRole('button', { name: /前往“预警规则配置”/ })).toBeInTheDocument()
  })

  it('没有 alerts.manage：规则卡片只读并写明谁能改，没有入口', T, async () => {
    open(settingsData(), {}, limited(['settings.read']))
    await toTab('风险规则版本')
    expect(await screen.findByText(/管理预警规则/)).toBeInTheDocument()
    expect(within(card('riskRules')).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('还没有人修改过规则')).toBeInTheDocument()
  })

  it('内部访问模式：只读；关闭、对本企业开启、部署配置有误各自如实说明；支持访问授权只显示数量', T, async () => {
    open(settingsData({ internal: { supportGrantsActive: 2, supportGrantsInUse: 1 } }))
    await toTab('内部访问模式')
    expect(await screen.findByText('未开启')).toBeInTheDocument()
    expect(within(card('internalAccess')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(card('internalAccess')).getByText(/由部署配置控制/)).toBeInTheDocument()
    expect(screen.getByText('当前有效 2 个，正在被使用 1 个')).toBeInTheDocument()
  })

  it('对本企业开启：显示绑定角色与网络范围段数', T, async () => {
    open(settingsData({ internal: { state: 'ON_THIS_TENANT', roleId: 'role-ops', allowedRangeCount: 2, gatewayHeaderRequired: true } }))
    await toTab('内部访问模式')
    expect(await screen.findByText('已对本企业开启')).toBeInTheDocument()
    expect(screen.getByText(/绑定角色：role-ops；允许的网络范围 2 段；要求网关校验头/)).toBeInTheDocument()
  })

  it('部署配置有误：写明按未开启处理', T, async () => {
    open(settingsData({ internal: { state: 'MISCONFIGURED' } }))
    await toTab('内部访问模式')
    expect(await screen.findByText('部署配置有误，系统按未开启处理')).toBeInTheDocument()
  })
})
