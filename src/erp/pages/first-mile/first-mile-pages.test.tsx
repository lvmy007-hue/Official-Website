import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { detail, forwarderRow, listResponse, ok, shipmentRow, transitRow, transitStats } from './first-mile-fixtures.test-helper'

// 头程物流列表、货代、实际时效与运单详情（P2a-11）：没有数据与没有权限的写法、动作守卫、写入带版本号、回写补货策略的确认。

const pages: LivePages = {
  FirstMilePage: { load: () => import('./FirstMilePage') },
  FirstMileDetailPage: { load: () => import('./FirstMileDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/first-mile': () => ok(listResponse()),
  '/first-mile/transit-stats': () => ok(transitStats()),
  '/first-mile/fm1': () => ok(detail()),
  '/freight-forwarders': () => ok({ items: [forwarderRow()], total: 1, page: 1, pageSize: 200 }),
  '/comments': () => ok({ items: [], watch: { watching: false, watchId: null, watchers: 0 } }),
  ...over,
})

describe('头程运单列表', () => {
  it('显示运单、阶段、逾期天数与费用；运单号链接到详情', async () => {
    mountApp({ url: '/app/first-mile', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: 'WB-1001' })
    expect(link).toHaveAttribute('href', '/app/first-mile/fm1')
    const row = link.closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('运输中')).toBeInTheDocument()
    expect(within(row).getByText('已逾期 3 天')).toBeInTheDocument()
    expect(within(row).getByText('$980.50')).toBeInTheDocument()
    expect(within(row).getByText('FBA-SHIP-1')).toBeInTheDocument()
  })

  it('没有 field.cost：预估与实际费用整列不显示；有权限但没有数据写“尚无记录”，不是 0', async () => {
    mountApp({ url: '/app/first-mile', pages, handlers: handlers({ '/first-mile': () => ok(listResponse([shipmentRow({ estimatedCost: undefined, actualCost: undefined })])) }, ['firstmile.read']) })
    await screen.findByRole('link', { name: 'WB-1001' })
    expect(screen.queryByText('预估费用')).not.toBeInTheDocument()
    expect(screen.queryByText('实际费用')).not.toBeInTheDocument()
  })

  it('有权限但没有费用记录：显示“尚无记录”', async () => {
    mountApp({ url: '/app/first-mile', pages, handlers: handlers({ '/first-mile': () => ok(listResponse([shipmentRow({ estimatedCost: null, actualCost: null })])) }) })
    const row = (await screen.findByRole('link', { name: 'WB-1001' })).closest('tr, [role=row]') as HTMLElement
    expect(within(row).getAllByText('尚无记录')).toHaveLength(2)
    expect(within(row).queryByText(/USD 0/)).not.toBeInTheDocument()
  })

  it('没有任何运单：说明前置条件，不是一张空表', async () => {
    mountApp({ url: '/app/first-mile', pages, handlers: handlers({ '/first-mile': () => ok(listResponse([])) }) })
    expect(await screen.findByText(/还没有头程运单/)).toBeInTheDocument()
  })

  it('没有 firstmile.write：新建按钮禁用', async () => {
    mountApp({ url: '/app/first-mile', pages, handlers: handlers({}, ['firstmile.read']) })
    await screen.findByRole('link', { name: 'WB-1001' })
    expect(screen.getByRole('button', { name: /新建运单/ })).toBeDisabled()
  })

  it('新建运单：货代、运单号与明细必填；成功后按填写内容发出', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/first-mile',
      pages,
      handlers: handlers({
        '/first-mile': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: { id: 'fm9', version: 1 } } }
          }
          return ok(listResponse())
        },
        '/first-mile/fm9': () => ok(detail()),
      }),
    })
    await screen.findByRole('link', { name: 'WB-1001' })
    await userEvent.click(screen.getByRole('button', { name: /新建运单/ }))
    const drawer = await screen.findByRole('dialog')
    await userEvent.click(within(drawer).getByRole('button', { name: /创\s*建\s*运\s*单/ }))
    expect(await within(drawer).findByText('请选择货代')).toBeInTheDocument()
    expect(within(drawer).getByText('请填写运单号')).toBeInTheDocument()
    expect(within(drawer).getByText('请填写 SKU')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(drawer).getByRole('textbox', { name: '运单号' }), 'WB-2002')
    await userEvent.type(within(drawer).getByRole('textbox', { name: 'SKU' }), 'SKU-Z')
    await userEvent.type(within(drawer).getByRole('spinbutton', { name: '数量' }), '12')
    await userEvent.click(within(drawer).getByRole('combobox', { name: '货代' }))
    await userEvent.click(await screen.findByTitle('海运通'))
    await userEvent.click(within(drawer).getByRole('button', { name: /创\s*建\s*运\s*单/ }))
    await waitFor(() => expect(body).toMatchObject({ forwarderId: 'f1', waybillNo: 'WB-2002', mode: 'SEA', currency: 'USD', items: [{ sku: 'SKU-Z', quantity: 12 }] }))
  })
})

