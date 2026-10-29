import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Space, Tabs, Tag } from 'antd'
import { HIJACK_DELAY_NOTE_PREFIX, HIJACK_STATUSES, HIJACK_STATUS_LABEL, HIJACK_WHITELIST_MODES, HIJACK_WHITELIST_MODE_LABEL, type HijackListResponse, type HijackRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, MassiveGrid, PageHeader, useUrlFilters, type CursorFetcher, type FilterField, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { HIJACK_DEFAULT_SORT, HIJACK_SORTABLE, hijackColumns } from './hijack-columns'
import { HijackWhitelistPanel } from './hijack-whitelist-panel'

// 跟卖监控（P6-17，16 章第 3.2、10 节）：我方 Listing 上出现的其他报价方，含首次出现时间、报价、是否 FBA、是否拿到购物车与白名单。
// 数据只来自官方竞争摘要（定价同步器每 2 小时读一次，商品很多时按轮转），不抓前台页面，所以一定有延迟，页面顶部写明最长延迟。
// 默认只看“仍在报价”且“不含白名单”；白名单里的卖家（自己的其他店铺等）不算跟卖。竞争摘要只保留价格最低的 30 个报价，排在后面的看不到。
// 预警“我方 Listing 出现其他报价方”在预警规则里配置（回看天数、数量下限）。

const FIELDS: FilterField[] = [
  { key: 'status', label: '状态', kind: 'select', options: HIJACK_STATUSES.map(value => ({ value, label: HIJACK_STATUS_LABEL[value] })) },
  { key: 'whitelist', label: '白名单', kind: 'select', options: HIJACK_WHITELIST_MODES.map(value => ({ value, label: HIJACK_WHITELIST_MODE_LABEL[value] })) },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '商品', key: 'q', placeholder: '搜索 SKU 或 ASIN' }]

type Meta = Pick<HijackListResponse, 'summary' | 'delayNote' | 'maxDelayHours' | 'note'>

export default function HijackMonitorPage() {
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const [tab, setTab] = useState<'offers' | 'whitelist'>('offers')
  const [meta, setMeta] = useState<Meta | null>(null)

  const fetchPage = useCallback<CursorFetcher<HijackRow>>(
    async ({ cursor, limit, sort, signal }) => {
      const path = buildPath('/tools/hijack', { ...values, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined })
      const response = await apiFetch<HijackListResponse>(path, { signal })
      // 汇总与延迟说明以第一块为准（后续块的游标只管翻页）
      if (cursor === null) setMeta({ summary: response.summary, delayNote: response.delayNote, maxDelayHours: response.maxDelayHours, note: response.note })
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    [values],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])
  const filtered = appliedCount(FIELDS, MODES, values) > 0

  return (
    <div data-testid="hijack-page">
      <PageHeader title="跟卖监控" description="我方商品上出现的其他报价方：首次出现时间、报价、是否 FBA、是否拿到购物车。自己的其他店铺等放进白名单后不再算跟卖。只读观察，不会改价、不会投诉。" />
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        data-testid="hijack-delay"
        message={meta?.delayNote ?? `${HIJACK_DELAY_NOTE_PREFIX}，有延迟（同步每 2 小时一次，商品很多时更久）；排在价格最低的 30 个报价之外的卖家看不到。`}
      />
      <Card size="small">
        {meta ? (
          <Space size={8} wrap style={{ marginBottom: 8 }} data-testid="hijack-summary">
            <Tag color="error" bordered={false}>{`需要关注 ${meta.summary.activeNotWhitelisted}`}</Tag>
            <Muted>{`仍在报价 ${meta.summary.active}（其中白名单 ${meta.summary.whitelisted}）；已消失 ${meta.summary.gone}`}</Muted>
          </Space>
        ) : null}
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as 'offers' | 'whitelist')}
          items={[
            { key: 'offers', label: '其他报价方' },
            { key: 'whitelist', label: '白名单' },
          ]}
        />
        {tab === 'offers' ? (
          <>
            <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
            <MassiveGrid<HijackRow>
              gridId="tools.hijack"
              serverViews
              viewFilters={viewFilters}
              columns={hijackColumns}
              fetchPage={fetchPage}
              getRowId={row => row.id}
              sortableFields={HIJACK_SORTABLE}
              defaultSort={HIJACK_DEFAULT_SORT}
              resetKey={JSON.stringify([url.signature])}
              appliedFilterCount={appliedCount(FIELDS, MODES, values)}
              onClearFilters={url.reset}
              emptyState={{
                kind: 'empty',
                domain: '跟卖观察',
                prerequisite: filtered ? '没有符合条件的记录；可以放宽筛选条件。' : (meta?.note ?? '目前没有需要关注的跟卖；官方竞争摘要同步后才会出现记录。'),
              }}
              height={560}
            />
          </>
        ) : (
          <HijackWhitelistPanel />
        )}
      </Card>
    </div>
  )
}
