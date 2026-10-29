import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EChartsOption } from 'echarts'
import { ApiError } from '../../api'
import { renderWithApp } from '../test/render'
import { compareBeforeAfter, decomposeBridge, decomposeProduct, diffSnapshots, evaluateDualSource } from './insight/analysis'
import { BeforeAfter } from './insight/BeforeAfter'
import { MetricTreeAttribution } from './insight/MetricTreeAttribution'
import { DualSourceCheck } from './insight/DualSourceCheck'
import { EVENT_KINDS, EVENT_KIND_LABEL, EventTimeline, filterEvents, type TimelineEvent } from './insight/EventTimeline'
import { TraceDialog, type TraceInfo } from './insight/TraceDialog'
import { EstimateTag } from './insight/EstimateTag'
import { SnapshotDiff } from './insight/SnapshotDiff'
import { OperationLog } from './insight/OperationLog'
import { downsample, withEventMarks } from './chart/chart-utils'
import { ChartPanel } from './chart/ChartPanel'

vi.mock('./chart/ErpChart', () => ({
  ErpChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}))

describe('前后对照计算', () => {
  it('对象变化、大盘变化、净变化', () => {
    const r = compareBeforeAfter({ before: [10, 10], after: [15, 15], benchBefore: [100, 100], benchAfter: [120, 120] })
    expect(r.change).toBeCloseTo(0.5)
    expect(r.benchChange).toBeCloseTo(0.2)
    expect(r.adjusted).toBeCloseTo(0.3)
    expect(r.days).toEqual({ before: 2, after: 2 })
  })
  it('前期为 0 时无法算比率；没有大盘参照时不给净变化', () => {
    const r = compareBeforeAfter({ before: [0, 0], after: [5] })
    expect(r.change).toBeNull()
    expect(r.adjusted).toBeNull()
    expect(compareBeforeAfter({ before: [10], after: [12] }).adjusted).toBeNull()
  })
  it('页面：缺少大盘参照时明确提示不能判断操作效果', () => {
    renderWithApp(<BeforeAfter title="改价" windowDays={7} metrics={[{ key: 's', label: '销售额', format: 'money', before: [100], after: [130] }]} />)
    expect(screen.getByText('改价：前 7 天 对比 后 7 天')).toBeInTheDocument()
    expect(screen.getByText(/没有同期大盘参照/)).toBeInTheDocument()
  })
  it('页面：有大盘参照时显示净变化', async () => {
    renderWithApp(<BeforeAfter title="改价" windowDays={7} metrics={[{ key: 's', label: '销售额', format: 'money', before: [100], after: [150], benchBefore: [1000], benchAfter: [1200] }]} />)
    expect(await screen.findByText('+30.0%')).toBeInTheDocument()
  })
})

describe('指标树归因', () => {
  const factors = [
    { key: 'sessions', label: '会话', before: 1000, after: 1200 },
    { key: 'cvr', label: '转化率', before: 0.1, after: 0.09 },
    { key: 'aov', label: '件单价', before: 20, after: 22 },
  ]
  it('乘积型分解：各因子贡献之和恰好等于总变化，按贡献大小排序', () => {
    const result = decomposeProduct(factors)!
    const v0 = 1000 * 0.1 * 20
    const v1 = 1200 * 0.09 * 22
    expect(result.total).toBeCloseTo(v1 - v0, 8)
    expect(result.contributions.reduce((s, c) => s + c.contribution, 0)).toBeCloseTo(v1 - v0, 8)
    const abs = result.contributions.map(c => Math.abs(c.contribution))
    expect([...abs].sort((a, b) => b - a)).toEqual(abs)
    expect(result.contributions.find(c => c.key === 'cvr')!.contribution).toBeLessThan(0)
  })
  it('因子没有变化时贡献为 0；总变化为 0 时占比为空', () => {
    const r = decomposeProduct([
      { key: 'a', label: 'a', before: 2, after: 2 },
      { key: 'b', label: 'b', before: 3, after: 3 },
    ])!
    expect(r.total).toBe(0)
    expect(r.contributions.every(c => c.contribution === 0 && c.share === null)).toBe(true)
  })
  it('因子为 0 或缺失时无法分解', () => {
    expect(decomposeProduct([{ key: 'a', label: 'a', before: 0, after: 3 }])).toBeNull()
    expect(decomposeProduct([])).toBeNull()
  })
  it('利润桥：成本增加拉低利润，贡献之和等于利润变化', () => {
    const r = decomposeBridge([
      { key: 'rev', label: '收入', before: 1000, after: 1200 },
      { key: 'fee', label: '平台费用', before: 300, after: 400, cost: true },
      { key: 'ads', label: '广告', before: 100, after: 90, cost: true },
    ])
    expect(r.total).toBe(110)
    expect(r.contributions[0]).toMatchObject({ key: 'rev', contribution: 200 })
    expect(r.contributions.find(c => c.key === 'fee')!.contribution).toBe(-100)
  })
  it('页面：标注主因；无法归因时说明原因', () => {
    const { unmount } = renderWithApp(<MetricTreeAttribution title="销售额" kind="product" factors={factors} formatTotal={n => n.toFixed(0)} />)
    expect(screen.getByText(/主因/)).toBeInTheDocument()
    expect(screen.getByText(/各因子贡献之和等于总变化/)).toBeInTheDocument()
    unmount()
    renderWithApp(<MetricTreeAttribution title="销售额" kind="product" factors={[{ key: 'a', label: 'a', before: 0, after: 1 }]} formatTotal={String} />)
    expect(screen.getByText(/无法归因/)).toBeInTheDocument()
  })
})

