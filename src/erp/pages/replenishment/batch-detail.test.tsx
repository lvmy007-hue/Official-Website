import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BatchDetailResponse } from '@nova/api-contracts'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok, rec, snapshot, summary } from './replenishment-fixtures.test-helper'

vi.mock('../../components/chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

// 补货批次详情（P2a-07）：冻结输入、执行情况、结果回看（按需评估）、建议明细。

const pages: LivePages = { ReplenishmentBatchDetailPage: { load: () => import('./ReplenishmentBatchDetailPage') } }

const detail = (over: Partial<BatchDetailResponse> = {}): BatchDetailResponse => ({
  batch: summary({ status: 'DRAFTED' }),
  snapshot: snapshot(),
  items: [rec()],
  page: 1,
  pageSize: 20,
  total: 1,
  execution: {
    purchaseOrders: [{ id: 'po1', number: 'PO-20261022-001', status: 'DRAFT', lineCount: 2 }],
    awdOrders: [{ id: 'awd1', reference: 'NOVA-AAAA', status: 'LOCAL_DRAFT', statusLabel: '本地草稿', lineCount: 3 }],
    inboundPlans: [
      { id: 'ip1', name: '补货批次 RB-20261022-001 · Northstar US', stage: 'DRAFT', stageLabel: '草稿', storeName: 'Northstar US', skuCount: 2, totalUnits: 150, shipFromAddressName: '深圳仓' },
    ],
    actionCounts: { ADOPT: 1, ADJUST: 0, IGNORE: 0, PURCHASE_DRAFT: 2, INBOUND_DRAFT: 1, AWD_DRAFT: 0 },
    pendingTargets: 1,
  },
  review: {
    outcomes: [],
    summary: { evaluated: 0, meanAbsErrorPct: null, stockoutDays: 0 },
    arrival: { state: 'NOT_CONNECTED', note: '是否按时到仓需要入仓计划与货件接收，尚未接入' },
  },
  ...over,
})

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/replenishment/batches/b1': () => ok(detail()),
  ...over,
})

