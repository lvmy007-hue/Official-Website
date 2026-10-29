import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultMe, mountApp, type Handler } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './inbound-fixtures.test-helper'
import { auditRows, discrepancyResponse, shipmentList, shipmentRow, statsResponse } from './receiving-fixtures.test-helper'

// 货件接收与差异（P2a-13）：列表列与筛选、赔付与不合规的“尚未接入”写法、接收时长统计与回写、详情各区块。

const pages: LivePages = {
  ShipmentReceivingPage: { load: () => import('./ShipmentReceivingPage') },
  ShipmentReceivingDetailPage: { load: () => import('./ShipmentReceivingDetailPage') },
}
afterEach(() => vi.unstubAllGlobals())

const detailRow = { ...shipmentRow(), transportStatus: 'DELIVERED', sellerAccountId: 'st1' }
const handlers = (over: Record<string, Handler> = {}, permissions: string[] = ['*']): Record<string, Handler> => ({
  '/auth/me': () => ok({ ...defaultMe, permissions }),
  '/inbound/shipments': () => ok(shipmentList()),
  '/inbound/receiving/stats': () => ok(statsResponse()),
  '/inbound/shipments/sh1': () => ok(detailRow),
  '/inbound/shipments/sh1/timeline': () =>
    ok({ shipmentId: 'FBA-SH-1', events: [{ at: '2026-09-01T08:00:00.000Z', kind: 'RECEIVING', title: '运营中心开始接收', precision: 'OBSERVED', detail: null }], note: '承运商的物流节点没有接入' }),
  '/inbound/shipments/sh1/discrepancies': () => ok(discrepancyResponse()),
  '/inbound/shipments/sh1/attachments': () => ok([]),
  '/inbound/shipments/sh1/audit': () => ok(auditRows()),
  ...over,
})

describe('货件接收与差异列表', () => {
  it('列出货件、应发已收差异、运输状态、追踪号、差异天数、赔付状态与不合规问题数；货件编号可点进详情', async () => {
    mountApp({ url: '/app/warehouse', pages, handlers: handlers() })
    const link = await screen.findByRole('link', { name: 'FBA-SH-1' })
    expect(link).toHaveAttribute('href', '/app/warehouse/sh1')
    const row = link.closest('tr, [role=row]') as HTMLElement
    expect(within(row).getByText('ONT8')).toBeInTheDocument()
    expect(within(row).getByText('已关闭')).toBeInTheDocument()
    expect(within(row).getByText('少收 3')).toBeInTheDocument()
    expect(within(row).getByText('DELIVERED')).toBeInTheDocument()
    expect(within(row).getByText('1Z999')).toBeInTheDocument()
    expect(within(row).getByText('12 天')).toBeInTheDocument()
    expect(within(row).getByText('等待期内')).toBeInTheDocument()
    expect(within(row).getByText('2')).toBeInTheDocument()
  })

  it('没有数据的格子写“尚无记录”；不合规报告没接入写“尚未接入”，货件未关闭赔付写“暂不判断”，都不写 0', async () => {
    const row = shipmentRow({
      status: 'RECEIVING',
      receivedUnits: null,
      discrepancyUnits: null,
      trackingNumber: null,
      receivedDoneAt: null,
      receiving: { transportStatus: null, discrepancyDays: null, claimState: 'NOT_JUDGED', noncomplianceCount: null },
    })
    mountApp({ url: '/app/warehouse', pages, handlers: handlers({ '/inbound/shipments': () => ok(shipmentList([row])) }) })
    const tr = (await screen.findByRole('link', { name: 'FBA-SH-1' })).closest('tr, [role=row]') as HTMLElement
    expect(within(tr).getByText('尚未接入')).toBeInTheDocument()
    expect(within(tr).getByText('货件未关闭，暂不判断')).toBeInTheDocument()
    expect(within(tr).getAllByText('尚无记录').length).toBeGreaterThanOrEqual(4)
    expect(within(tr).queryByText('0')).not.toBeInTheDocument()
  })

  it('筛选：只看有差异的货件、按运营中心，都带到接口参数里', async () => {
    const seen: string[] = []
    mountApp({
      url: '/app/warehouse',
      pages,
      handlers: handlers({
        '/inbound/shipments': url => {
          seen.push(url.search)
          return ok(shipmentList())
        },
      }),
    })
    await screen.findByRole('link', { name: 'FBA-SH-1' })
    await userEvent.click(screen.getByRole('checkbox', { name: /只看有未消除差异/ }))
    await waitFor(() => expect(seen.some(search => search.includes('discrepancy=1'))).toBe(true))
    const fc = screen.getByRole('searchbox', { name: '目的运营中心' })
    await userEvent.type(fc, 'ont8{enter}')
    await waitFor(() => expect(seen.some(search => search.includes('destinationFc=ONT8'))).toBe(true))
  })

  it('没有 inbound.read 权限：显示无权限而不是空表', async () => {
    mountApp({ url: '/app/warehouse', pages, handlers: handlers({ '/inbound/shipments': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: '没有权限' } } }) }) })
    expect((await screen.findAllByText(/inbound\.read|FORBIDDEN|无权/)).length).toBeGreaterThan(0)
  })

  it('空列表：说明还没有货件', async () => {
    mountApp({ url: '/app/warehouse', pages, handlers: handlers({ '/inbound/shipments': () => ok(shipmentList([])) }) })
    expect(await screen.findByText(/还没有货件/)).toBeInTheDocument()
  })
})

