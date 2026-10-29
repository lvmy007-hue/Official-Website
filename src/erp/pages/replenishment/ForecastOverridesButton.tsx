import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Drawer, Space, Typography } from 'antd'
import {
  FORECAST_MODE_LABEL,
  FORECAST_SCOPE_LABEL,
  FORECAST_SCOPE_TYPES,
  FORECAST_STATUSES,
  FORECAST_STATUS_LABEL,
  type ForecastOverrideListResponse,
  type ForecastOverrideRow,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { actionColumn, dateColumn, FilterBar, PagedGrid, renderColumn, statusColumn, type ErpColDef, type FilterField, type PageFetcher, type SearchMode } from '../../components'
import { appliedCount, type FilterPatch, type FilterValues } from '../../components/filter/filter-model'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { EMPTY_VALUE } from '../../format'
import { buildPath } from '../../query/api-query'
import { CreateForecastAction, ForecastRowActions } from './forecast-actions'

// 人工预测规则（P6-09，16 章第 4 节）：按时间段取代模型预测的人工日销，优先级高于模型；每次重算的计算链第 1 步会写明用了哪条规则。
// 入口在补货建议页顶部；规则只影响之后重新计算的批次。表格用 PagedGrid（服务端分页、排序），筛选不写地址栏（抽屉里的局部筛选，页面本身的筛选已经占用了地址栏）。

const FIELDS: FilterField[] = [
  { key: 'scopeType', label: '对象类型', kind: 'select', width: 140, options: FORECAST_SCOPE_TYPES.map(value => ({ value, label: FORECAST_SCOPE_LABEL[value] })) },
  { key: 'status', label: '状态', kind: 'select', width: 140, options: FORECAST_STATUSES.map(value => ({ value, label: FORECAST_STATUS_LABEL[value] })) },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '规则', key: 'q', placeholder: '搜索 SKU 或商品类型' }]
const SORTABLE = { from: 'from', to: 'to', scopeId: 'scopeId' } as const
const DEFAULT_SORT: SortSpec = { field: 'from', direction: 'desc' }
const STATUS = {
  UPCOMING: { label: FORECAST_STATUS_LABEL.UPCOMING, tone: 'default' },
  ACTIVE: { label: FORECAST_STATUS_LABEL.ACTIVE, tone: 'success' },
  EXPIRED: { label: FORECAST_STATUS_LABEL.EXPIRED, tone: 'default' },
} as const

function columns(refresh: () => void): ErpColDef<ForecastOverrideRow>[] {
  return [
    renderColumn<ForecastOverrideRow>('对象', 'scopeId', row => <strong>{row.scopeId}</strong>, { pin: 'left', width: 190, valueGetter: ({ data }) => data?.scopeId ?? '' }),
    { headerName: '类型', colId: 'scopeType', width: 90, sortable: false, valueGetter: ({ data }) => (data ? FORECAST_SCOPE_LABEL[data.scopeType] : '') },
    dateColumn<ForecastOverrideRow>('开始日期', 'from', { width: 120 }),
    dateColumn<ForecastOverrideRow>('结束日期', 'to', { width: 120 }),
    { headerName: '方式', colId: 'mode', width: 150, sortable: false, valueGetter: ({ data }) => (data ? FORECAST_MODE_LABEL[data.mode] : '') },
    { headerName: '规则内容', colId: 'summary', width: 330, sortable: false, valueGetter: ({ data }) => data?.summary ?? '', tooltipValueGetter: ({ data }) => data?.summary ?? '' },
    statusColumn<ForecastOverrideRow>('状态', 'status', STATUS, { width: 100, sortable: false }),
    { headerName: '备注', colId: 'note', width: 200, sortable: false, valueGetter: ({ data }) => data?.note ?? EMPTY_VALUE },
    { headerName: '创建人', colId: 'createdBy', width: 120, sortable: false, valueGetter: ({ data }) => data?.createdBy ?? '' },
    actionColumn<ForecastOverrideRow>(row => <ForecastRowActions row={row} onDone={refresh} />, { width: 190 }),
  ]
}

export function ForecastOverridesButton() {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [meta, setMeta] = useState<Pick<ForecastOverrideListResponse, 'activeCount' | 'activeLimit' | 'canManage' | 'manageBlockedReason' | 'priorityNote'> | null>(null)
  // 抽屉里的筛选只存在本组件：不写地址栏（页面本身的筛选已经占用了地址栏参数）
  const [values, setValues] = useState<FilterValues>({})
  const url = useMemo(
    () => ({
      set: (patch: FilterPatch) =>
        setValues(current => {
          const next: FilterValues = { ...current }
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') delete next[key]
            else next[key] = value
          }
          return next
        }),
      reset: () => setValues({}),
      signature: JSON.stringify(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))),
    }),
    [values],
  )
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  const cols = useMemo(() => columns(refresh), [refresh])

  const fetchPage = useCallback<PageFetcher<ForecastOverrideRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/replenishment/forecast-overrides', {
        scopeType: values.scopeType,
        status: values.status,
        q: values.q,
        sort: sort ? `${sort.field}:${sort.direction}` : undefined,
        page,
        pageSize,
      })
      const response = await apiFetch<ForecastOverrideListResponse>(path, { signal })
      setMeta({
        activeCount: response.activeCount,
        activeLimit: response.activeLimit,
        canManage: response.canManage,
        manageBlockedReason: response.manageBlockedReason,
        priorityNote: response.priorityNote,
      })
      return { items: response.items, total: response.total }
    },
    [values.scopeType, values.status, values.q],
  )

  return (
    <>
      <Button onClick={() => setOpen(true)}>人工预测规则</Button>
      <Drawer open={open} onClose={() => setOpen(false)} width={1040} destroyOnClose title="人工预测规则">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            在指定的时间段里，用人工给的日销取代模型预测（含订阅省与趋势调整）。{meta?.priorityNote ?? '同一天里 SKU 规则优先于品类规则，两者都优先于模型预测。'}
          </Typography.Paragraph>
          {meta?.manageBlockedReason ? <Alert type="info" showIcon message="你可以查看规则，但不能修改" description={meta.manageBlockedReason} /> : null}
          <Space wrap>
            <CreateForecastAction onDone={refresh} />
            {meta ? (
              <Typography.Text type="secondary">
                未结束的规则 {meta.activeCount} / {meta.activeLimit} 条
              </Typography.Text>
            ) : null}
          </Space>
          <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
          <PagedGrid<ForecastOverrideRow>
            gridId="replenishment.forecast-overrides"
            columns={cols}
            fetchPage={fetchPage}
            getRowId={row => row.id}
            sortableFields={SORTABLE}
            defaultSort={DEFAULT_SORT}
            resetKey={JSON.stringify([url.signature, version])}
            appliedFilterCount={appliedCount(FIELDS, MODES, values)}
            onClearFilters={url.reset}
            emptyState={{ kind: 'empty', domain: '人工预测规则', prerequisite: '还没有规则。点“新增规则”，给某个 SKU 或品类在一段时间内指定日销（例如大促期间固定日销）。' }}
            height={440}
          />
        </Space>
      </Drawer>
    </>
  )
}
