import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RULE_MAX_CONDITIONS_PER_GROUP, RULE_MAX_GROUPS, type ConditionGroups, type RuleMetric, type RuleTemplate } from '@nova/api-contracts'
import { renderWithApp } from '../../test/render'
import { ConditionBuilder } from './ConditionBuilder'
import { TemplatePicker } from './TemplatePicker'
import { useRuleMetrics } from './use-rule-metrics'

// 配置组件（P6-07）：条件构造器增删条件与组、实时描述、校验提示；模板选择器分区显示、使用交出副本；指标取自口径字典。

const METRICS: RuleMetric[] = [
  { id: 'M-001', name: '销售额', domain: 'sales', unit: 'money', aggs: ['sum', 'avg', 'min', 'max'] },
  { id: 'M-501', name: 'ACoS', domain: 'ads', unit: 'percent', aggs: ['avg', 'last', 'min', 'max'] },
  { id: 'M-500', name: '广告销售额', domain: 'ads', unit: 'money', aggs: ['sum', 'avg', 'min', 'max'] },
  { id: 'M-206', name: '我方可售天数', domain: 'inventory', unit: 'days', aggs: ['avg', 'last', 'min', 'max'] },
]
const EMPTY: ConditionGroups = { groups: [] }
let latest: ConditionGroups = EMPTY

function Harness({ initial = EMPTY, metrics = METRICS, disabled }: { initial?: ConditionGroups; metrics?: RuleMetric[]; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  latest = value
  return <ConditionBuilder value={value} onChange={setValue} metrics={metrics} disabled={disabled} />
}

const description = () => screen.getByTestId('rule-description')
/** 打开某个下拉并点选项（antd 下拉在 body 里，选项带 title）。 */
async function choose(scope: ReturnType<typeof within>, name: string, option: string) {
  await userEvent.click(scope.getByRole('combobox', { name }))
  const item = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(`.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${option}"]`)
    if (!found) throw new Error(`没有找到选项 ${option}`)
    return found
  })
  await userEvent.click(item)
}
const row = (group: number, condition: number) => within(within(screen.getByRole('group', { name: `条件组 ${group}` })).getAllByRole('group', { name: /^条件 \d+$/ })[condition - 1]!)
const first = (name: string) => screen.getByRole('button', { name })

afterEach(() => {
  vi.unstubAllGlobals()
  latest = EMPTY
})

