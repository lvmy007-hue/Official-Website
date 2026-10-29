import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { future, ok, options, overview, past, placementOption, shipmentView, switchOff } from './inbound-fixtures.test-helper'

// 入仓计划详情（P2a-12、P6-10）：五步流程、按流程归位的页签、按状态给出的动作与守卫、方案倒计时与总成本推荐。

const pages: LivePages = {
  InboundPlansPage: { load: () => import('./InboundPlansPage') },
  InboundPlanDetailPage: { load: () => import('./InboundPlanDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const B = '/inbound/plans/p1'
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  [B]: () => ok(overview()),
  [`${B}/options`]: () => ok(options()),
  [`${B}/boxes`]: () => ok({ boxes: [], validation: { ok: false, rows: [], problems: [] }, groups: [] }),
  [`${B}/shipments`]: () => ok({ shipments: [] }),
  [`${B}/operations`]: () => ok({ operations: [] }),
  [`${B}/labels`]: () => ok({ labels: [], note: '箱标签从亚马逊获取', printStats: [] }),
  ...over,
})

const mount = (over: Record<string, Handler> = {}, permissions?: string[]) => mountApp({ url: '/app/supply-chain/p1', pages, handlers: handlers(over, permissions) })
// 页签按流程归位：先点外层（选品、装箱、分仓、运输、标签与发货、时间线、接收与差异、费用），再点里面的子页签
const tab = async (...names: string[]) => {
  for (const name of names) await userEvent.click(await screen.findByRole('tab', { name }))
}
const lastDialog = async () => {
  const dialogs = await screen.findAllByRole('dialog')
  return dialogs[dialogs.length - 1]
}
const post =
  (sink: { body?: unknown }): Handler =>
  (_url, init) => {
    sink.body = JSON.parse(String(init?.body))
    return { status: 201, body: { success: true, data: { plan: overview().plan, state: 'QUEUED', jobId: 'j1', operationId: 'o1' } } }
  }

describe('入仓计划详情', () => {
  it('五步流程加三个流程之外的页签；原来的页签归到各步里面；草稿只有资格预检与取消（预检通过后才能提交创建），没有由亚马逊预处理的选项', async () => {
    mount()
    expect(await screen.findByText('10 月补货')).toBeInTheDocument()
    const names = ['选品', '装箱', '分仓', '运输', '标签与发货', '时间线', '接收与差异', '费用']
    for (const name of names) expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    // 草稿停在“选品”，里面是“概览”“商品”两个子页签
    expect(screen.getAllByRole('tab')).toHaveLength(names.length + 2)
    expect(screen.getByRole('tab', { name: '概览' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '商品' })).toBeInTheDocument()
    await tab('装箱')
    expect(await screen.findByRole('tab', { name: '装箱方案' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '箱内物品' })).toBeInTheDocument()
    await tab('标签与发货')
    expect(await screen.findByRole('tab', { name: '货件' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '标签' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /资格预检/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /提交创建/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/由亚马逊(预处理|贴标)/)).not.toBeInTheDocument()
  })

  it('资格预检：先说明会做什么，确认后带版本提交，不需要写入开关', async () => {
    const sink: { body?: unknown } = {}
    mount({ [B]: () => ok(overview('DRAFT', {}, {}, switchOff)), [`${B}/eligibility`]: post(sink) })
    await userEvent.click(await screen.findByRole('button', { name: /资格预检/ }))
    const dialog = await lastDialog()
    expect(within(dialog).getByText(/逐个 SKU 向亚马逊查询/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /开始预检/ }))
    await waitFor(() => expect(sink.body).toEqual({ version: 3 }))
  })

  it('写入开关没打开：提交创建禁用并写明原因；取消本地草稿仍可用', async () => {
    mount({ [B]: () => ok(overview('ELIGIBILITY', {}, { externalPlanId: null }, switchOff)) })
    expect(await screen.findByRole('button', { name: /提交创建/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /资格预检/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /取消计划/ })).toBeEnabled()
  })

  it('没有 inbound.plan.write 权限：所有写动作禁用', async () => {
    mount({ [B]: () => ok(overview('ELIGIBILITY', {}, { externalPlanId: null })) }, ['inbound.read'])
    await screen.findByText('10 月补货')
    expect(screen.getByRole('button', { name: /提交创建/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /取消计划/ })).toBeDisabled()
  })

  it('有操作在途：提示处理中，不给任何写动作', async () => {
    mount({ [B]: () => ok(overview('CREATED', {}, { pendingOp: 'GENERATE_PACKING' })) })
    expect(await screen.findByText('有操作正在由后台任务处理')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /取消计划/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /生成装箱方案/ })).not.toBeInTheDocument()
  })

  it('上一次失败的原因显示在页面顶部', async () => {
    mount({ [B]: () => ok(overview('DRAFT', {}, { lastErrorMessage: '亚马逊拒绝：SKU-B 不能入仓' })) })
    expect(await screen.findByText('上一次操作没有成功')).toBeInTheDocument()
    // 同一条原因也写在出错的那一步下面
    expect(within(screen.getByTestId('step-panel')).getByText('亚马逊拒绝：SKU-B 不能入仓')).toBeInTheDocument()
  })

  it('五步流程条：每步显示状态；出错的步骤标红并默认选中；点步骤切到对应页签；不能做的操作写明原因', async () => {
    mount({ [B]: () => ok(overview('CREATED', {}, { lastErrorMessage: '亚马逊拒绝：SKU-B 不能入仓' })) })
    await screen.findByText('10 月补货')
    const steps = within(screen.getByTestId('flow-steps'))
    for (const name of ['选品', '装箱', '分仓', '运输', '标签与发货']) expect(steps.getByText(name)).toBeInTheDocument()
    expect(steps.getByText('已完成')).toBeInTheDocument()
    expect(steps.getByText('出错')).toBeInTheDocument()
    expect(steps.getAllByText('未开始')).toHaveLength(3)
    const panel = within(screen.getByTestId('step-panel'))
    expect(panel.getByText('装箱：出错')).toBeInTheDocument()
    expect(panel.getByTestId('step-allowed')).toHaveTextContent('生成装箱方案')
    expect(panel.getByTestId('step-blocked')).toHaveTextContent('保存装箱草稿：不能做')
    expect(screen.getByRole('tab', { name: '装箱', selected: true })).toBeInTheDocument()
    await userEvent.click(steps.getByText('分仓'))
    expect(screen.getByRole('tab', { name: '分仓', selected: true })).toBeInTheDocument()
    expect(within(screen.getByTestId('step-panel')).getByText('分仓：未开始')).toBeInTheDocument()
  })

  it('有操作在途：所在步骤写“亚马逊正在处理”，操作清单一个都不能做', async () => {
    mount({ [B]: () => ok(overview('PACKING_INFO_SUBMITTED', {}, { pendingOp: 'GENERATE_PLACEMENT' })) })
    await screen.findByText('10 月补货')
    const panel = within(screen.getByTestId('step-panel'))
    expect(panel.getByText('分仓：进行中')).toBeInTheDocument()
    expect(panel.getByText(/亚马逊正在处理：生成分仓方案/)).toBeInTheDocument()
    expect(panel.queryByTestId('step-allowed')).not.toBeInTheDocument()
  })

  it('装箱方案：显示有效期倒计时；过期的方案确认按钮禁用并写明原因；确认带方案编号与版本', async () => {
    const sink: { body?: unknown } = {}
    const packing = (id: string, expiresAt: string) => ({
      packingOptionId: id,
      status: 'OFFERED',
      fees: 3,
      discounts: 0,
      currency: 'USD',
      expiresAt,
      confirmed: false,
      shippingConfigs: [],
      groups: [{ packingGroupId: 'pg1', items: [{ sku: 'SKU-A', quantity: 10 }] }],
    })
    mount({
      [B]: () => ok(overview('CREATED')),
      [`${B}/options`]: () => ok(options({ packing: [packing('po-live', future()), packing('po-old', past())] })),
      [`${B}/packing-options`]: post(sink),
    })
    await screen.findByText('10 月补货')
    await tab('装箱', '装箱方案')
    const live = (await screen.findByText('po-live')).closest('tr, [role=row]') as HTMLElement
    const old = screen.getByText('po-old').closest('tr, [role=row]') as HTMLElement
    expect(within(live).getByTestId('countdown')).toHaveTextContent('剩余')
    expect(within(old).getByText('已过期')).toBeInTheDocument()
    expect(within(old).getByRole('button', { name: /确认这个方案/ })).toBeDisabled()
    await userEvent.click(within(live).getByRole('button', { name: /确认这个方案/ }))
    const dialog = await lastDialog()
    await userEvent.click(within(dialog).getByRole('checkbox'))
    await userEvent.click(within(dialog).getByRole('button', { name: /^确\s?认$/ }))
    await waitFor(() => expect(sink.body).toEqual({ action: 'CONFIRM', optionId: 'po-live', version: 3 }))
  })

  it('分仓方案：按总成本推荐并写明依据；没填估算的成本格写“未填估算”而不是 0', async () => {
    mount({
      [B]: () => ok(overview('PACKING_INFO_SUBMITTED')),
      [`${B}/options`]: () =>
        ok(
          options({
            placement: [placementOption('pl-a', 15, { recommended: true }), placementOption('pl-b', 30, { cheapestFee: true })].map(item => ({
              ...item,
              cost: { ...item.cost, freight: null, stockout: null, missing: ['运费估算'] },
            })),
            recommendation: { placementOptionId: 'pl-a', basis: 'PARTIAL', missing: ['运费估算'], note: '按已知项推荐：依据不完整，缺运费估算' },
          }),
        ),
    })
    await screen.findByText('10 月补货')
    await tab('分仓')
    expect(await screen.findByTestId('placement-recommendation')).toHaveTextContent('依据不完整')
    const row = screen.getByText('pl-a').closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('推荐（总成本最低）')).toBeInTheDocument()
    expect(within(row).getAllByText('未填估算')).toHaveLength(2)
    expect(within(screen.getByText('pl-b').closest('tr, [role=row]') as HTMLElement).getByText('分仓费最低')).toBeInTheDocument()
  })

  it('分仓方案确认：开关关闭时按钮禁用并写明原因', async () => {
    mount({
      [B]: () => ok(overview('PACKING_INFO_SUBMITTED', {}, {}, switchOff)),
      [`${B}/options`]: () => ok(options({ placement: [placementOption('pl-a', 15)] })),
    })
    await screen.findByText('10 月补货')
    await tab('分仓')
    const row = (await screen.findByText('pl-a')).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByRole('button', { name: /确认这个方案/ })).toBeDisabled()
  })

  it('箱内物品导入：有错误行时整份不能保存；正确时预览并带版本提交', async () => {
    const sink: { body?: unknown } = {}
    mount({
      [B]: () => ok(overview('PACKING_CONFIRMED')),
      [`${B}/boxes`]: (_url, init) => (init?.method === 'PUT' ? post(sink)(_url, init) : ok({ boxes: [], validation: { ok: false, rows: [], problems: [] }, groups: [] })),
    })
    await screen.findByText('10 月补货')
    await tab('装箱', '箱内物品')
    await userEvent.click(await screen.findByRole('button', { name: /导入箱内物品/ }))
    const dialog = await lastDialog()
    const area = within(dialog).getByRole('textbox', { name: '箱内物品' })
    await userEvent.type(area, 'BOX-1,SKU-A,0,22,16,12,10,2')
    await waitFor(() => expect(within(dialog).getByTestId('box-preview')).toHaveTextContent('有 1 行不能导入'))
    await userEvent.clear(area)
    await userEvent.type(area, 'BOX-1,SKU-A,10,22,16,12,10,2')
    await waitFor(() => expect(within(dialog).getByTestId('box-preview')).toHaveTextContent('预览：1 个箱型，共 2 箱'))
    await userEvent.click(within(dialog).getByRole('button', { name: /保\s?存/ }))
    await waitFor(() => expect(sink.body).toMatchObject({ version: 3, boxes: [{ boxId: 'BOX-1', quantity: 2, items: [{ sku: 'SKU-A', quantity: 10 }] }] }))
  })

  it('已确认运输方案：显示作废窗口倒计时与取消计划；窗口过了就没有取消', async () => {
    const deadlines = (deadline: string, expired: boolean) => ({
      placementExpiresAt: null,
      packingExpiresAt: null,
      voidWindow: { deadline, remainingMs: expired ? 0 : 3_600_000, expired, known: true },
    })
    mount({ [B]: () => ok(overview('TRANSPORT_CONFIRMED', { deadlines: deadlines(future(), false) })) })
    expect(await screen.findByRole('button', { name: /取消计划/ })).toBeEnabled()
    await tab('选品')
    expect(await screen.findByText(/作废窗口/)).toBeInTheDocument()
  })

  it('已发货且作废窗口已过：不提供取消计划', async () => {
    const deadlines = { placementExpiresAt: null, packingExpiresAt: null, voidWindow: { deadline: past(), remainingMs: 0, expired: true, known: true } }
    mount({ [B]: () => ok(overview('SHIPPED', { deadlines })) })
    await screen.findByText('10 月补货')
    expect(screen.queryByRole('button', { name: /取消计划/ })).not.toBeInTheDocument()
  })

  it('标签：获取亚马逊箱标签，带纸张（箱标签固定类型，不再有商品标签清单）', async () => {
    const sink: { body?: unknown } = {}
    mount({
      [B]: () => ok(overview('TRANSPORT_CONFIRMED')),
      [`${B}/shipments`]: () => ok({ shipments: [shipmentView()] }),
      [`${B}/labels/print-jobs`]: post(sink),
    })
    await screen.findByText('10 月补货')
    await tab('标签与发货', '标签')
    await userEvent.click(await screen.findByRole('button', { name: /获取亚马逊箱标签/ }))
    const dialog = await lastDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: /开始获取/ }))
    await waitFor(() => expect(sink.body).toEqual({ kind: 'BOX', pageType: 'PackageLabel_Letter_6' }))
  })

  it('时间线：每个异步操作的状态、亚马逊操作编号与失败原因都能看到；观察到的时间有标注', async () => {
    mount({
      [B]: () => ok(overview('CREATED')),
      [`${B}/shipments`]: () => ok({ shipments: [shipmentView()] }),
      [`${B}/operations`]: () =>
        ok({
          operations: [
            {
              id: 'op1',
              operation: 'GENERATE_PACKING',
              operationLabel: '生成装箱方案',
              amazonOperationId: 'amz-op-1',
              status: 'IN_PROGRESS',
              statusLabel: '亚马逊处理中',
              problems: [],
              errorCode: null,
              requestedBy: 'u1',
              startedAt: past(),
              finishedAt: null,
            },
            {
              id: 'op2',
              operation: 'CREATE_PLAN',
              operationLabel: '创建入仓计划',
              amazonOperationId: 'amz-op-0',
              status: 'FAILED',
              statusLabel: '失败',
              problems: [{ code: 'E1', message: 'SKU-B 不可入仓', severity: 'ERROR' }],
              errorCode: 'E1',
              requestedBy: 'u1',
              startedAt: past(),
              finishedAt: past(),
            },
          ],
        }),
      '/inbound/shipments/sh1/timeline': () =>
        ok({ shipmentId: 'FBA-SH-1', events: [{ at: past(), kind: 'RECEIVING', title: '开始接收', precision: 'OBSERVED', detail: null }], note: '时间线来自同步记录' }),
    })
    await screen.findByText('10 月补货')
    await tab('时间线')
    expect(await screen.findByText('amz-op-1')).toBeInTheDocument()
    expect(screen.getByText('亚马逊处理中')).toBeInTheDocument()
    expect(screen.getByText('E1：SKU-B 不可入仓')).toBeInTheDocument()
    expect(await screen.findByText('同步时观察到')).toBeInTheDocument()
  })

  it('接收与差异：未关闭的货件只显示待关闭；不合规报告没接入写“尚未接入”，赔付写“暂不判断”', async () => {
    mount({
      [B]: () => ok(overview('RECEIVING')),
      [`${B}/shipments`]: () => ok({ shipments: [shipmentView({ status: 'RECEIVING' })] }),
      '/inbound/shipments/sh1/discrepancies': () =>
        ok({
          shipmentId: 'FBA-SH-1',
          closed: false,
          rows: [{ sku: 'SKU-A', fnsku: 'X00A', shippedQty: 10, receivedQty: 4, discrepancyQty: null, state: 'PENDING', reason: null }],
          compliance: { state: 'NOT_CONNECTED', items: [], note: '来自入仓不合规报告' },
          claims: { state: 'NOT_JUDGED', items: [], window: null, note: '货件还没有关闭' },
          note: '货件关闭前不判定少收或多收',
        }),
    })
    await screen.findByText('10 月补货')
    await tab('接收与差异')
    expect(await screen.findByText('待货件关闭')).toBeInTheDocument()
    expect(screen.queryByText('少收')).not.toBeInTheDocument()
    expect(screen.getByText(/不合规问题：/)).toHaveTextContent('尚未接入')
    expect(screen.getByText(/赔付任务：/)).toHaveTextContent('暂不判断')
  })

  it('接收与差异：关闭后显示差异原因与不合规、赔付条数，并链到货件接收详情', async () => {
    mount({
      [B]: () => ok(overview('DISCREPANCY')),
      [`${B}/shipments`]: () => ok({ shipments: [shipmentView({ status: 'CLOSED' })] }),
      '/inbound/shipments/sh1/discrepancies': () =>
        ok({
          shipmentId: 'FBA-SH-1',
          closed: true,
          rows: [{ sku: 'SKU-A', fnsku: 'X00A', shippedQty: 10, receivedQty: 7, discrepancyQty: 3, state: 'SHORT', reason: 'Labeling' }],
          compliance: { state: 'OK', items: [{ sku: 'SKU-A', problemType: 'Labeling', qty: null, amount: null, currency: null, firstSeenAt: '2026-10-01T00:00:00.000Z', resolvedAt: null }], note: '' },
          claims: { state: 'OK', items: [], window: null, note: '' },
          note: '差异 = 发出数量 − 接收数量',
        }),
    })
    await screen.findByText('10 月补货')
    await tab('接收与差异')
    expect(await screen.findByText('少收')).toBeInTheDocument()
    expect(screen.getByText('Labeling')).toBeInTheDocument()
    expect(screen.getByText(/不合规问题：/)).toHaveTextContent('1 条')
    expect(screen.getByText(/赔付任务：/)).toHaveTextContent('尚无记录')
    expect(screen.getByRole('link', { name: /查看货件接收详情/ })).toHaveAttribute('href', '/app/warehouse/sh1')
  })

  it('费用：缺的项写明缺了什么，已知合计不把缺项当 0', async () => {
    mount()
    await screen.findByText('10 月补货')
    await tab('费用')
    expect((await screen.findAllByText(/分仓费/)).length).toBeGreaterThan(0)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('没有 inbound.read 权限：显示无权限', async () => {
    mount({ [B]: () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) })
    expect((await screen.findAllByText(/inbound\.read|FORBIDDEN|无权|没有权限/)).length).toBeGreaterThan(0)
  })
})
