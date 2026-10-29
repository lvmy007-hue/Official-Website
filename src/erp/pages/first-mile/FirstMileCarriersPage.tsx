import { useCallback, useMemo, useState } from 'react'
import { Alert, Card } from 'antd'
import type { CarrierListResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type TreeOptions, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath } from '../../query/api-query'
import { CarrierRowActions, CreateCarrierAction } from './carriers-actions'
import { carrierColumns, carrierGridRows, type CarrierGridRow } from './carriers-columns'

// 物流渠道与报价（P6-26，16 章第 5.1 节）：物流商 → 渠道 → 阶梯报价三层。头程运单选渠道后，按货物的计费重量（实重与体积重取大，按分抛系数折算）
// 和目的地区找阶梯价，给出预估头程费用；缺重量、体积或报价时明确说明缺什么，不按 0 估。单价是成本字段，没有成本可见权限看不到。

const FIELDS: FilterField[] = [
  {
    key: 'status',
    label: '状态',
    kind: 'select',
    width: 140,
    options: [
      { value: 'ACTIVE', label: '使用中' },
      { value: 'INACTIVE', label: '已停用' },
    ],
  },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '物流商', key: 'q', placeholder: '搜索物流商名称或代码' }]
const TREE: TreeOptions<CarrierGridRow> = { hasChildren: row => row.childRows.length > 0, getChildren: row => row.childRows }

export default function FirstMileCarriersPage() {
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<Pick<CarrierListResponse, 'canManage' | 'manageBlockedReason'> | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  const columns = useMemo(() => carrierColumns(row => <CarrierRowActions row={row} onDone={refresh} />), [refresh])

  const fetchPage = useCallback<PageFetcher<CarrierGridRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<CarrierListResponse>(buildPath('/first-mile/carriers', { status: values.status, q: values.q, page, pageSize }), { signal })
      setMeta({ canManage: response.canManage, manageBlockedReason: response.manageBlockedReason })
      return { items: carrierGridRows(response.items), total: response.total }
    },
    [values.status, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div data-testid="first-mile-carriers-page">
      <PageHeader
        title="物流渠道与报价"
        description="维护头程物流商、渠道和阶梯报价。运单选好渠道后可以按重量与体积预估头程费用，并与实际费用对比找出异常单。"
        actions={<CreateCarrierAction onDone={refresh} />}
      />
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你可以查看物流渠道与报价，但不能修改" description={meta.manageBlockedReason} /> : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<CarrierGridRow>
          gridId="first-mile.carriers"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          resetKey={JSON.stringify([url.signature, version])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          tree={TREE}
          emptyState={{
            kind: 'empty',
            domain: '物流渠道',
            prerequisite: narrowed ? '没有符合当前搜索与筛选的物流商；可以放宽条件，或点“重置”。' : '还没有物流商。点右上角“新增物流商”，再在物流商下添加渠道和阶梯报价。',
          }}
          height={560}
        />
      </Card>
    </div>
  )
}