describe('接收时长统计与回写', () => {
  it('按运营中心列出样本与 p50、p90；样本不足的不允许回写并写明原因', async () => {
    mountApp({ url: '/app/warehouse', pages, handlers: handlers() })
    const panel = await screen.findByTestId('receiving-stats')
    const ont = (await within(panel).findByText('ONT8')).closest('tr, [role=row]') as HTMLElement
    expect(within(ont).getByRole('button', { name: '回写 p90' })).toBeEnabled()
    const phx = within(panel).getByText('PHX3').closest('tr, [role=row]') as HTMLElement
    expect(within(phx).getByRole('button', { name: '回写 p90' })).toBeDisabled()
    expect(within(panel).getByText(/当前补货策略的入仓接收天数：7 天/)).toBeInTheDocument()
  })

  it('没有补货策略写权限时回写按钮禁用', async () => {
    mountApp({ url: '/app/warehouse', pages, handlers: handlers({}, ['inbound.read']) })
    const panel = await screen.findByTestId('receiving-stats')
    const ont = (await within(panel).findByText('ONT8')).closest('tr, [role=row]') as HTMLElement
    expect(within(ont).getByRole('button', { name: '回写 p90' })).toBeDisabled()
  })

  it('确认后带上策略版本号提交；失败时显示服务端原因', async () => {
    let body: Record<string, unknown> | undefined
    let fail = true
    mountApp({
      url: '/app/warehouse',
      pages,
      handlers: handlers({
        '/inbound/receiving/stats/apply': (_url, init) => {
          body = JSON.parse(String(init?.body))
          return fail
            ? { status: 409, body: { error: { code: 'CONFLICT', message: '企业级补货策略已被他人修改，请刷新后再回写' } } }
            : { status: 200, body: { success: true, data: { versionNo: 5, receivingDays: 4, previousDays: 7, scopeLabel: 'ONT8' } } }
        },
      }),
    })
    const panel = await screen.findByTestId('receiving-stats')
    const ont = (await within(panel).findByText('ONT8')).closest('tr, [role=row]') as HTMLElement
    await userEvent.click(within(ont).getByRole('button', { name: '回写 p90' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('7 → 4 天')
    await userEvent.click(within(dialog).getByRole('button', { name: /确认回写/ }))
    expect(await screen.findByText(/已被他人修改/)).toBeInTheDocument()
    expect(body).toEqual({ destinationFc: 'ONT8', expectedVersionNo: 4 })
    fail = false
    await userEvent.click(await screen.findByRole('button', { name: /确认回写/ }))
    expect(await screen.findByText('已回写，补货策略生成了新版本')).toBeInTheDocument()
  })
})

describe('货件接收详情', () => {
  it('身份区、接收时间线、SKU 差异（含差异原因）、不合规问题、赔付任务、审计记录', async () => {
    mountApp({ url: '/app/warehouse/sh1', pages, handlers: handlers() })
    const identity = await screen.findByTestId('shipment-identity')
    expect(identity).toHaveTextContent('FBA15ABC')
    expect(identity).toHaveTextContent('10 月补货')
    expect(await screen.findByText('运营中心开始接收')).toBeInTheDocument()
    expect(screen.getByText('同步时观察到')).toBeInTheDocument()
    const skuRow = (await screen.findAllByText('SKU-A'))[0].closest('tr, [role=row]') as HTMLElement
    expect(within(skuRow).getByText('少收')).toBeInTheDocument()
    expect(within(skuRow).getByText('Labeling')).toBeInTheDocument()
    const claims = await screen.findByTestId('claims-section')
    expect(claims).toHaveTextContent('申请截止 2028-02-26')
    expect(claims).toHaveTextContent('无商品成本，无法估算')
    expect(await screen.findByText('上传证据附件')).toBeInTheDocument()
    expect(screen.getByText('还没有附件')).toBeInTheDocument()
  })

  it('不合规报告没接入写“尚未接入”；货件未关闭时赔付写明关闭后才判断', async () => {
    const response = discrepancyResponse({
      closed: false,
      compliance: { state: 'NOT_CONNECTED', items: [], note: '来自入仓不合规报告' },
      claims: { state: 'NOT_JUDGED', items: [], window: null, note: '货件还没有关闭，关闭之后才判断是否有赔付机会。' },
    })
    mountApp({ url: '/app/warehouse/sh1', pages, handlers: handlers({ '/inbound/shipments/sh1/discrepancies': () => ok(response) }) })
    expect(await within(await screen.findByTestId('noncompliance-section')).findByText('尚未接入')).toBeInTheDocument()
    const claims = screen.getByTestId('claims-section')
    expect(claims).toHaveTextContent('货件关闭后才判断赔付机会')
    expect(within(claims).getByText('尚无记录')).toBeInTheDocument()
  })

  it('地址里用亚马逊的货件编号也能打开，其余内容用货件行编号请求', async () => {
    const seen: string[] = []
    mountApp({
      url: '/app/warehouse/FBA-SH-1',
      pages,
      handlers: handlers({
        '/inbound/shipments/FBA-SH-1': () => ok(detailRow),
        '/inbound/shipments/sh1/audit': url => {
          seen.push(url.pathname)
          return ok(auditRows())
        },
      }),
    })
    expect(await screen.findByTestId('shipment-identity')).toBeInTheDocument()
    await waitFor(() => expect(seen).toHaveLength(1))
  })

  it('货件不存在：显示错误而不是空页面', async () => {
    mountApp({ url: '/app/warehouse/nope', pages, handlers: handlers({ '/inbound/shipments/nope': () => ({ status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message: '货件不存在' } } }) }) })
    expect(await screen.findByText(/货件不存在/)).toBeInTheDocument()
  })

  it('没有 inbound.plan.write 权限时上传附件按钮禁用', async () => {
    mountApp({ url: '/app/warehouse/sh1', pages, handlers: handlers({}, ['inbound.read']) })
    await screen.findByTestId('shipment-identity')
    expect(await screen.findByRole('button', { name: '上传附件' })).toBeDisabled()
  })
})