describe('ConditionBuilder', () => {
  it('没有条件：提示去添加，描述写“尚未设置条件”，没有任何校验报错；点添加得到第一条合法条件', async () => {
    renderWithApp(<Harness />)
    expect(screen.getByText(/还没有条件/)).toBeInTheDocument()
    expect(description()).toHaveTextContent('尚未设置条件')
    expect(screen.queryByRole('alert')).toBeNull()
    await userEvent.click(first('添加条件'))
    expect(latest.groups).toHaveLength(1)
    expect(latest.groups[0]!.conditions[0]).toMatchObject({ metric: 'M-001', window: { kind: 'days', days: 7 }, agg: 'avg', op: '>', threshold: 0 })
    expect(description()).toHaveTextContent('当近 7 天 销售额 平均值 > 0时触发。')
  })

  it('改指标、聚合、阈值、比较符：描述立即跟着变；聚合下拉里没有该指标不支持的方式', async () => {
    renderWithApp(<Harness />)
    await userEvent.click(first('添加条件'))
    const line = row(1, 1)
    await choose(line, '指标域', '广告')
    expect(latest.groups[0]!.conditions[0]!.metric).toBe('M-501')
    await choose(line, '指标', '广告销售额')
    expect(latest.groups[0]!.conditions[0]).toMatchObject({ metric: 'M-500', agg: 'avg' })
    await choose(line, '指标', 'ACoS')
    expect(latest.groups[0]!.conditions[0]!.metric).toBe('M-501')
    await userEvent.click(line.getByRole('combobox', { name: '聚合方式' }))
    expect(document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="合计"]')).toBeNull()
    await userEvent.keyboard('{Escape}')
    await choose(line, '比较符', '≥')
    await userEvent.clear(line.getByRole('spinbutton', { name: '阈值' }))
    await userEvent.type(line.getByRole('spinbutton', { name: '阈值' }), '35')
    expect(description()).toHaveTextContent('当近 7 天 ACoS 平均值 ≥ 35%时触发。')
    expect(line.getByText('%')).toBeInTheDocument()
  })

  it('统计窗口：选“近 N 天”才有天数框，改天数后描述变化；换成今日天数框消失', async () => {
    renderWithApp(<Harness />)
    await userEvent.click(first('添加条件'))
    const line = row(1, 1)
    fireEvent.change(line.getByRole('spinbutton', { name: '统计窗口天数' }), { target: { value: '14' } })
    expect(description()).toHaveTextContent('近 14 天')
    await choose(line, '统计窗口', '今日')
    expect(line.queryByRole('spinbutton', { name: '统计窗口天数' })).toBeNull()
    expect(latest.groups[0]!.conditions[0]!.window).toEqual({ kind: 'today' })
    expect(description()).toHaveTextContent('当今日 销售额')
  })

  it('对比：选环比后出现对比行；描述变成“环比下降超过”；改回不对比整行消失', async () => {
    renderWithApp(<Harness />)
    await userEvent.click(first('添加条件'))
    const line = row(1, 1)
    await choose(line, '对比方式', '环比（上一期）')
    expect(line.getByRole('combobox', { name: '对比计算' })).toBeInTheDocument()
    expect(line.queryByRole('combobox', { name: '对比窗口' })).toBeNull()
    await choose(line, '比较符', '<')
    await userEvent.clear(line.getByRole('spinbutton', { name: '阈值' }))
    await userEvent.type(line.getByRole('spinbutton', { name: '阈值' }), '-20')
    expect(description()).toHaveTextContent('当近 7 天 销售额 平均值 环比下降超过 20%时触发。')
    await choose(line, '对比方式', '与其他窗口比')
    expect(line.getByRole('combobox', { name: '对比窗口' })).toBeInTheDocument()
    expect(description()).toHaveTextContent('较近 7 天平均值下降超过 20%')
    await choose(line, '对比计算', '差值')
    expect(description()).toHaveTextContent('较近 7 天平均值减少超过 20')
    await choose(line, '对比方式', '不对比')
    expect(line.queryByRole('combobox', { name: '对比计算' })).toBeNull()
    expect(latest.groups[0]!.conditions[0]).not.toHaveProperty('compare')
  })

  it('增删条件与组：组内“且”，组间“或”；删光一组里的条件整组消失；删本组', async () => {
    renderWithApp(<Harness />)
    await userEvent.click(first('添加条件'))
    await userEvent.click(within(screen.getByRole('group', { name: '条件组 1' })).getByRole('button', { name: '添加条件' }))
    expect(latest.groups[0]!.conditions).toHaveLength(2)
    expect(within(screen.getByRole('group', { name: '条件组 1' })).getByText('且')).toBeInTheDocument()
    await userEvent.click(first('添加条件组（或）'))
    expect(latest.groups).toHaveLength(2)
    expect(screen.getAllByText('或').length).toBeGreaterThan(0)
    expect(description()).toHaveTextContent('）或（')
    await userEvent.click(row(2, 1).getByRole('button', { name: '删除这条条件' }))
    expect(latest.groups).toHaveLength(1)
    await userEvent.click(row(1, 2).getByRole('button', { name: '删除这条条件' }))
    expect(latest.groups[0]!.conditions).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /删除本组/ }))
    expect(latest.groups).toHaveLength(0)
    expect(description()).toHaveTextContent('尚未设置条件')
  })

  it('阈值清空：这一条显示“阈值要填数字”，描述区提示还有问题；条件组数与每组条数到上限后不能再加', async () => {
    renderWithApp(<Harness />)
    await userEvent.click(first('添加条件'))
    await userEvent.clear(row(1, 1).getByRole('spinbutton', { name: '阈值' }))
    expect(within(row(1, 1).getByRole('alert')).getByText('阈值要填数字')).toBeInTheDocument()
    expect(screen.getByText(/还有 1 处条件需要修改/)).toBeInTheDocument()
  })

  it('上限：每组最多条数、最多组数；到了上限添加按钮置灰', () => {
    const condition = { metric: 'M-001', window: { kind: 'today' as const }, agg: 'sum' as const, op: '>' as const, threshold: 1 }
    renderWithApp(
      <Harness
        initial={{
          groups: [{ conditions: Array.from({ length: RULE_MAX_CONDITIONS_PER_GROUP }, () => condition) }, ...Array.from({ length: RULE_MAX_GROUPS - 1 }, () => ({ conditions: [condition] }))],
        }}
      />,
    )
    expect(within(screen.getByRole('group', { name: '条件组 1' })).getByRole('button', { name: '添加条件' })).toBeDisabled()
    expect(first('添加条件组（或）')).toBeDisabled()
  })

  it('已有条件里的指标不在可用清单里：报“不存在或不能用于规则”，不静默改掉', () => {
    renderWithApp(<Harness initial={{ groups: [{ conditions: [{ metric: 'M-999', window: { kind: 'today' }, agg: 'sum', op: '>', threshold: 1 }] }] }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('指标 M-999 不存在或不能用于规则')
    expect(description()).toHaveTextContent('M-999')
  })

  it('没有可用指标：说明原因，添加按钮不可点；只读时全部控件禁用', () => {
    const { unmount } = renderWithApp(<Harness metrics={[]} />)
    expect(screen.getByText(/还没有可用于规则的指标/)).toBeInTheDocument()
    expect(first('添加条件')).toBeDisabled()
    unmount()
    renderWithApp(<Harness disabled initial={{ groups: [{ conditions: [{ metric: 'M-501', window: { kind: 'days', days: 7 }, agg: 'avg', op: '>', threshold: 35 }] }] }} />)
    expect(screen.getByRole('spinbutton', { name: '阈值' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除这条条件' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加条件组（或）' })).toBeDisabled()
  })

  it('可以关掉右侧描述（页面自己在别处显示）', () => {
    renderWithApp(<ConditionBuilder value={EMPTY} onChange={() => undefined} metrics={METRICS} showDescription={false} />)
    expect(screen.queryByTestId('rule-description')).toBeNull()
  })
})

