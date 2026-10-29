import { Fragment, useCallback, useMemo, useState } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { Input, Select, Space, Tag, Typography } from 'antd'
import type { MetricDefinition, MetricLink } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { PageHeader, PagedGrid, type ErpColDef, type PageFetcher, type ViewFilterBinding } from '../../components'
import { EMPTY_VALUE } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath } from '../../query/api-query'

// 指标口径（P1-28-8，09 章 9.5；P6-03 起用 PagedGrid 骨架 + 服务端视图，并补齐对账页面、可能对不上的原因、在哪里配置三列）：
// 全站每个指标的唯一口径——公式、数据来源、刷新频率、版本和用到它的页面。列头问号与本页是同一份指标字典。
// - 数据来自冻结的指标字典，登录成员都可以查看；同名指标只有一个口径，口径变化会升版并保留历史；
// - 目前所有指标都是初始口径（第 1 版），还没有口径变更记录，页面如实显示“暂无变更记录”。

type Row = MetricDefinition & { history: Array<{ version: number; changedAt: string; summary: string }> }
type Result = { items: Row[]; total: number; page: number; pageSize: number; groups: string[]; types: string[] }
type Cell = ICellRendererParams<Row>

const TYPE_COLOR: Record<string, string> = { 官方: 'green', 我方计算: 'blue', 模型估算: 'orange', 导入: 'purple', 无官方来源: 'default', 自定义: 'gold' }
const wrap = { wrapText: true, autoHeight: true } as const

const links = (items: readonly MetricLink[]) =>
  items.length === 0
    ? EMPTY_VALUE
    : items.map((item, index) => (
        <Fragment key={item.route}>
          {index > 0 ? '、' : null}
          <AppLink to={item.route}>{item.label}</AppLink>
        </Fragment>
      ))

const COLUMNS: ErpColDef<Row>[] = [
  {
    headerName: '指标',
    colId: 'name',
    pin: 'left',
    width: 200,
    valueGetter: ({ data }) => (data ? `${data.name} ${data.id}` : ''),
    cellRenderer: ({ data }: Cell) =>
      data ? (
        <Space direction="vertical" size={0}>
          <strong>{data.name}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data.id}
          </Typography.Text>
        </Space>
      ) : null,
  },
  { headerName: '类型', colId: 'type', width: 110, cellRenderer: ({ data }: Cell) => (data ? <Tag color={TYPE_COLOR[data.type]}>{data.type}</Tag> : null) },
  { headerName: '板块', colId: 'group', width: 130, valueGetter: ({ data }) => data?.group },
  { headerName: '口径（公式）', colId: 'definition', width: 320, ...wrap, valueGetter: ({ data }) => data?.definition },
  { headerName: '数据来源', colId: 'source', width: 200, ...wrap, valueGetter: ({ data }) => data?.source },
  { headerName: '刷新', colId: 'refresh', width: 130, valueGetter: ({ data }) => data?.refresh },
  {
    headerName: '版本',
    colId: 'version',
    width: 190,
    valueGetter: ({ data }) => (!data ? '' : data.version === null ? '不设指标' : `第 ${data.version} 版${data.history.length === 0 ? '（暂无变更记录）' : `，${data.history.length} 次变更`}`),
  },
  {
    headerName: '对账页面',
    colId: 'reconcileWith',
    width: 200,
    ...wrap,
    valueGetter: ({ data }) => data?.reconcileWith.map(item => item.label).join('、') ?? '',
    cellRenderer: ({ data }: Cell) => (data ? links(data.reconcileWith) : null),
  },
  {
    headerName: '可能对不上的原因',
    colId: 'mismatchReasons',
    width: 320,
    ...wrap,
    valueGetter: ({ data }) => data?.mismatchReasons.join('；') ?? '',
    cellRenderer: ({ data }: Cell) => (data ? (data.mismatchReasons.length === 0 ? EMPTY_VALUE : data.mismatchReasons.join('；')) : null),
  },
  {
    headerName: '在哪里配置',
    colId: 'configurableAt',
    width: 150,
    valueGetter: ({ data }) => data?.configurableAt?.label ?? '',
    cellRenderer: ({ data }: Cell) => (data ? links(data.configurableAt ? [data.configurableAt] : []) : null),
  },
  {
    headerName: '使用页面',
    colId: 'pages',
    width: 220,
    ...wrap,
    valueGetter: ({ data }) => data?.pages.join('、') ?? '',
    cellRenderer: ({ data }: Cell) => (data ? (data.pages.length === 0 ? EMPTY_VALUE : data.pages.join('、')) : null),
  },
]

