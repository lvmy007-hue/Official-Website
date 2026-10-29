import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Card, Tabs } from 'antd'
import {
  INVENTORY_RISK_LABEL,
  INVENTORY_RISK_LEVELS,
  INVENTORY_TABS,
  INVENTORY_TAB_LABEL,
  type InventoryListResponse,
  type InventoryRow,
  type InventorySummaryResponse,
  type InventoryTab,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import {
  DataState,
  FilterBar,
  FreshnessBar,
  PageHeader,
  PagedGrid,
  useUrlFilters,
  type FilterField,
  type FreshnessInfo,
  type PageFetcher,
  type SearchMode,
  type ViewFilterBinding,
} from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { buildPath, useApiQuery } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { INVENTORY_DEFAULT_SORT, INVENTORY_SORTABLE, inventoryColumns } from './inventory-columns'
import { InventoryDrawer } from './InventoryDrawer'
import { RulesDrawer } from './RulesDrawer'
import { SummaryCards, SummaryCharts } from './InventorySummary'
import { canShowTotals, inventoryTotals } from './inventory-totals-row'

// 库存健康（P2a-06，06 章 6.1；P6-03 起用 PagedGrid 骨架 + 服务端视图；P6-04 起用统一筛选栏；P6-05 起行详情用抽屉）：
// 顶部 8 张指标卡与 4 张图 → 7 个页签的库存列表（页码分页、按字段分组、列头问号取自指标字典）→ 库存规则抽屉。
// 风险等级由库存规则（版本化、不使用固定阈值）与近期销量算出；没有配置规则时只显示“尚未配置规则”，不给任何等级。
// 筛选（页签、风险等级、搜索词、批量搜索）都写在地址栏里，刷新能还原；列版式与筛选可以存成“我的 / 团队”视图，
// 单独的筛选还可以存成筛选方案（保存的筛选值已失效时提示，见 ViewFilterBinding）；范围参数来自全局范围栏。

const EMPTY_DOMAIN = '库存'
type ListMeta = { freshness: FreshnessInfo | undefined; policyNote: string | null; truncated: boolean }

// 页签在页面上方单独显示，但同样存在地址栏里（hidden：筛选栏不重复显示）
const FIELDS: FilterField[] = [
  { key: 'tab', label: '页签', kind: 'select', hidden: true, options: INVENTORY_TABS.map(value => ({ value, label: INVENTORY_TAB_LABEL[value] })) },
  { key: 'risk', label: '风险等级', kind: 'select', width: 168, options: INVENTORY_RISK_LEVELS.map(value => ({ value, label: INVENTORY_RISK_LABEL[value] })) },
]
// 单项搜索是包含匹配（SKU、ASIN、FNSKU、名称、品牌）；批量搜索是 SKU、ASIN、FNSKU 的精确匹配
const MODES: SearchMode[] = [{ id: 'keyword', label: '库存', key: 'q', batchKey: 'qs', batchLabel: 'SKU / ASIN / FNSKU', placeholder: '搜索 SKU、ASIN、FNSKU、名称、品牌；可粘贴多行批量查' }]

export default function InventoryHealthPage() {
  const [rulesOpen, setRulesOpen] = useState(false)
  // 行详情抽屉（P6-05）：点 SKU 在右侧看详情，不离开列表
  const [detailId, setDetailId] = useState<string | null>(null)
  const [meta, setMeta] = useState<ListMeta | null>(null)
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values } = url
  const tab = (values.tab as InventoryTab | undefined) ?? 'all'

  const summary = useApiQuery<InventorySummaryResponse>({ domain: 'analytics', path: '/inventory/summary' })
  const columns = useMemo(() => inventoryColumns(setDetailId), [])
  // 范围内合计取自服务端汇总，只在“全部库存”且没有任何搜索与筛选、没有被截断时显示（见 inventory-totals-row）
  const narrowed = [values.q, values.qs, values.risk].filter(Boolean).join('|')
  const totals = canShowTotals(summary.data, tab, narrowed) ? summary.data : null
  const fetchSummary = useMemo(() => (totals ? async () => inventoryTotals(totals) : undefined), [totals])
  const policyNote = meta?.policyNote ?? summary.data?.policyNote ?? null

  const fetchPage = useCallback<PageFetcher<InventoryRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/inventory', { ...apiParams, tab: values.tab, q: values.q, qs: values.qs, risk: values.risk, sort: sort ? `${sort.field}:${sort.direction}` : undefined, page, pageSize })
      const response = await apiFetch<InventoryListResponse>(path, { signal })
      setMeta({ freshness: response.freshness as FreshnessInfo | undefined, policyNote: response.policyNote, truncated: response.truncated })
      return { items: response.items, total: response.total }
    },
    [apiParams, values.tab, values.q, values.qs, values.risk],
  )

  // 视图与筛选方案里保存的筛选就是地址栏里的这组值；套用时认不出的页签、风险等级、多余的键算“已失效”
  const { replaceAll } = url
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])

  return (
    <div>
      <PageHeader
        title="库存健康"
        description="范围内 FBA 库存的数量、可售天数、风险、库龄与仓储费；风险按库存规则的当前版本计算。"
        actions={<Button onClick={() => setRulesOpen(true)}>库存规则</Button>}
      />
      <FreshnessBar freshness={meta?.freshness ?? summary.data?.freshness} />
      {policyNote ? <Alert type="info" showIcon style={{ margin: '8px 0' }} message="尚未配置库存规则" description={policyNote} /> : null}
      {meta?.truncated ? (
        <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="范围内 SKU 过多，只读取了前 5000 个" description="请用顶部范围栏缩小到某些店铺后再看，以免汇总与列表不完整。" />
      ) : null}

      {summary.error ? <DataState kind="server-error" message="汇总读取失败" onRetry={() => void summary.refetch()} /> : null}
      {summary.isPending ? <DataState kind="skeleton" rows={3} /> : null}
      {summary.data ? (
        <>
          <SummaryCards summary={summary.data} />
          <SummaryCharts summary={summary.data} />
        </>
      ) : null}

      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs activeKey={tab} onChange={key => url.set({ tab: key === 'all' ? undefined : key })} items={INVENTORY_TABS.map(key => ({ key, label: INVENTORY_TAB_LABEL[key] }))} />
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<InventoryRow>
          gridId="inventory.health"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={INVENTORY_SORTABLE}
          defaultSort={INVENTORY_DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, url.signature])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          fetchSummary={fetchSummary}
          emptyState={{
            kind: 'empty',
            domain: EMPTY_DOMAIN,
            prerequisite:
              narrowed !== ''
                ? '没有符合当前搜索与筛选的 SKU；可以放宽条件，或点“重置”。'
                : tab === 'all'
                  ? '范围内没有 FBA 库存记录；店铺授权并完成库存同步后显示。'
                  : `当前范围内没有符合“${INVENTORY_TAB_LABEL[tab]}”的 SKU。`,
          }}
          height={560}
        />
      </Card>
      <RulesDrawer open={rulesOpen} onClose={() => setRulesOpen(false)} />
      <InventoryDrawer id={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}
