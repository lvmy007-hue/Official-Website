import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Space, Typography } from 'antd'
import { SHIP_FROM_STATUSES, SHIP_FROM_STATUS_LABEL, type ShipFromListResponse, type ShipFromRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath, useApiQuery } from '../../query/api-query'
import { useScope } from '../../scope/context'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { CreateShipFromAction, ShipFromRowActions } from './ship-from-actions'
import { SHIP_FROM_DEFAULT_SORT, SHIP_FROM_SORTABLE, shipFromColumns } from './ship-from-columns'

// 发货地址（P6-08，16 章第 4 节）：按店铺维护入仓用的发货方地址，每个店铺设一个默认地址。
// 补货批次转入仓计划草稿时，按“店铺 + 发货地址”分组生成草稿；店铺没有可用地址时转草稿会被挡住并指到本页。
// 被入仓计划用过的地址不能删除，只能停用；增删改、设默认都写审计，修改带版本号（别人先改过会提示刷新）。

const FIELDS: FilterField[] = [{ key: 'status', label: '状态', kind: 'select', width: 140, options: SHIP_FROM_STATUSES.map(value => ({ value, label: SHIP_FROM_STATUS_LABEL[value] })) }]
const MODES: SearchMode[] = [{ id: 'keyword', label: '地址', key: 'q', placeholder: '搜索地址名称、地址行、城市、邮编' }]

type Meta = Pick<ShipFromListResponse, 'summary' | 'canManage' | 'manageBlockedReason'>

export default function ShipFromAddressesPage() {
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [meta, setMeta] = useState<Meta | null>(null)
  // 写操作成功后刷新列表：表格不走缓存，换一个重置键让它重新取（回到第 1 页）
  const [version, setVersion] = useState(0)
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const stores = useMemo(() => (options.data?.stores ?? []).map(store => ({ id: store.id, name: store.name })), [options.data])
  const refresh = useCallback(() => setVersion(current => current + 1), [])

  const columns = useMemo(() => shipFromColumns(row => <ShipFromRowActions row={row} stores={stores} onDone={refresh} />), [stores, refresh])

  const fetchPage = useCallback<PageFetcher<ShipFromRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/ship-from-addresses', { ...apiParams, status: values.status, q: values.q, sort: sort ? `${sort.field}:${sort.direction}` : undefined, page, pageSize })
      const response = await apiFetch<ShipFromListResponse>(path, { signal })
      setMeta({ summary: response.summary, canManage: response.canManage, manageBlockedReason: response.manageBlockedReason })
      return { items: response.items, total: response.total }
    },
    [apiParams, values.status, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const narrowed = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div>
      <PageHeader
        title="发货地址"
        description="入仓计划里的发货方地址。每个店铺可以保存多个，其中一个设为默认；补货批次转入仓计划草稿时按店铺和地址分组生成草稿。"
        actions={<CreateShipFromAction stores={stores} onDone={refresh} />}
      />
      {meta?.manageBlockedReason ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你可以查看发货地址，但不能修改" description={meta.manageBlockedReason} /> : null}
      {meta ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          <Space size={16}>
            <span>范围内共 {meta.summary.total} 个地址</span>
            <span>使用中 {meta.summary.active} 个</span>
            <span>已停用 {meta.summary.inactive} 个</span>
          </Space>
        </Typography.Paragraph>
      ) : null}
      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<ShipFromRow>
          gridId="settings.ship-from"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={SHIP_FROM_SORTABLE}
          defaultSort={SHIP_FROM_DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, url.signature, version])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          emptyState={{
            kind: 'empty',
            domain: '发货地址',
            prerequisite: narrowed ? '没有符合当前搜索与筛选的地址；可以放宽条件，或点“重置”。' : '还没有发货地址。点右上角“新增发货地址”；店铺的第一个地址会自动成为默认。',
          }}
          height={520}
        />
      </Card>
    </div>
  )
}
