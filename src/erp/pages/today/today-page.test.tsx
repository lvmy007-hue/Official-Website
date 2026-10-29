import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const pages: LivePages = { TodayPage: { load: () => import('./TodayPage') } }
const ok = (data: unknown) => ({ body: { success: true, data } })
afterEach(() => vi.unstubAllGlobals())

const summaryNotConnected = ok({
  realtimeState: 'NOT_CONNECTED',
  note: '实时数据未接入：需要部署专项配置亚马逊消息推送接收端（AMAZON_NOTIFICATION_DESTINATION_ID）',
  estimateNote: '实时估算，以日终数据为准；推送最长可能延迟 24 小时补发',
  businessDate: '2026-10-22',
  asOf: '2026-10-22T01:00:00Z',
  currency: 'USD',
  metricVersion: 'p2a-03@1',
  totals: { units: 7, salesAmount: 70, orders: 4 },
  compare: { yesterdaySameHour: null, lastWeekSameHour: null },
  inventory: { state: 'NOT_CONNECTED', note: '未接入', outOfStock: [], predictedStockout: [] },
  ads: { state: 'NOT_CONNECTED', note: '今日广告依赖营销数据流', workPackage: 'P3-06' },
  dailyFallback: { units: 7, salesAmount: 70, orders: 4, summaryDate: '2026-10-21', refreshedAt: '2026-10-22T01:00:00Z' },
})

const hourlyLive = ok({
  realtimeState: 'LIVE',
  note: '推送估算',
  estimateNote: '实时估算，以日终数据为准；推送最长可能延迟 24 小时补发',
  businessDate: '2026-10-22',
  asOf: '2026-10-22T12:00:00Z',
  currency: 'USD',
  hours: Array.from({ length: 24 }, (_, hour) => ({
    hourStart: `2026-10-22T${String(hour).padStart(2, '0')}:00:00.000Z`,
    units: hour === 10 ? 2 : 0,
    salesAmount: hour === 10 ? 20 : 0,
    pageViews: hour === 10 ? 40 : null,
    band: hour === 10 ? { unitsMin: 8, unitsMax: 14, pageViewsMin: 30, pageViewsMax: 90 } : null,
  })),
  anomalies: [
    {
      asin: 'B001',
      hourStart: '2026-10-22T10:00:00.000Z',
      metric: 'sales',
      value: 2,
      bandMin: 8,
      title: 'B001 小时销售低于历史同时段',
      suggestedAction: '核对活动、库存与竞品价格',
    },
  ],
})

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions: ['overview.read', 'workitem.assign'] }),
  '/today/summary': () => summaryNotConnected,
  '/today/hourly': () =>
    ok({
      realtimeState: 'NOT_CONNECTED',
      note: '未接入',
      estimateNote: '实时估算',
      businessDate: '2026-10-22',
      asOf: null,
      currency: 'USD',
      hours: [],
      anomalies: [],
    }),
  '/today/events': () => ok({ realtimeState: 'NOT_CONNECTED', note: '未接入', items: [], pageInfo: { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: null } }),
  ...over,
})

describe('今日实时页', () => {
  it('未接入：显示正式状态、日终退化与广告未接入，不出现示例实时曲线', async () => {
    mountApp({ url: '/app/today', pages, handlers: handlers() })
    expect(await screen.findByTestId('today-not-connected')).toBeInTheDocument()
    expect(screen.getByTestId('today-totals')).toHaveTextContent('7')
    expect(screen.getByTestId('today-totals')).toHaveTextContent('日终退化')
    expect(screen.getByTestId('today-ads')).toHaveTextContent('营销数据流')
    expect(screen.queryByRole('img', { name: '今日小时销售与流量' })).not.toBeInTheDocument()
  })

  it('已接入：显示小时曲线与异常；一键生成待办调用创建接口', async () => {
    const created: unknown[] = []
    mountApp({
      url: '/app/today',
      pages,
      handlers: handlers({
        '/today/summary': () =>
          ok({
            realtimeState: 'LIVE',
            note: '推送估算',
            estimateNote: '实时估算，以日终数据为准；推送最长可能延迟 24 小时补发',
            businessDate: '2026-10-22',
            asOf: '2026-10-22T12:00:00Z',
            currency: 'USD',
            metricVersion: 'p2a-03@1',
            totals: { units: 5, salesAmount: 50, orders: null },
            compare: {
              yesterdaySameHour: { units: 4, salesAmount: 40, label: '昨日同时段' },
              lastWeekSameHour: { units: 6, salesAmount: 60, label: '上周同日同时段' },
            },
            inventory: {
              state: 'OK',
              note: null,
              outOfStock: [{ asin: 'B002', availableQty: 0 }],
              predictedStockout: [{ asin: 'B001', availableQty: 1, predictedAtHour: '2026-10-22T18:00:00Z', note: '模型估算' }],
            },
            ads: { state: 'NOT_CONNECTED', note: '今日广告依赖营销数据流', workPackage: 'P3-06' },
            dailyFallback: null,
          }),
        '/today/hourly': () => hourlyLive,
        '/today/events': () =>
          ok({
            realtimeState: 'LIVE',
            note: '事件',
            items: [{ id: 'e1', occurredAt: '2026-10-22T09:00:00Z', kind: 'listing.change', title: '刊登变更', entityType: 'ASIN', entityId: 'B001', sellerAccountId: 's1' }],
            pageInfo: { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: 1 },
          }),
        '/work-items': (_url, init) => {
          if (init?.method === 'POST') {
            created.push(JSON.parse(String(init.body)))
            return ok({ id: 'w1' })
          }
          return ok({ items: [], pageInfo: { nextCursor: null, hasMore: false }, counts: null })
        },
      }),
    })
    expect(await screen.findByRole('img', { name: '今日小时销售与流量' })).toBeInTheDocument()
    expect(screen.getByTestId('today-anomalies')).toHaveTextContent('B001')
    expect(screen.getByTestId('today-inventory')).toHaveTextContent('B002')
    expect(screen.getByTestId('today-events')).toHaveTextContent('刊登变更')
    await userEvent.click(screen.getByRole('button', { name: /生成待办/ }))
    expect(created[0]).toMatchObject({ title: 'B001 小时销售低于历史同时段', entityType: 'ASIN', entityId: 'B001' })
  })

  it('汇总请求失败：显示错误态与重试，不把失败伪装成“实时数据未接入”或“尚无记录”（11.6 第 4 条）', async () => {
    mountApp({ url: '/app/today', pages, handlers: handlers({ '/today/summary': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect((await screen.findAllByText(/服务暂时不可用/, undefined, { timeout: 15000 })).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
    expect(screen.queryByTestId('today-not-connected')).not.toBeInTheDocument()
    expect(screen.queryByTestId('today-totals')).not.toBeInTheDocument()
    expect(screen.queryByTestId('today-events')).not.toBeInTheDocument()
  })

  it('小时曲线单独失败：汇总照常显示，并给出局部失败提示，不显示“尚无记录”冒充曲线', async () => {
    mountApp({ url: '/app/today', pages, handlers: handlers({ '/today/hourly': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: '服务暂时不可用' } } }) }) })
    expect(await screen.findByTestId('today-totals', undefined, { timeout: 15000 })).toHaveTextContent('7')
    expect(await screen.findByText(/小时曲线与小时级异常/, undefined, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.queryByTestId('today-hourly')).not.toBeInTheDocument()
  })
})
