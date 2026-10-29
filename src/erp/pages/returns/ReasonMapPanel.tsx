import { useCallback, useMemo, useState } from 'react'
import { Alert, Space, Typography } from 'antd'
import { RETURN_REASON_CATEGORIES, RETURN_REASON_MAP_LIMIT, type ReturnReasonMapListResponse, type ReturnReasonMapRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath } from '../../query/api-query'
import { CreateReasonAction, ReasonRowActions } from './reason-map-actions'
import { REASON_MAP_DEFAULT_SORT, REASON_MAP_SORTABLE, reasonMapColumns } from './reason-map-columns'

// 原因映射（P6-13，16 章第 6 节）：亚马逊原因代码 → 中文释义 → 大类。预置了 22 个常见代码；企业可以改释义与大类、添加自己的项；
// 导入退货报告时发现的新代码会自动加进来（大类“未分类”），在这里补全后，退货列表与退货分析的显示和汇总立即按新设置走。

// 筛选键用 rq、rcategory：和“退货记录”页签的 q 区分开（两个页签同时挂在页面上，不能共用地址栏里的键）。
const FIELDS: FilterField[] = [{ key: 'rcategory', label: '大类', kind: 'select', options: RETURN_REASON_CATEGORIES.map(value => ({ value, label: value })) }]
const MODES: SearchMode[] = [{ id: 'keyword', label: '原因', key: 'rq', placeholder: '搜索原因代码或中文释义' }]

type Meta = Pick<ReturnReasonMapListResponse, 'summary' | 'canManage' | 'manageBlockedReason'>

export function ReasonMapPanel() {
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<Meta | null>(null)
  // 写操作成功后刷新：表格不走缓存，换一个重置键让它重新取
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  const columns = useMemo(() => reasonMapColumns(row => <ReasonRowActions row={row} onDone={refresh} />), [refresh])

  const fetchPage = useCallback<PageFetcher<ReturnReasonMapRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/returns/reason-map', { q: values.rq, category: values.rcategory, sort: sort ? `${sort.field}:${sort.direction}` : undefined, page, pageSize })
      const response = await apiFetch<ReturnReasonMapListResponse>(path, { signal })
      setMeta({ summary: response.summary, canManage: response.canManage, manageBlockedReason: response.manageBlockedReason })
      return { items: response.items, total: response.total }
    },
    [values.rq, values.rcategory],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div>
      <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }} align="start" wrap>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, maxWidth: 760 }}>
          亚马逊的原因代码对应中文释义和大类。退货记录里保存的永远是亚马逊的原始代码；这里的设置只决定怎么显示和汇总。映射表自己添加的项最多 {RETURN_REASON_MAP_LIMIT} 个。
        </Typography.Paragraph>
        <CreateReasonAction onDone={refresh} />
      </Space>
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你可以查看原因映射，但不能修改" description={meta.manageBlockedReason} /> : null}
      {meta && meta.summary.unclassified > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`有 ${meta.summary.unclassified} 个原因代码还没有补全`}
          description="它们在退货汇总里显示为“未分类”。点这一行的“编辑”补上中文释义和大类。"
        />
      ) : null}
      {meta ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          <Space size={16} wrap>
            <span>共 {meta.summary.total} 个原因代码</span>
            <span>改过预置 {meta.summary.edited} 个</span>
            <span>自己添加 {meta.summary.custom} 个</span>
            <span>未分类 {meta.summary.unclassified} 个</span>
          </Space>
        </Typography.Paragraph>
      ) : null}
      <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
      <PagedGrid<ReturnReasonMapRow>
        gridId="returns.reason-map"
        serverViews
        viewFilters={viewFilters}
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.code}
        sortableFields={REASON_MAP_SORTABLE}
        defaultSort={REASON_MAP_DEFAULT_SORT}
        resetKey={JSON.stringify([url.signature, version])}
        appliedFilterCount={appliedCount(FIELDS, MODES, values)}
        onClearFilters={url.reset}
        emptyState={{ kind: 'empty', domain: '原因映射', prerequisite: narrowed ? '没有符合当前条件的原因代码；可以放宽条件，或点“重置”。' : '还没有原因映射。点右上角“新增原因”。' }}
        height={520}
      />
    </div>
  )
}
