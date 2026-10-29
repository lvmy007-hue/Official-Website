import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { latestPerObject } from './PolicyDrawer'
import { ok, policies, policy, recommendations, summary } from './replenishment-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 补货策略抽屉（P2a-07）：三级策略、版本历史、旧版规则“待补齐”、保存新版本带乐观锁版本号。

const pages: LivePages = { ReplenishmentPage: { load: () => import('./ReplenishmentPage') } }

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/replenishment/batches': () => ok({ items: [summary()], page: 1, pageSize: 20, total: 1 }),
  '/replenishment/recommendations': () => ok(recommendations()),
  ...over,
})

const openDrawer = async () => {
  await screen.findByText('SKU-A')
  await userEvent.click(screen.getByRole('button', { name: '补货策略' }))
  return screen.findByRole('dialog')
}

describe('latestPerObject', () => {
  it('每个（级别, 对象）只留第一条（列表已按版本倒序）', () => {
    const items = [policy({ versionNo: 3 }), policy({ versionNo: 2 }), policy({ level: 'SKU', levelRef: 'SKU-A', versionNo: 1 })]
    expect(latestPerObject(items).map(item => `${item.level}:${item.levelRef}:${item.versionNo}`)).toEqual(['TENANT:ALL:3', 'SKU:SKU-A:1'])
  })
  it('空列表返回空数组', () => {
    expect(latestPerObject([])).toEqual([])
  })
})

describe('补货策略抽屉', () => {
  it('当前版本一行一个对象；有历史版本的对象可展开看旧版本与原因', async () => {
    const items = [policy({ versionNo: 2, changeReason: '旺季前调整' }), policy({ versionNo: 1, changeReason: '初始设置' })]
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/policies': () => ok(policies(items)) }) })
    const drawer = await openDrawer()
    expect(await within(drawer).findByText('全部（企业默认）')).toBeInTheDocument()
    expect(within(drawer).getByText('第 2 版')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByText('第 2 版'))
    expect(await screen.findByText('初始设置')).toBeInTheDocument()
    expect(screen.getByText('第 1 版')).toBeInTheDocument()
  })

  it('旧版库存规则保存的策略：标“待补齐”，并说明补齐前不产出建议，不套默认值', async () => {
    const legacy = policy({ serviceLevel: null, productionDays: null, domesticDays: null, receivingDays: null, transportPreference: null, transportOptions: [] })
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/policies': () => ok(policies([legacy])) }) })
    const drawer = await openDrawer()
    expect(await within(drawer).findByText(/待补齐/, { selector: '.ant-tag *, .ant-tag' })).toBeInTheDocument()
    expect(within(drawer).getByText('有策略待补齐')).toBeInTheDocument()
    expect(within(drawer).getAllByText('未设置').length).toBeGreaterThan(0)
  })

  it('没有企业级策略：提示先设置，并给出“设置企业级策略”入口', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/policies': () => ok({ ...policies([]), tenantCurrent: null }) }) })
    const drawer = await openDrawer()
    expect(await within(drawer).findByText('尚未配置企业级策略')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: '设置企业级策略' })).toBeEnabled()
  })

  it('保存新版本：提交带上当前版本号、调整原因与运输选项', async () => {
    let body: Record<string, unknown> | undefined
    const app = mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/policies': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body))
            return ok(policy({ versionNo: 3 }))
          }
          return ok(policies())
        },
      }),
    })
    const drawer = await openDrawer()
    await userEvent.click(await within(drawer).findByRole('button', { name: /保存新版本/ }))
    const dialogs = await screen.findAllByRole('dialog')
    const form = dialogs[dialogs.length - 1]
    await userEvent.type(within(form).getByLabelText('调整原因'), '海运改 35 天')
    await userEvent.click(within(form).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() =>
      expect(body).toMatchObject({
        expectedVersionNo: 2,
        level: 'TENANT',
        levelRef: 'ALL',
        serviceLevel: 0.95,
        productionDays: 10,
        transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
        changeReason: '海运改 35 天',
      }),
    )
    expect(app.calls.filter(call => call.path === '/replenishment/policies' && call.method === 'PUT')).toHaveLength(1)
  })

  it('“建议量计入必断货量”开关：默认关闭，打开后随新版本提交；列表列出当前取值', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/policies': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body))
            return ok(policy({ versionNo: 3, includeUnavoidableShortage: true }))
          }
          return ok(policies())
        },
      }),
    })
    const drawer = await openDrawer()
    expect(await within(drawer).findByText('不计入')).toBeInTheDocument()
    await userEvent.click(await within(drawer).findByRole('button', { name: /保存新版本/ }))
    const dialogs = await screen.findAllByRole('dialog')
    const form = dialogs[dialogs.length - 1]
    const toggle = within(form).getByRole('switch', { name: '建议量计入必断货量' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    await userEvent.type(within(form).getByLabelText('调整原因'), '大促前提前备货')
    await userEvent.click(within(form).getByRole('button', { name: /^保\s?存$/ }))
    await waitFor(() => expect(body).toMatchObject({ includeUnavoidableShortage: true, changeReason: '大促前提前备货' }))
  })

  it('版本冲突（别人刚改过）：显示服务端原因，不静默覆盖', async () => {
    mountApp({
      url: '/app/replenishment',
      pages,
      handlers: handlers({
        '/replenishment/policies': (_url, init) =>
          init?.method === 'PUT' ? { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: '策略已被他人更新，请刷新后重试' } } } : ok(policies()),
      }),
    })
    const drawer = await openDrawer()
    await userEvent.click(await within(drawer).findByRole('button', { name: /保存新版本/ }))
    const dialogs = await screen.findAllByRole('dialog')
    const form = dialogs[dialogs.length - 1]
    await userEvent.type(within(form).getByLabelText('调整原因'), '改一下')
    await userEvent.click(within(form).getByRole('button', { name: /^保\s?存$/ }))
    expect((await screen.findAllByText(/策略已被他人更新/)).length).toBeGreaterThan(0)
  })

  it('没有策略写权限：保存与新增按钮都禁用', async () => {
    mountApp({ url: '/app/replenishment', pages, handlers: handlers({ '/replenishment/policies': () => ok(policies()) }, ['replenishment.read']) })
    const drawer = await openDrawer()
    expect(await within(drawer).findByRole('button', { name: /保存新版本/ })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: '新增品类级策略' })).toBeDisabled()
    expect(within(drawer).getByRole('button', { name: '新增 SKU 级策略' })).toBeDisabled()
  })
})