export default function MetricDefinitionsPage() {
  const [q, setQ] = useState('')
  const [text, setText] = useState('')
  const [type, setType] = useState<string>()
  const [group, setGroup] = useState<string>()
  const [options, setOptions] = useState<{ groups: string[]; types: string[]; total: number | null }>({ groups: [], types: [], total: null })

  const fetchPage = useCallback<PageFetcher<Row>>(
    async ({ page, pageSize, signal }) => {
      const result = await apiFetch<Result>(buildPath('/metrics/definitions', { q: q || undefined, type, group, page, pageSize }), { signal })
      setOptions({ groups: result.groups, types: result.types, total: result.total })
      return { items: result.items, total: result.total }
    },
    [q, type, group],
  )

  const clearFilters = () => {
    setQ('')
    setText('')
    setType(undefined)
    setGroup(undefined)
  }
  // 视图里的筛选：关键字、类型、板块；认不出的键算“已失效”
  const viewFilters = useMemo<ViewFilterBinding>(
    () => ({
      value: { ...(q ? { q } : {}), ...(type ? { type } : {}), ...(group ? { group } : {}) },
      dimension: null,
      apply: (filters, dimension) => {
        const pick = (key: string) => (typeof filters[key] === 'string' && filters[key] !== '' ? (filters[key] as string) : undefined)
        setQ(pick('q') ?? '')
        setText(pick('q') ?? '')
        setType(pick('type'))
        setGroup(pick('group'))
        return Object.keys(filters).filter(key => !['q', 'type', 'group'].includes(key)).length + (dimension === null ? 0 : 1)
      },
    }),
    [q, type, group],
  )

  return (
    <div>
      <PageHeader title="指标口径" description="每个指标只有一个口径。页面上看到的数字，都可以在这里查到公式、来源和刷新频率；表格列头的问号读的是同一份口径。" />
      <Space wrap style={{ margin: '8px 0 12px' }}>
        <Input.Search
          allowClear
          placeholder="搜索指标名称、编号、公式、来源或页面"
          style={{ width: 320 }}
          value={text}
          onChange={event => setText(event.target.value)}
          onSearch={value => setQ(value.trim())}
        />
        <Select allowClear placeholder="类型" style={{ width: 130 }} value={type} options={options.types.map(value => ({ value, label: value }))} onChange={value => setType(value)} />
        <Select allowClear placeholder="板块" style={{ width: 180 }} value={group} options={options.groups.map(value => ({ value, label: value }))} onChange={value => setGroup(value)} />
        {options.total !== null ? <Typography.Text type="secondary">共 {options.total} 个指标</Typography.Text> : null}
      </Space>
      <PagedGrid<Row>
        gridId="help.metrics"
        serverViews
        viewFilters={viewFilters}
        columns={COLUMNS}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={JSON.stringify([q, type, group])}
        appliedFilterCount={(q ? 1 : 0) + (type ? 1 : 0) + (group ? 1 : 0)}
        onClearFilters={clearFilters}
        emptyState={{ kind: 'empty', domain: '没有符合条件的指标', prerequisite: '换个关键字，或清除类型、板块筛选。' }}
        initialPageSize={50}
        height={600}
      />
    </div>
  )
}
