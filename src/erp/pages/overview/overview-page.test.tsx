import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { lagText } from './OverviewPage'
import { baseHandlers } from './overview-fixtures.test-helper'

// 经营控制台里的“企业初始化与数据源健康”区域（P1-30 的内容，P2a-02 起并入控制台）。
// 假服务端返回固定数据，验证真实状态、如实空态与权限分流。控制台其余区域见 overview-dashboard.test.tsx。

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { OverviewPage: { load: () => import('./OverviewPage') } }
const ok = (data: unknown) => ({ body: { success: true, data } })
const summary: Record<string, Handler> = baseHandlers()
afterEach(() => vi.unstubAllGlobals())

const row = (patch: Record<string, unknown>) => ({
  sourceKey: 'orders.api',
  label: '订单',
  state: 'LIVE',
  status: 'NORMAL',
  statusLabel: '正常',
  lastSuccessAt: '2026-10-22T07:50:00Z',
  lagMinutes: 10,
  coverage: { total: 2, fresh: 2 },
  errorCode: null,
  errorMessage: null,
  note: null,
  ...patch,
})
const health = (rows: unknown[], patch: Record<string, unknown> = {}) => ok({ asOf: '2026-10-22T08:00:00Z', storeCount: 2, rows, summary: { completeness: 0.5, attention: 1 }, ...patch })
const onboarding = (patch: Record<string, unknown> = {}) =>
  ok({
    initialized: true,
    version: 2,
    completed: false,
    completedAt: null,
    currentStep: 'SELLER_AUTH',
    steps: [
      { key: 'PROFILE', title: '企业资料', required: true, state: 'COMPLETED' },
      { key: 'SELLER_AUTH', title: '授权卖家账号', required: true, state: 'PENDING' },
    ],
    tenant: {},
    quotas: [],
    firstSync: null,
    ...patch,
  })

describe('企业初始化与数据源健康', () => {
  it('显示真实状态：失败原因、覆盖店铺、延迟；未交付来源显示“尚未接入”，不出现示例数字', async () => {
    mountApp({
      url: '/app/overview',
      pages,
      handlers: {
        ...summary,
        '/onboarding': () => onboarding(),
        '/overview/source-health': () =>
          health([
            row({}),
            row({
              sourceKey: 'inventory.api',
              label: '库存',
              status: 'UNAUTHORIZED',
              statusLabel: '未授权',
              lastSuccessAt: null,
              lagMinutes: null,
              coverage: { total: 2, fresh: 1 },
              errorMessage: '亚马逊授权已失效，请重新授权',
            }),
            row({
              sourceKey: 'ads',
              label: '广告',
              state: 'NOT_DELIVERED',
              status: 'NO_RECORD',
              statusLabel: '尚未接入',
              lastSuccessAt: null,
              lagMinutes: null,
              coverage: null,
              note: '广告数据同步随阶段 3 接入',
            }),
          ]),
      },
    })
    expect(await screen.findByText('亚马逊授权已失效，请重新授权')).toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    const area = within(screen.getByTestId('source-health-section'))
    expect(area.getByText('尚未接入')).toBeInTheDocument()
    expect(area.getByText('广告数据同步随阶段 3 接入')).toBeInTheDocument()
    expect(area.getByText('去同步中心')).toBeInTheDocument()
    expect(area.getByText(/数据完整度 50%/)).toBeInTheDocument()
    expect(screen.getByText('下一步：授权卖家账号（必填）')).toBeInTheDocument()
  })

  it('没有 settings.write 的成员：不读取初始化进度，只提示由管理员负责', async () => {
    const app = mountApp({
      url: '/app/overview',
      pages,
      me: { ...defaultMe, permissions: ['overview.read'] },
      handlers: { ...summary, '/overview/source-health': () => health([row({})]) },
    })
    expect(await screen.findByText(/企业初始化由企业管理员负责/)).toBeInTheDocument()
    expect(app.calls.some(call => call.path === '/onboarding')).toBe(false)
  })

  it('初始化已完成时显示完成与首次同步', async () => {
    mountApp({
      url: '/app/overview',
      pages,
      handlers: {
        ...summary,
        '/onboarding': () => onboarding({ completed: true, completedAt: '2026-10-20T10:00:00Z', firstSync: { startedAt: '2026-10-20T10:01:00Z', jobs: 4, segments: 12 } }),
        '/overview/source-health': () => health([row({})]),
      },
    })
    expect(await screen.findByText(/企业初始化已完成/)).toBeInTheDocument()
    expect(screen.getByText(/4 个任务，历史回补共 12 段/)).toBeInTheDocument()
  })

  it('读取失败：显示原因，不显示表格', async () => {
    mountApp({
      url: '/app/overview',
      pages,
      handlers: { ...summary, '/onboarding': () => onboarding(), '/overview/source-health': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) },
    })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 8000 })).length).toBeGreaterThan(0)
    expect(screen.queryByText('订单')).not.toBeInTheDocument()
  })

  it('延迟的文字：分钟、小时、天，没有数据显示破折号', () => {
    expect([lagText(null), lagText(10), lagText(120), lagText(3 * 24 * 60)]).toEqual(['—', '10 分钟', '2 小时', '3 天'])
  })
})