const TEMPLATES: RuleTemplate[] = [
  {
    id: 't1',
    name: '广告成本偏高',
    group: '广告效率',
    source: 'SYSTEM',
    dimension: '广告活动',
    conditions: { groups: [{ conditions: [{ metric: 'M-501', window: { kind: 'days', days: 7 }, agg: 'avg', op: '>', threshold: 35 }] }] },
  },
  {
    id: 't2',
    name: '库存即将断货',
    group: '库存风险',
    source: 'SYSTEM',
    dimension: '商品',
    conditions: { groups: [{ conditions: [{ metric: 'M-206', window: { kind: 'today' }, agg: 'last', op: '<', threshold: 14 }] }] },
  },
  {
    id: 't3',
    name: '我的旧模板',
    group: '自定义',
    source: 'CUSTOM',
    dimension: '店铺',
    conditions: { groups: [{ conditions: [{ metric: 'M-999', window: { kind: 'today' }, agg: 'sum', op: '>', threshold: 1 }] }] },
  },
]

describe('TemplatePicker', () => {
  it('系统模板与自定义模板分开显示、各按分组；卡片写名称、适用维度与一句话条件', () => {
    renderWithApp(<TemplatePicker templates={TEMPLATES} metrics={METRICS} onUse={() => undefined} />)
    const system = within(screen.getByRole('region', { name: '系统模板' }))
    expect(system.getByText('广告效率')).toBeInTheDocument()
    expect(system.getByText('库存风险')).toBeInTheDocument()
    const card = within(system.getByRole('article', { name: '广告成本偏高' }))
    expect(card.getByText('广告活动')).toBeInTheDocument()
    expect(card.getByText('近 7 天 ACoS 平均值 > 35%')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '自定义模板' })).getByRole('article', { name: '我的旧模板' })).toBeInTheDocument()
    expect(system.queryByText('我的旧模板')).toBeNull()
  })

  it('点“使用”交出模板的副本：改副本不会动到模板', async () => {
    const onUse = vi.fn()
    renderWithApp(<TemplatePicker templates={TEMPLATES} metrics={METRICS} onUse={onUse} />)
    await userEvent.click(screen.getByRole('button', { name: '使用模板：广告成本偏高' }))
    expect(onUse).toHaveBeenCalledTimes(1)
    const used = onUse.mock.calls[0]![0] as RuleTemplate
    expect(used.id).toBe('t1')
    used.conditions.groups[0]!.conditions[0]!.threshold = 99
    expect(TEMPLATES[0]!.conditions.groups[0]!.conditions[0]!.threshold).toBe(35)
  })

  it('模板里的指标当前不能用：按钮置灰并写明原因，不静默丢条件；只读时全部置灰', () => {
    const { unmount } = renderWithApp(<TemplatePicker templates={TEMPLATES} metrics={METRICS} onUse={() => undefined} />)
    const card = within(screen.getByRole('article', { name: '我的旧模板' }))
    expect(card.getByRole('button', { name: '使用模板：我的旧模板' })).toBeDisabled()
    expect(card.getByText(/暂时不能使用：指标 M-999 不存在或不能用于规则/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '使用模板：库存即将断货' })).toBeEnabled()
    unmount()
    renderWithApp(<TemplatePicker templates={TEMPLATES} metrics={METRICS} onUse={() => undefined} disabled />)
    expect(screen.getByRole('button', { name: '使用模板：库存即将断货' })).toBeDisabled()
  })

  it('没有模板：两个分区各写“尚无……”', () => {
    renderWithApp(<TemplatePicker templates={[]} metrics={METRICS} onUse={() => undefined} />)
    expect(screen.getByText('尚无系统模板')).toBeInTheDocument()
    expect(screen.getByText('尚无自定义模板')).toBeInTheDocument()
  })
})