describe('货代', () => {
  it('列表与新增：名称必填，成功后按填写内容发出', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/first-mile',
      pages,
      handlers: handlers({
        '/freight-forwarders': (_url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body))
            return { status: 201, body: { success: true, data: forwarderRow({ id: 'f2', name: '空运快' }) } }
          }
          return ok({ items: [forwarderRow()], total: 1, page: 1, pageSize: 200 })
        },
      }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '货代' }))
    expect(await screen.findByText('李四 13800000000')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /新增货代/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    expect(await within(dialog).findByText('请填写货代名称')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('textbox', { name: '名称' }), '空运快')
    await userEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    await waitFor(() => expect(body).toMatchObject({ name: '空运快' }))
  })
})

describe('实际时效', () => {
  const open = async (permissions: string[], rows = [transitRow()], policyVersionNo: number | null = 3, onApply?: (body: Record<string, unknown>) => void) => {
    mountApp({
      url: '/app/first-mile',
      pages,
      handlers: handlers(
        {
          '/first-mile/transit-stats': () => ok(transitStats(rows, policyVersionNo)),
          '/first-mile/transit-stats/apply': (_url, init) => {
            onApply?.(JSON.parse(String(init?.body)))
            return ok({ versionNo: 4, mode: 'SEA', transitDays: 31, previousDays: 30 })
          },
        },
        permissions,
      ),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '实际时效' }))
    await screen.findByText(/测试口径/)
  }
  /** 实际时效表里的那一行（运单列表页签还挂在页面上，名字会重复，所以按回写按钮找行）。 */
  const transitRowEl = async () => (await screen.findAllByRole('button', { name: '回写补货策略' }))[0].closest('tr, [role=row]') as HTMLElement

  it('显示样本数、p50、p90 与补货策略现用时效；确认后带着策略版本号回写', async () => {
    let body: Record<string, unknown> | undefined
    await open(['*'], [transitRow()], 3, value => (body = value))
    const row = await transitRowEl()
    expect(within(row).getByText('31 天')).toBeInTheDocument()
    expect(within(row).getByText('30 天')).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: '回写补货策略' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/改为 31 天/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /^回\s*写$/ }))
    await waitFor(() => expect(body).toEqual({ forwarderId: 'f1', mode: 'SEA', expectedVersionNo: 3 }))
  })

  it('样本不足：显示“样本不足”，回写按钮禁用', async () => {
    await open(['*'], [transitRow({ sampleCount: 2, p50Days: null, p90Days: null, minDays: null, maxDays: null, applyBlocked: '样本不足（至少 3 单已交付，现有 2 单）' })])
    const row = await transitRowEl()
    expect(within(row).getAllByText('样本不足').length).toBeGreaterThanOrEqual(2)
    expect(within(row).getByRole('button', { name: '回写补货策略' })).toBeDisabled()
  })

  it('没有回写补货策略的权限：按钮禁用', async () => {
    await open(['firstmile.read'])
    const row = await transitRowEl()
    expect(within(row).getByRole('button', { name: '回写补货策略' })).toBeDisabled()
  })

  it('企业级补货策略还没配置：按钮禁用并写明原因', async () => {
    await open(['*'], [transitRow({ applyBlocked: '企业级补货策略尚未配置，请先到补货策略页保存', policyTransitDays: null })], null)
    const row = await transitRowEl()
    expect(within(row).getByText('尚未设置')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '回写补货策略' })).toBeDisabled()
  })
})

