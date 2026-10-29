import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BRIDGE_DEFS } from '@nova/api-contracts'
import { defaultMe, mountApp } from '../../test/app-harness'
import type { LivePages } from '../../routes/live-pages'
import { ok } from './fee-fixtures.test-helper'
import { detailOf, diffOf, periodOf, previewOf, snapshotOf } from './periods-fixtures.test-helper'

// 期间关账详情的“关账报表预览”与“快照与差异”页签（P2b-13）：三种口径并排、没数据/没接入/没权限分别写明（不用 0 顶替）、
// 缺成本时净利润不给、已关账显示锁定的快照；差异报告写明对比的是什么、金额变化带正负号、没有的一边写“无”。

const pages: LivePages = { AccountingPeriodDetailPage: { load: () => import('./AccountingPeriodDetailPage') } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const T = { timeout: 30000 }
const show = async (data: unknown, tab: string) => {
  mountApp({ url: '/app/finance/periods/p1', pages, handlers: { '/auth/me': () => ok({ ...defaultMe, permissions: ['*'] }), '/finance/periods/p1': () => ok(data) } })
  await userEvent.click(await screen.findByRole('tab', { name: tab }, { timeout: 15000 }))
}
const rowOf = (text: string, root: HTMLElement = document.body) => within(root).getByText(text).closest('[row-id]') as HTMLElement

describe('关账报表预览', () => {
  it('三种口径并排：金额、没接入的项写“尚未接入”、净利润与件数；实时数据写明未锁定；汇率与成本版本的数量', T, async () => {
    await show(detailOf(), '关账报表预览')
    const preview = await screen.findByTestId('period-preview')
    expect(preview).toHaveTextContent('实时数据：未锁定')
    for (const name of ['下单口径', '发货口径', '结算释放口径']) expect(within(preview).getAllByText(name).length).toBeGreaterThan(0)
    const revenue = rowOf(BRIDGE_DEFS.REVENUE.label, preview)
    for (const text of ['$5,000.00', '$5,001.00', '$5,002.00']) expect(within(revenue).getByText(text)).toBeInTheDocument()
    expect(within(rowOf(BRIDGE_DEFS.DUTY.label, preview)).getAllByText('尚未接入')).toHaveLength(3)
    expect(within(rowOf('净利润', preview)).getByText('$1,001.00')).toBeInTheDocument()
    expect(rowOf('销售件数 / 已计成本件数', preview)).toHaveTextContent('100 / 98')
    expect(screen.getByTestId('period-preview-note')).toHaveTextContent('汇率：CAD（共 30 条）。生效中的成本版本 12 条。')
  })

  it('有商品缺成本：该口径净利润不给并写缺几行，不写 0', T, async () => {
    const preview = previewOf()
    preview.bases[0] = { ...preview.bases[0], netProfit: null, incompleteRows: 3 }
    await show(detailOf('OPEN', { preview }), '关账报表预览')
    const net = rowOf('净利润', await screen.findByTestId('period-preview'))
    expect(within(net).getByText('有 3 行缺成本，不给')).toBeInTheDocument()
    expect(net.textContent).not.toContain('$0.00')
  })

  it('没有成本字段权限：成本项写“无权查看”，成本版本数不显示', T, async () => {
    const preview = previewOf({ costVersions: null })
    for (const basis of preview.bases) basis.items = basis.items.map(item => (item.key === 'PRODUCT_COST' ? { ...item, value: null, state: 'RESTRICTED' as const } : item))
    await show(detailOf('OPEN', { preview }), '关账报表预览')
    const root = await screen.findByTestId('period-preview')
    expect(within(rowOf(BRIDGE_DEFS.PRODUCT_COST.label, root)).getAllByText('无权查看')).toHaveLength(3)
    expect(screen.getByTestId('period-preview-note')).toHaveTextContent('成本版本需要成本字段权限才显示')
  })

  it('没有利润字段权限：整块写“无权查看”，没有金额', T, async () => {
    await show(detailOf('OPEN', { preview: previewOf({ state: 'RESTRICTED', bases: [], fx: null, costVersions: null, note: '关账报表含利润数据，需要利润字段权限（field.profit）' }) }), '关账报表预览')
    expect(await screen.findByText('无权查看')).toBeInTheDocument()
    expect(screen.queryByTestId('period-preview')).toBeNull()
  })

  it('这个期间还没有利润日表数据：写原因', T, async () => {
    await show(detailOf('OPEN', { preview: previewOf({ state: 'NO_DATA', bases: [], note: '这段期间的利润日表没有数据：订单与财务交易同步完成后会自动派生' }) }), '关账报表预览')
    expect(await screen.findByText(/利润日表没有数据/)).toBeInTheDocument()
  })

  it('已关账：显示锁定的快照', T, async () => {
    await show(detailOf('CLOSED', { period: periodOf('CLOSED'), preview: previewOf({ source: 'SNAPSHOT' }) }), '关账报表预览')
    expect(await screen.findByTestId('period-preview')).toHaveTextContent('已锁定的快照')
  })
})

describe('快照与差异', () => {
  it('每次锁定一份：第几次、时间、人、三种口径的销售额与净利润、汇率与成本版本数；本次与上一份的差异', T, async () => {
    const diff = diffOf({ against: 'PREVIOUS_REVISION', compareRevision: 2, baseRevision: 1 })
    await show(detailOf('CLOSED', { period: periodOf('CLOSED'), snapshots: [snapshotOf(2, { hasDiff: true }), snapshotOf(1)], diff }), '快照与差异（2）')
    const list = await screen.findByTestId('period-snapshots')
    const second = rowOf('第 2 次', list)
    expect(within(second).getAllByText('李四', { exact: false }).length).toBeGreaterThan(0)
    expect(second).toHaveTextContent('下单口径：$5,000.00 / $1,000.00')
    expect(within(second).getByText('有')).toBeInTheDocument()
    expect(within(rowOf('第 1 次', list)).getByText('无')).toBeInTheDocument()
    const report = screen.getByTestId('period-diff')
    expect(report).toHaveTextContent('第 2 次锁定 对比 第 1 次关账')
    expect(report).toHaveTextContent('+$120.00')
    expect(within(report).getAllByText('SKU-DIFF-1')).toHaveLength(3)
    expect(report).toHaveTextContent('$100.00 → 无')
    expect(within(report).getByText('0.73 → 0.74')).toBeInTheDocument()
  })

  it('重新开账期间：对比的是上一份快照与现在的实时数据', T, async () => {
    await show(detailOf('REOPENED', { period: periodOf('REOPENED'), snapshots: [snapshotOf(1)], diff: diffOf() }), '快照与差异（1）')
    expect(await screen.findByTestId('period-diff')).toHaveTextContent('第 1 次关账')
    expect(screen.getByTestId('period-diff')).toHaveTextContent('对比 现在的实时数据')
  })

  it('没有变化：写“没有变化”，不列空表', T, async () => {
    await show(detailOf('REOPENED', { period: periodOf('REOPENED'), snapshots: [snapshotOf(1)], diff: diffOf({ hasChanges: false, bases: [] }) }), '快照与差异（1）')
    expect(await screen.findByText('没有变化')).toBeInTheDocument()
  })

  it('没有锁定过：写原因；没有差异报告也写明', T, async () => {
    await show(detailOf(), '快照与差异')
    expect(await screen.findByText(/尚未锁定过/)).toBeInTheDocument()
    expect(screen.getByText('暂无差异报告')).toBeInTheDocument()
  })

  it('没有利润字段权限：快照的利润写“无权查看”', T, async () => {
    await show(detailOf('CLOSED', { period: periodOf('CLOSED'), snapshots: [snapshotOf(1, { bases: null })] }), '快照与差异（1）')
    expect(within(rowOf('第 1 次', await screen.findByTestId('period-snapshots'))).getByText('无权查看')).toBeInTheDocument()
  })
})