describe('补货批次详情', () => {
  it('冻结输入、执行情况（决策计数、采购单草稿、只登记未生成单据的提醒）与到仓“尚未接入”说明', async () => {
    mountApp({ url: '/app/replenishment/batches/b1', pages, handlers: handlers() })
    expect(await screen.findByText('补货批次 RB-20261022-001')).toBeInTheDocument()
    expect(screen.getByText('企业 第 2 版')).toBeInTheDocument()
    expect(screen.getByText('2026-10-21')).toBeInTheDocument()
    expect(screen.getByText('采纳 1')).toBeInTheDocument()
    expect(screen.getByText('生成采购单草稿 2')).toBeInTheDocument()
    expect(screen.queryByText(/^忽略 /)).not.toBeInTheDocument()
    expect(screen.getByText(/采购单草稿 PO-20261022-001（DRAFT，2 行）/)).toBeInTheDocument()
    expect(screen.getByText(/上游仓储入库订单 NOVA-AAAA（本地草稿，3 个 SKU）/)).toBeInTheDocument()
    expect(screen.getByText(/入仓计划草稿 补货批次 RB-20261022-001 · Northstar US/)).toBeInTheDocument()
    expect(screen.getByText(/草稿，2 个 SKU，共 150 件，发货地址：深圳仓/)).toBeInTheDocument()
    expect(screen.getByText('有 1 条动作只登记了、没有生成单据')).toBeInTheDocument()
    expect(screen.getByText(/点“补建入仓草稿”/)).toBeInTheDocument()
    expect(screen.getByText('是否按时到仓需要入仓计划与货件接收，尚未接入')).toBeInTheDocument()
    expect(screen.getByText('SKU-A')).toBeInTheDocument()
  })

  it('没做任何决策、没评估：写“尚未做任何决策”“还没有评估结果”，统计写“尚无记录”而不是 0', async () => {
    mountApp({
      url: '/app/replenishment/batches/b1',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1': () =>
          ok(
            detail({
              execution: {
                purchaseOrders: [],
                awdOrders: [],
                inboundPlans: [],
                actionCounts: { ADOPT: 0, ADJUST: 0, IGNORE: 0, PURCHASE_DRAFT: 0, INBOUND_DRAFT: 0, AWD_DRAFT: 0 },
                pendingTargets: 0,
              },
            }),
          ),
      }),
    })
    expect(await screen.findByText('尚未做任何决策')).toBeInTheDocument()
    expect(screen.getByText(/还没有评估结果/)).toBeInTheDocument()
    expect(screen.getAllByText('尚无记录').length).toBeGreaterThanOrEqual(2)
  })

  it('已评估的结果：预测对比实际；实际为 0 或没有库存记录时写原因，不写 0', async () => {
    mountApp({
      url: '/app/replenishment/batches/b1',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1': () =>
          ok(
            detail({
              review: {
                outcomes: [
                  {
                    recommendationId: 'r1',
                    sku: 'SKU-A',
                    evaluatedAt: '2026-12-10',
                    windowStart: '2026-12-01',
                    windowEnd: '2026-12-08',
                    forecastQty: 80,
                    actualQty: 64,
                    errorPct: 0.25,
                    stockoutDays: 2,
                    excessUnits: 30,
                  },
                  {
                    recommendationId: 'r2',
                    sku: 'SKU-B',
                    evaluatedAt: '2026-12-10',
                    windowStart: '2026-12-01',
                    windowEnd: '2026-12-08',
                    forecastQty: 50,
                    actualQty: 0,
                    errorPct: null,
                    stockoutDays: 0,
                    excessUnits: null,
                  },
                ],
                summary: { evaluated: 2, meanAbsErrorPct: 0.25, stockoutDays: 2 },
                arrival: { state: 'NOT_CONNECTED', note: '尚未接入' },
              },
            }),
          ),
      }),
    })
    expect(await screen.findAllByText('2026-12-01 至 2026-12-08')).toHaveLength(2)
    expect(screen.getByText('实际为 0，无法计算')).toBeInTheDocument()
    expect(screen.getByText('尚无库存记录')).toBeInTheDocument()
    expect(screen.getByText('25.0%', { selector: '.erp-num' })).toBeInTheDocument()
  })

  it('评估预测误差：提交后显示服务端给出的结论（跳过原因），并重新取数', async () => {
    let posted = 0
    const app = mountApp({
      url: '/app/replenishment/batches/b1',
      pages,
      handlers: handlers({
        '/replenishment/batches/b1/evaluate': () => {
          posted += 1
          return { status: 201, body: { success: true, data: { evaluated: 0, skipped: 1, note: '1 条建议到仓不满 7 天，已跳过' } } }
        },
      }),
    })
    await screen.findByText('补货批次 RB-20261022-001')
    await userEvent.click(screen.getByRole('button', { name: '评估预测误差' }))
    const dialogs = await screen.findAllByRole('dialog')
    await userEvent.click(within(dialogs[dialogs.length - 1]).getByRole('button', { name: /开始评估/ }))
    expect(await screen.findByText('1 条建议到仓不满 7 天，已跳过')).toBeInTheDocument()
    expect(posted).toBe(1)
    await waitFor(() => expect(app.calls.filter(call => call.path === '/replenishment/batches/b1' && call.method === 'GET').length).toBeGreaterThanOrEqual(2))
  })

  it('没有“生成补货计划”权限：评估按钮禁用', async () => {
    mountApp({ url: '/app/replenishment/batches/b1', pages, handlers: handlers({}, ['replenishment.read']) })
    await screen.findByText('补货批次 RB-20261022-001')
    expect(screen.getByRole('button', { name: '评估预测误差' })).toBeDisabled()
  })

  it('批次不存在：显示服务端原因', async () => {
    mountApp({
      url: '/app/replenishment/batches/b1',
      pages,
      handlers: handlers({ '/replenishment/batches/b1': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '补货批次不存在' } } }) }),
    })
    expect(await screen.findByText(/补货批次不存在/)).toBeInTheDocument()
  })
})