describe('useRuleMetrics：指标取自口径字典', () => {
  function Probe() {
    const { metrics, isLoading, isError } = useRuleMetrics()
    return <div data-testid="probe">{isError ? '失败' : isLoading ? '加载中' : metrics.map(metric => `${metric.id}:${metric.domain}:${metric.aggs.join('/')}`).join(',') || '空'}</div>
  }
  const definition = (id: string, ruleUse: unknown) => ({
    id,
    name: id,
    type: '官方',
    group: 'g',
    definition: '',
    source: '',
    refresh: '',
    version: 1,
    pages: [],
    reconcileWith: [],
    mismatchReasons: [],
    configurableAt: null,
    ruleUse,
    history: [],
  })

  it('请求只要“可用于规则”的指标；没有标记的条目丢掉', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        urls.push(String(input))
        const data = { items: [definition('M-501', { domain: 'ads', unit: 'percent', aggs: ['avg', 'last'] }), definition('M-777', null)], total: 2 }
        return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
    renderWithApp(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('M-501:ads:avg/last'))
    expect(screen.getByTestId('probe')).not.toHaveTextContent('M-777')
    expect(urls[0]).toContain('/metrics/definitions?')
    expect(urls[0]).toContain('ruleUsable=true')
    expect(urls[0]).toContain('pageSize=100')
  })

  it('读取失败：不当成“没有指标”，页面能区分', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL', message: '出错了' } }), { status: 500, headers: { 'content-type': 'application/json' } })),
    )
    renderWithApp(<Probe />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('失败'))
  })
})