describe('双源核对', () => {
  it('超过阈值标注；官方为 0 而我方不为 0 视为需要关注', () => {
    expect(evaluateDualSource(105, 100, 0.03)).toMatchObject({ diff: 5, flagged: true })
    expect(evaluateDualSource(101, 100, 0.03).flagged).toBe(false)
    expect(evaluateDualSource(5, 0, 0.03)).toMatchObject({ diffRatio: null, flagged: true })
    expect(evaluateDualSource(0, 0, 0.03)).toMatchObject({ diffRatio: 0, flagged: false })
  })
  it('页面：差异超阈值时分解原因并列出尚未解释的部分', () => {
    renderWithApp(<DualSourceCheck title="本期利润" format="money" ours={1100} official={1000} thresholdRatio={0.02} reasons={[{ label: '退款口径不同', amount: 60 }]} />)
    expect(screen.getByText(/差异超过 2.0%/)).toBeInTheDocument()
    expect(screen.getByText('退款口径不同：$60.00')).toBeInTheDocument()
    expect(screen.getByText('尚未解释的差异：$40.00')).toBeInTheDocument()
  })
  it('页面：一致时不显示分解', () => {
    renderWithApp(<DualSourceCheck title="本期利润" format="number" ours={1000} official={1000} thresholdRatio={0.02} reasons={[]} />)
    expect(screen.getByText('一致')).toBeInTheDocument()
    expect(screen.queryByText('差异原因分解')).toBeNull()
  })
})

describe('事件标注时间轴', () => {
  const events: TimelineEvent[] = [
    { id: '1', at: '2026-10-10T10:00:00Z', kind: 'price', title: '价格 19.99 → 17.99', origin: 'system', actor: '林然' },
    { id: '2', at: '2026-10-12T10:00:00Z', kind: 'third-party-edit', title: '详情页被他人修改', origin: 'amazon' },
    { id: '3', at: '2026-10-11T10:00:00Z', kind: 'stockout', title: '断货', origin: 'amazon' },
  ]
  it('覆盖计划列出的 11 类事件', () => {
    expect(EVENT_KINDS).toHaveLength(11)
    expect(Object.keys(EVENT_KIND_LABEL).sort()).toEqual([...EVENT_KINDS].sort())
  })
  it('按时间倒序；可按类型筛选；标明来源', async () => {
    expect(filterEvents(events, new Set(EVENT_KINDS)).map(e => e.id)).toEqual(['2', '3', '1'])
    renderWithApp(<EventTimeline events={events} />)
    expect(screen.getAllByText('亚马逊侧').length).toBe(2)
    expect(screen.getByText('系统内操作')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: '改价' }))
    expect(screen.queryByText('价格 19.99 → 17.99')).toBeNull()
    expect(screen.getByText('断货')).toBeInTheDocument()
  })
  it('没有事件时说明；提供对照入口时触发回调', async () => {
    const { unmount } = renderWithApp(<EventTimeline events={[]} />)
    expect(screen.getByText('所选范围内没有可标注的事件')).toBeInTheDocument()
    unmount()
    const onCompare = vi.fn()
    renderWithApp(<EventTimeline events={events} onCompare={onCompare} />)
    await userEvent.click(screen.getByLabelText('对照分析：断货'))
    expect(onCompare).toHaveBeenCalledWith(expect.objectContaining({ id: '3' }))
  })
})