describe('运单详情', () => {
  it('身份区与节点时间线：来源标明手工或货代文件；只有手工节点能删除', async () => {
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers() })
    expect((await screen.findAllByText('WB-1001')).length).toBeGreaterThan(0)
    expect(await screen.findByText(/31 天内（样本 6 单）/)).toBeInTheDocument()
    const manual = (await screen.findByText('离港或起飞')).closest('tr, [role=row]') as HTMLElement
    expect(within(manual).getByText('手工录入')).toBeInTheDocument()
    expect(within(manual).getByRole('button', { name: /删\s*除/ })).toBeInTheDocument()
    const imported = screen.getByText('到港').closest('tr, [role=row]') as HTMLElement
    expect(within(imported).getByText('货代文件导入')).toBeInTheDocument()
    expect(within(imported).queryByRole('button', { name: /删\s*除/ })).not.toBeInTheDocument()
  })

  it('录入费用：金额必填；提交带着页面看到的版本号', async () => {
    let body: Record<string, unknown> | undefined
    mountApp({
      url: '/app/first-mile/fm1',
      pages,
      handlers: handlers({
        '/first-mile/fm1/costs': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return ok({ id: 'fm1', version: 5 })
        },
      }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: '费用与分摊' }))
    expect(await screen.findByText('运费')).toBeInTheDocument()
    expect(screen.getByText('尚未分摊')).toBeInTheDocument()
    expect(screen.getByText(/按体积：缺少体积：SKU-B/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /录入费用/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^录\s*入$/ }))
    expect(await within(dialog).findByText('请填写金额')).toBeInTheDocument()
    expect(body).toBeUndefined()
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: '金额' }), '120.5')
    await userEvent.type(within(dialog).getByLabelText('发生日期'), '2026-10-10')
    await userEvent.click(within(dialog).getByRole('button', { name: /^录\s*入$/ }))
    await waitFor(() => expect(body).toMatchObject({ version: 4, item: 'FREIGHT', amount: 120.5, incurredAt: '2026-10-10' }))
  })

  it('已分摊：显示分摊明细与成本版本草稿；录入费用与重新分摊被禁用，撤销可用', async () => {
    const allocated = detail(
      {
        allocation: {
          method: 'VOLUME',
          methodLabel: '按体积',
          currency: 'USD',
          total: '980.5',
          createdAt: '2026-10-20T02:00:00.000Z',
          createdByName: '林然',
          lines: [
            { sku: 'SKU-A', quantity: 10, allocatedAmount: '300', unitCost: '30', costVersionNo: 2, costVersionStatus: 'DRAFT' },
            { sku: 'SKU-B', quantity: 20, allocatedAmount: '680.5', unitCost: '34.5', costVersionNo: 1, costVersionStatus: 'DRAFT' },
          ],
        },
        allocationReady: { VOLUME: null, WEIGHT: null, VALUE: null, QTY: null },
        actions: ['EDIT', 'ADD_MILESTONE', 'UNALLOCATE', 'OUTBOUND'],
      },
      { allocated: true },
    )
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(allocated) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '费用与分摊' }))
    expect(await screen.findByText('$34.50')).toBeInTheDocument()
    expect(screen.getAllByText(/草稿，待确认/)).toHaveLength(2)
    expect(screen.getByRole('button', { name: /录入费用/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /费用分摊/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /撤销分摊/ })).toBeEnabled()
  })

  it('没有 field.cost：费用与分摊整块写“无权查看”，身份区不出现费用', async () => {
    const hidden = detail({ costs: undefined, allocation: undefined, allocationReady: undefined })
    delete (hidden.shipment as { estimatedCost?: string | null }).estimatedCost
    delete (hidden.shipment as { actualCost?: string | null }).actualCost
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(hidden) }, ['firstmile.read']) })
    await screen.findAllByText('WB-1001')
    expect(screen.queryByText('预估费用')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '费用与分摊' }))
    expect(await screen.findByText(/无权查看：费用与分摊需要字段权限 field.cost/)).toBeInTheDocument()
  })

  it('出库：没选国内仓时按钮禁用；已出库也禁用；可出库时带版本号提交', async () => {
    let body: Record<string, unknown> | undefined
    const noWarehouse = detail({ actions: ['EDIT', 'ADD_MILESTONE', 'ADD_COST', 'ALLOCATE'] }, { warehouseId: null, warehouseName: null })
    const view = mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(noWarehouse) }) })
    await screen.findAllByText('WB-1001')
    expect(screen.getByRole('button', { name: /出\s*库/ })).toBeDisabled()
    view.unmount()

    mountApp({
      url: '/app/first-mile/fm1',
      pages,
      handlers: handlers({
        '/first-mile/fm1/outbound': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return ok({ id: 'fm1', version: 5 })
        },
      }),
    })
    await screen.findAllByText('WB-1001')
    await userEvent.click(screen.getByRole('button', { name: /出\s*库/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^出\s*库$/ }))
    await waitFor(() => expect(body).toEqual({ version: 4 }))
  })

  it('明细、关联入仓货件：采购单可点；没同步到的货件写明原因', async () => {
    const view = detail({ linkedInbound: [{ shipmentId: 'FBA-GONE', found: false, status: null, destinationFc: null, unitsExpected: null, unitsReceived: null, shippedUnits: null }] })
    mountApp({ url: '/app/first-mile/fm1', pages, handlers: handlers({ '/first-mile/fm1': () => ok(view) }) })
    await userEvent.click(await screen.findByRole('tab', { name: '明细' }))
    expect(await screen.findByRole('link', { name: 'PO-20261024-001' })).toHaveAttribute('href', '/app/purchase-orders/po1')
    expect(screen.getAllByText('未关联').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: '关联入仓货件' }))
    expect(await screen.findByText('FBA-GONE')).toBeInTheDocument()
    expect(screen.getByText('未在同步数据里找到')).toBeInTheDocument()
  })

  it('运单不存在：显示服务端给的原因', async () => {
    mountApp({
      url: '/app/first-mile/fm404',
      pages,
      handlers: handlers({ '/first-mile/fm404': () => ({ status: 404, body: { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: '头程运单不存在' } } }) }),
    })
    expect(await screen.findByText(/头程运单不存在|不存在/)).toBeInTheDocument()
  })
})
