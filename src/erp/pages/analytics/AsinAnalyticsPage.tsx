import { useMemo, useState } from 'react'
import { Alert, Card, Col, Input, Row, Select, Space, Tag } from 'antd'
import {
  ASIN_ISSUE_OPTIONS,
  ASIN_METRIC_INFO,
  ASIN_METRIC_KEYS,
  INVENTORY_RISK_LABEL,
  INVENTORY_RISK_LEVELS,
  type AsinAnalyticsResponse,
  type AsinMetricKey,
  type AsinSelection,
} from '@nova/api-contracts'
import { ChartPanel, LocalGrid, PageHeader, renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { AppLink } from '../../nav/AppLink'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { AsinTree } from './AsinTree'
import { ASIN_METRIC_CHOICES, buildSelectionOption } from './asin-analytics-options'
import { AsinFigure } from './asin-analytics-ui'
import { Frame, Pager } from './business-reports-ui'

// ASIN 与父体分析（P4-03，04 章 4.6）：左侧父体树（销售额从高到低，可按关键词、品牌、类目、标签、负责人、库存风险、刊登问题筛选），
// 右侧所选对象的逐日趋势与整段合计；勾选多个（最多 5 个）就是对比模式，对比同一个指标。点父体名称进入父体详情（七个页签）。
// 官方没给的值写“尚无记录”，不当 0；父体的数字 = 名下子体相加；日期范围与对比期用页面顶部的全局范围。

const PAGE_SIZE = 20
type Filters = { q?: string; brand?: string; category?: string; tag?: string; owner?: string; risk?: string; issue?: string }

const options = (values: readonly string[]) => values.map(value => ({ value, label: value }))

function Pick({
  label,
  value,
  items,
  onChange,
  width = 130,
}: {
  label: string
  value?: string
  items: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
  width?: number
}) {
  return <Select allowClear showSearch optionFilterProp="label" style={{ width }} placeholder={label} aria-label={label} value={value} options={items} onChange={next => onChange(next)} />
}

type MetricRow = { key: AsinMetricKey }

function SelectionTable({ selections }: { selections: readonly AsinSelection[] }) {
  const columns = useMemo<ErpColDef<MetricRow>[]>(
    () => [
      renderColumn<MetricRow>('指标', 'metric', row => <span title={ASIN_METRIC_INFO[row.key].basis}>{ASIN_METRIC_INFO[row.key].label}</span>, { width: 150, pin: 'left' }),
      ...selections.map(selection =>
        renderColumn<MetricRow>(selection.kind === 'parent' ? `父体 ${selection.asin}` : selection.asin, selection.key, row => <AsinFigure metric={row.key} value={selection.totals[row.key]} />, {
          width: 150,
          ...RIGHT_ALIGNED,
        }),
      ),
    ],
    [selections],
  )
  const rows = useMemo<MetricRow[]>(() => ASIN_METRIC_KEYS.map(key => ({ key })), [])
  const notes = selections.flatMap(selection =>
    (Object.entries(selection.gaps) as Array<[AsinMetricKey, string]>).map(([key, text]) => ({ id: `${selection.key}:${key}`, who: selection.asin, label: ASIN_METRIC_INFO[key].label, text })),
  )
  return (
    <div data-testid="asin-selection-table">
      <LocalGrid<MetricRow>
        gridId="analytics.asin-analytics.selection"
        columns={columns}
        rows={rows}
        getRowId={row => row.key}
        initialPageSize={50}
        height={460}
        emptyState={{ kind: 'empty', domain: '范围合计', prerequisite: '还没有选中对象。' }}
      />
      {notes.length > 0 ? (
        <ul style={{ margin: '8px 0 0', paddingInlineStart: 18, fontSize: 12, color: 'rgba(0,0,0,0.65)' }} data-testid="asin-gaps">
          {notes.map(note => (
            <li key={note.id}>
              {note.who} · {note.label}：{note.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Body({
  data,
  selected,
  onToggle,
  stack,
  setStack,
  fetching,
}: {
  data: AsinAnalyticsResponse
  selected: readonly string[]
  onToggle: (key: string, checked: boolean) => void
  stack: Array<string | undefined>
  setStack: (next: (current: Array<string | undefined>) => Array<string | undefined>) => void
  fetching: boolean
}) {
  const [primary, setPrimary] = useState<AsinMetricKey>('sales')
  const [secondary, setSecondary] = useState<AsinMetricKey | null>('sessions')
  const option = useMemo(() => buildSelectionOption(data.selection, primary, secondary), [data.selection, primary, secondary])
  const empty = data.selection.length === 0 || data.selection.every(selection => selection.points.every(point => point[primary] === null))
  const compare = data.selection.length > 1
  return (
    <Row gutter={12} data-testid="asin-analytics">
      <Col xs={24} lg={9} xl={8}>
        <Card size="small" title="父体与 ASIN" extra={<Muted>销售额从高到低</Muted>}>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>{data.treeNote}</p>
          <AsinTree nodes={data.tree} selected={selected} onToggle={onToggle} />
          <Pager stack={stack} setStack={setStack} pageInfo={data.pageInfo} fetching={fetching} />
        </Card>
      </Col>
      <Col xs={24} lg={15} xl={16}>
        {data.selectionDefaulted && data.selection.length > 0 ? (
          <Alert type="info" showIcon style={{ marginBottom: 8 }} message="没有选中对象，已默认选中销售额最高的一项" data-testid="asin-defaulted" />
        ) : null}
        {data.selectionNote ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data.selectionNote} /> : null}
        <Space wrap style={{ marginBottom: 8 }} data-testid="asin-chosen">
          {data.selection.map(selection => (
            <Tag key={selection.key} color="blue" bordered={false}>
              {selection.kind === 'parent' ? '父体' : 'ASIN'} {selection.asin}
              {selection.title ? ` · ${selection.title}` : ''}
              {selection.kind === 'parent' ? ` · ${selection.memberCount} 个子体` : ''}
            </Tag>
          ))}
          {compare ? <Muted>对比模式：只对比下方选择的主指标</Muted> : null}
        </Space>
        <ChartPanel
          title={compare ? '对比趋势' : '逐日趋势'}
          ariaLabel="ASIN 与父体逐日趋势图"
          option={option}
          height={280}
          extra={
            <Space size={4}>
              <Select size="small" style={{ width: 130 }} aria-label="趋势主指标" value={primary} options={ASIN_METRIC_CHOICES} onChange={setPrimary} />
              {compare ? null : (
                <Select
                  size="small"
                  style={{ width: 130 }}
                  aria-label="趋势次指标"
                  allowClear
                  placeholder="次指标（可选）"
                  value={secondary ?? undefined}
                  options={ASIN_METRIC_CHOICES}
                  onChange={value => setSecondary(value ?? null)}
                />
              )}
            </Space>
          }
          emptyState={empty ? { kind: 'empty', domain: '逐日趋势', prerequisite: data.selection[0]?.gaps[primary] ?? data.note ?? '所选范围内这些对象没有这个指标的记录。' } : undefined}
        />
        <Card size="small" title="范围合计" style={{ marginTop: 8 }}>
          <SelectionTable selections={data.selection} />
        </Card>
      </Col>
    </Row>
  )
}

export default function AsinAnalyticsPage() {
  const { canPermission } = useSession()
  const [filters, setFilters] = useState<Filters>({})
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[] | null>(null)
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const patch = (next: Filters) => {
    setFilters(current => ({ ...current, ...next }))
    reset()
  }
  const query = useApiQuery<AsinAnalyticsResponse>({
    domain: 'analytics',
    path: '/analytics/asins',
    params: { ...filters, select: picked ?? undefined, pageSize: PAGE_SIZE, cursor: stack[stack.length - 1] },
  })
  const data = query.data
  const selected = picked ?? data?.selection.map(selection => selection.key) ?? []
  const toggle = (key: string, checked: boolean) => setPicked(checked ? [...selected.filter(item => item !== key), key] : selected.filter(item => item !== key))
  return (
    <div>
      <PageHeader
        title="ASIN 与父体分析"
        description="按父体和 ASIN 看销售、流量、转化、广告、退货与库存：父体的数字是名下子体相加；勾选多个对象并排对比。官方没给的值写“尚无记录”，不当 0。"
        actions={canPermission('analytics.read') ? <AppLink to="/app/analytics/product-performance">在商品表现中查看</AppLink> : undefined}
      />
      <Card size="small" style={{ marginBottom: 8 }}>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索 ASIN、父体、SKU 或标题"
            aria-label="搜索"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => patch({ q: value.trim() || undefined })}
          />
          <Pick label="品牌" value={filters.brand} items={options(data?.filters.brands ?? [])} onChange={brand => patch({ brand })} />
          <Pick label="类目" value={filters.category} items={options(data?.filters.categories ?? [])} onChange={category => patch({ category })} width={160} />
          <Pick label="标签" value={filters.tag} items={options(data?.filters.tags ?? [])} onChange={tag => patch({ tag })} />
          <Pick label="负责人" value={filters.owner} items={(data?.filters.owners ?? []).map(owner => ({ value: owner.id, label: owner.name }))} onChange={owner => patch({ owner })} />
          {canPermission('inventory.read') ? (
            <Pick label="库存风险" value={filters.risk} items={INVENTORY_RISK_LEVELS.map(value => ({ value, label: INVENTORY_RISK_LABEL[value] }))} onChange={risk => patch({ risk })} width={170} />
          ) : null}
          <Pick label="刊登问题" value={filters.issue} items={ASIN_ISSUE_OPTIONS.map(item => ({ value: item.value, label: item.label }))} onChange={issue => patch({ issue })} />
        </Space>
        {data ? (
          <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(0,0,0,0.65)' }} data-testid="asin-issue-note">
            {data.issueNote}
          </div>
        ) : null}
      </Card>
      <Frame query={query} testId="asin-analytics-frame">
        {value => <Body data={value} selected={selected} onToggle={toggle} stack={stack} setStack={setStack} fetching={query.isFetching} />}
      </Frame>
    </div>
  )
}