describe('可追溯弹层', () => {
  const info: TraceInfo = {
    metric: '净利润',
    definition: '收入减去全部成本',
    formula: '收入 − 费用 − 成本',
    source: '结算报告',
    records: [{ label: '结算单 2026-10-01', href: '/app/settlements/s1' }],
    syncedAt: '2026-10-20T10:00:00Z',
    quality: { level: 'warning', notes: ['有 3 笔费用未匹配'] },
    definitionVersion: 'v3',
  }
  it('口径、公式、来源、来源记录、同步时间、数据质量', () => {
    renderWithApp(<TraceDialog open onClose={() => undefined} info={info} />)
    expect(screen.getByText('追溯：净利润')).toBeInTheDocument()
    expect(screen.getByText('收入减去全部成本')).toBeInTheDocument()
    expect(screen.getByText('收入 − 费用 − 成本')).toBeInTheDocument()
    expect(screen.getByText('结算报告')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '结算单 2026-10-01' })).toHaveAttribute('href', expect.stringContaining('/app/settlements/s1'))
    expect(screen.getByText('2026-10-20 03:00 PDT')).toBeInTheDocument()
    expect(screen.getByText('存在提示')).toBeInTheDocument()
    expect(screen.getByText('有 3 笔费用未匹配')).toBeInTheDocument()
  })
  it('加载中显示骨架；出错显示错误与重试', async () => {
    const onRetry = vi.fn()
    const { rerender } = renderWithApp(<TraceDialog open onClose={() => undefined} loading />)
    expect(screen.getByLabelText('正在加载')).toBeInTheDocument()
    rerender(<TraceDialog open onClose={() => undefined} error={new ApiError(500, 'X', '出错')} onRetry={onRetry} />)
    await userEvent.click(await screen.findByRole('button', { name: /重\s*试/ }))
    expect(onRetry).toHaveBeenCalled()
  })
})

describe('模型估算标注', () => {
  it('标注“模型估算”，悬停显示方法与区间；近实时标注为“实时估算”', async () => {
    const { unmount } = renderWithApp(<EstimateTag method="近 28 天移动平均" range="低 120 / 中 150 / 高 190 件" />)
    await userEvent.hover(screen.getByText('模型估算'))
    expect(await screen.findByText(/方法：近 28 天移动平均/)).toBeInTheDocument()
    expect(screen.getByText(/区间：低 120/)).toBeInTheDocument()
    unmount()
    renderWithApp(<EstimateTag method="小时级推送累计" realtime />)
    expect(screen.getByText('实时估算')).toBeInTheDocument()
  })
})

describe('历史快照对比', () => {
  const labels = { title: '标题', price: '价格', bullets: '五点描述' }
  it('只比较有中文名称的字段；数组按顿号连接；空值显示“（空）”', () => {
    const changes = diffSnapshots({ title: 'A', price: 19.99, bullets: ['x', 'y'], internalId: 1 }, { title: 'A', price: 17.99, bullets: ['x'], internalId: 2 }, labels)
    expect(changes).toEqual([
      { key: 'price', label: '价格', before: '19.99', after: '17.99' },
      { key: 'bullets', label: '五点描述', before: 'x、y', after: 'x' },
    ])
    expect(diffSnapshots({}, { title: 'B' }, labels)[0]).toMatchObject({ before: '（空）', after: 'B' })
  })
  it('页面：没有快照时说明；选了两天显示差异；无差异时说明', async () => {
    const { unmount } = renderWithApp(<SnapshotDiff title="刊登快照" availableDates={[]} dates={[null, null]} onDatesChange={() => undefined} labels={labels} />)
    expect(screen.getByText(/还没有历史快照/)).toBeInTheDocument()
    unmount()
    const { rerender } = renderWithApp(
      <SnapshotDiff
        title="刊登快照"
        availableDates={['2026-10-01', '2026-10-10']}
        dates={['2026-10-01', '2026-10-10']}
        onDatesChange={() => undefined}
        labels={labels}
        snapshots={[{ price: 19.99 }, { price: 17.99 }]}
      />,
    )
    expect(await screen.findByText('19.99')).toBeInTheDocument()
    expect(await screen.findByText('17.99')).toBeInTheDocument()
    rerender(
      <SnapshotDiff title="刊登快照" availableDates={['2026-10-01']} dates={['2026-10-01', '2026-10-01']} onDatesChange={() => undefined} labels={labels} snapshots={[{ price: 1 }, { price: 1 }]} />,
    )
    expect(screen.getByText('两个日期之间没有差异')).toBeInTheDocument()
  })
})

