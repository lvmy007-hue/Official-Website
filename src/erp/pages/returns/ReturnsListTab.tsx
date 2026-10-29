import { useCallback, useMemo, useState } from 'react'
import { Alert } from 'antd'
import { RETURN_DEFAULT_DAYS, RETURN_DISPOSITION_FILTERS, RETURN_DISPOSITION_LABEL, RETURN_REASON_PRESETS, type ReturnListResponse, type ReturnListRow } from '@nova/api-contracts'
import { FilterBar, FreshnessBar, MassiveGrid, useUrlFilters, type CursorFetcher, type FilterField, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { apiFetch } from '../../../api'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { RETURN_DEFAULT_SORT, RETURN_SORTABLE, returnColumns } from './returns-columns'

// 退货记录（P2b-02，07 章 7.2；P6-13 迁到 MassiveGrid 骨架与统一筛选栏）：来自客户退货报告（每日同步），游标分页（无限滚动）。
// 退款金额与先后来自财务交易（订单口径）；没有数据写“尚无记录”，没有财务交易写“待财务交易”。筛选写在地址栏里；日期范围取全局范围栏。

const TRI = [
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
]
const FIELDS: FilterField[] = [
  { key: 'reason', label: '退货原因', kind: 'select', strict: false, options: Object.entries(RETURN_REASON_PRESETS).map(([value, preset]) => ({ value, label: `${preset.labelZh}（${value}）` })) },
  { key: 'disposition', label: '处置状态', kind: 'select', options: RETURN_DISPOSITION_FILTERS.map(value => ({ value, label: RETURN_DISPOSITION_LABEL[value] })) },
  { key: 'refunded', label: '是否已退款', kind: 'select', options: TRI },
  { key: 'asin', label: 'ASIN', kind: 'text', placement: 'more' },
  { key: 'sku', label: 'SKU', kind: 'text', placement: 'more' },
]
const MODES: SearchMode[] = [{ id: 'order', label: '订单号或退货件编号', key: 'q', placeholder: '搜索订单号或退货件编号' }]

type ListMeta = Pick<ReturnListResponse, 'freshness' | 'range' | 'filterLimited' | 'note'>

export function ReturnsListTab() {
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<ListMeta | null>(null)

  const fetchPage = useCallback<CursorFetcher<ReturnListRow>>(
    async ({ cursor, limit, sort, signal }) => {
      const path = buildPath('/returns', { ...apiParams, ...values, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined })
      const response = await apiFetch<ReturnListResponse>(path, { signal })
      // 范围、新鲜度与提示以第一块为准（后续块的游标只管翻页）
      if (cursor === null) setMeta({ freshness: response.freshness, range: response.range, filterLimited: response.filterLimited, note: response.note })
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    [apiParams, values],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const filtered = Object.keys(values).length > 0

  return (
    <div>
      <FreshnessBar freshness={meta?.freshness} />
      {meta?.range.defaulted ? (
        <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`未选择日期范围，当前显示 ${meta.range.from} 至 ${meta.range.to} 的退货（最近 ${RETURN_DEFAULT_DAYS} 天）`} />
      ) : null}
      {meta?.filterLimited ? <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="退款筛选命中的订单太多，结果可能不完整" description="请缩小退货日期范围或选择店铺后再筛选。" /> : null}
      <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
      <MassiveGrid<ReturnListRow>
        gridId="returns.list"
        serverViews
        viewFilters={viewFilters}
        columns={returnColumns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        sortableFields={RETURN_SORTABLE}
        defaultSort={RETURN_DEFAULT_SORT}
        resetKey={JSON.stringify([apiParams, url.signature])}
        appliedFilterCount={appliedCount(FIELDS, MODES, values)}
        onClearFilters={url.reset}
        emptyState={{
          kind: 'empty',
          domain: '退货',
          prerequisite: filtered
            ? '没有符合条件的退货记录；可以放宽筛选条件或扩大退货日期范围。'
            : (meta?.note ?? '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）。'),
        }}
        height={620}
      />
    </div>
  )
}