describe('运营日志', () => {
  it('列出三类来源；提供手工记录时可添加，失败保留输入', async () => {
    const onAddNote = vi.fn<(text: string) => Promise<void>>().mockRejectedValueOnce(new Error('保存失败')).mockResolvedValueOnce(undefined)
    renderWithApp(
      <OperationLog
        entries={[
          { id: '1', at: '2026-10-20T10:00:00Z', source: 'system', title: '修改价格' },
          { id: '2', at: '2026-10-19T10:00:00Z', source: 'amazon', title: '详情页被修改' },
          { id: '3', at: '2026-10-18T10:00:00Z', source: 'manual', title: '更换主图', actor: '林然' },
        ]}
        onAddNote={onAddNote}
      />,
    )
    const log = screen.getByTestId('operation-log')
    expect(within(log).getByText('系统内操作')).toBeInTheDocument()
    expect(within(log).getByText('亚马逊侧变更')).toBeInTheDocument()
    expect(within(log).getByText('手工记录')).toBeInTheDocument()
    const input = screen.getByLabelText('工作记录')
    await userEvent.type(input, '调整了五点描述')
    await userEvent.click(screen.getByRole('button', { name: /记\s*录/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
    expect(input).toHaveValue('调整了五点描述')
    await userEvent.click(screen.getByRole('button', { name: /记\s*录/ }))
    await waitFor(() => expect(input).toHaveValue(''))
  })
  it('没有传保存能力时不显示输入框；无记录时说明', () => {
    renderWithApp(<OperationLog entries={[]} />)
    expect(screen.queryByLabelText('工作记录')).toBeNull()
    expect(screen.getByText('暂无运营记录')).toBeInTheDocument()
  })
})

describe('图表辅助与图表容器', () => {
  const option: EChartsOption = { xAxis: { type: 'category', data: ['2026-10-01', '2026-10-02', '2026-10-03'] }, yAxis: {}, series: [{ type: 'line', data: [1, 2, 3] }] }

  it('事件标注：只叠加落在横轴上的事件，其余忽略', () => {
    const { option: marked, shown } = withEventMarks(option, [
      { date: '2026-10-02', label: '改价', kind: 'price' },
      { date: '2025-01-01', label: '范围外', kind: 'price' },
    ])
    expect(shown).toBe(1)
    const first = (marked.series as Array<{ markLine: { data: Array<{ xAxis: string; name: string }> } }>)[0]!
    expect(first.markLine.data).toEqual([{ xAxis: '2026-10-02', name: '改价' }])
    expect(withEventMarks(option, []).shown).toBe(0)
  })

  it('降采样：不超过上限原样返回；超过则保留首尾与极值', () => {
    const small = Array.from({ length: 10 }, (_, i) => ({ value: i }))
    expect(downsample(small, 50)).toEqual({ points: small, sampled: false })
    const big = Array.from({ length: 5000 }, (_, i) => ({ value: i === 2500 ? 9999 : Math.sin(i / 50) }))
    const result = downsample(big, 200)
    expect(result.sampled).toBe(true)
    expect(result.points.length).toBeLessThanOrEqual(200)
    expect(result.points[0]).toBe(big[0])
    expect(result.points[result.points.length - 1]).toBe(big[4999])
    expect(result.points.some(p => p.value === 9999)).toBe(true)
  })

  it('容器：标题、下载、全屏、折叠；降采样提示', async () => {
    renderWithApp(<ChartPanel title="销售趋势" ariaLabel="销售趋势图" option={option} sampling={{ shown: 200, total: 5000 }} />)
    expect(screen.getByText('销售趋势')).toBeInTheDocument()
    expect(screen.getByText(/已抽样显示 200 \/ 5000 个点/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '销售趋势图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下\s*载/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /全\s*屏/ }))
    expect(await screen.findByRole('img', { name: '销售趋势图（全屏）' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /折\s*叠/ }))
    expect(screen.queryByRole('img', { name: '销售趋势图' })).toBeNull()
  })

  it('容器：维度切换回调；事件标注开关只在提供事件时出现', async () => {
    const onDimensionChange = vi.fn()
    const { rerender } = renderWithApp(
      <ChartPanel
        title="趋势"
        ariaLabel="图"
        option={option}
        dimensions={[
          { value: 'day', label: '按日' },
          { value: 'week', label: '按周' },
        ]}
        dimension="day"
        onDimensionChange={onDimensionChange}
      />,
    )
    expect(screen.queryByLabelText('事件标注')).toBeNull()
    await userEvent.click(screen.getByText('按周'))
    expect(onDimensionChange).toHaveBeenCalledWith('week')
    rerender(<ChartPanel title="趋势" ariaLabel="图" option={option} events={[]} />)
    expect(screen.getByLabelText('事件标注')).toBeDisabled()
  })

  it('容器：加载、出错、无数据三种状态不画图', () => {
    const { rerender } = renderWithApp(<ChartPanel title="趋势" ariaLabel="图" option={option} loading />)
    expect(screen.getByLabelText('正在加载')).toBeInTheDocument()
    rerender(<ChartPanel title="趋势" ariaLabel="图" option={option} error={new ApiError(500, 'X', '出错', undefined, { requestId: 'req-5' })} />)
    expect(screen.getByText(/请求编号：req-5/)).toBeInTheDocument()
    rerender(<ChartPanel title="趋势" ariaLabel="图" option={option} emptyState={{ kind: 'empty', domain: '销售趋势', prerequisite: '先同步订单' }} />)
    expect(screen.getByText('销售趋势')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '图' })).toBeNull()
  })
})
