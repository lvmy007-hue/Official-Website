import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Card, Select, Space, Typography } from 'antd'
import {
  BATCH_STATUS_LABEL,
  CALC_STATE_LABEL,
  INVENTORY_RISK_LABEL,
  SHIP_DUE_FILTERS,
  SHIP_DUE_LABEL,
  type BatchListResponse,
  type BatchSnapshot,
  type BatchSummary,
  type CalcState,
  type InventoryRiskLevel,
  type RecommendationListResponse,
  type RecommendationRow,
  type RecomputeResponse,
  type ShipDueFilter,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FilterBar, FormAction, PageHeader, PagedGrid, useUrlFilters, type FilterField, type PageFetcher, type SearchMode, type ViewFilterBinding } from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { formatDateTime } from '../../format'
import { buildPath, useApiMutation, useApiQuery } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { LiveLink } from '../inventory/inventory-ui'
import { ActionBar } from './ActionBar'
import { ForecastOverridesButton } from './ForecastOverridesButton'
import { InboundIntentsButton } from './InboundIntentsButton'
import { PolicyDrawer } from './PolicyDrawer'
import { RecommendationDrawer } from './RecommendationDrawer'
import { RECOMMENDATION_DEFAULT_SORT, RECOMMENDATION_SORTABLE, recommendationGridColumns } from './recommendation-grid-columns'
import { SimulationDrawer } from './SimulationDrawer'

// 补货建议（P2a-07，06 章 6.2；P6-09 起用 PagedGrid 骨架 + 统一筛选栏 + 行详情抽屉）：批次选择 → 建议列表 → 勾选后批量采纳/调整/忽略/生成草稿 → 模拟。
// 一次计算 = 一个批次，批次冻结当时的全部输入；重新计算会产生新批次，旧批次保留供回看。点一行在右侧抽屉看计算链、供给与必断货量、亚马逊对照。
// 快捷筛选：“本周需发货”（建议发货日在今天起 7 天内）、“已逾期”（建议发货日早于今天）；风险、搜索词与快捷筛选都写在地址栏里，刷新能还原。
// 没有产出建议的 SKU 按原因计数显示（没有策略、没有销量、无需补货等），不凭空补默认参数。

const PLAN = 'replenishment.plan.create'
const RISKS: InventoryRiskLevel[] = ['HIGH', 'MEDIUM', 'NORMAL', 'EXCESS']

// 快捷筛选与风险：due 在筛选栏上方用两个切换按钮操作（hidden：筛选栏不重复显示），同样存在地址栏里
const FIELDS: FilterField[] = [
  { key: 'risk', label: '风险', kind: 'select', width: 168, options: RISKS.map(value => ({ value, label: INVENTORY_RISK_LABEL[value] })) },
  { key: 'due', label: '发货时间', kind: 'select', hidden: true, options: SHIP_DUE_FILTERS.map(value => ({ value, label: SHIP_DUE_LABEL[value] })) },
]
const MODES: SearchMode[] = [{ id: 'keyword', label: '建议', key: 'q', placeholder: '搜索 SKU、ASIN' }]

const skippedText = (skipped: Record<string, number>) =>
  Object.entries(skipped)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${CALC_STATE_LABEL[state as CalcState] ?? state} ${count} 个`)
    .join('；')

type Meta = { batch: BatchSummary | null; snapshot: BatchSnapshot | null }

export default function ReplenishmentPage() {
  const [batchId, setBatchId] = useState<string | undefined>()
  const [policyOpen, setPolicyOpen] = useState(false)
  const [simulate, setSimulate] = useState<RecommendationRow | null>(null)
  const [detail, setDetail] = useState<RecommendationRow | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  // 写操作成功后刷新列表：表格不走缓存，换一个重置键让它重新取（回到第 1 页，并清掉勾选）
  const [version, setVersion] = useState(0)
  const { apiParams } = useScope()
  const url = useUrlFilters(FIELDS, MODES)
  const { values, replaceAll } = url
  const due = values.due as ShipDueFilter | undefined

  const batches = useApiQuery<BatchListResponse>({ domain: 'list', path: '/replenishment/batches', params: { pageSize: 20 }, scoped: false })
  const recompute = useApiMutation<Record<string, never>, RecomputeResponse>({ method: 'POST', path: '/replenishment/recompute', invalidate: ['list', 'analytics'], silent: true })
  const refresh = useCallback(() => setVersion(current => current + 1), [])
  const columns = useMemo(() => recommendationGridColumns(setSimulate), [])

  const fetchPage = useCallback<PageFetcher<RecommendationRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const path = buildPath('/replenishment/recommendations', {
        ...apiParams,
        batchId,
        risk: values.risk,
        due: values.due,
        q: values.q,
        sort: sort ? `${sort.field}:${sort.direction}` : undefined,
        page,
        pageSize,
      })
      const response = await apiFetch<RecommendationListResponse>(path, { signal })
      setMeta({ batch: response.batch, snapshot: response.snapshot })
      return { items: response.items, total: response.total }
    },
    [apiParams, batchId, values.risk, values.due, values.q],
  )
  const viewFilters = useMemo<ViewFilterBinding>(() => ({ value: values, dimension: null, apply: (filters, dimension) => replaceAll(filters) + (dimension === null ? 0 : 1) }), [values, replaceAll])

  const current = meta?.batch ?? null
  const snapshot = meta?.snapshot ?? null
  const narrowed = appliedCount(FIELDS, MODES, values) > 0
  const bulk = useCallback((rows: RecommendationRow[]) => (rows.length === 0 || !current ? null : <ActionBar batchId={current.id} selected={rows} onDone={refresh} />), [current, refresh])
  const toggleDue = (next: ShipDueFilter) => url.set({ due: due === next ? undefined : next })

  return (
    <div>
      <PageHeader
        title="补货建议"
        description="按补货策略与近期销量算出每个 SKU 该补多少、何时下单；每个数字都能展开到公式。建议是辅助决策，不会自动下单。"
        actions={
          <Space>
            <InboundIntentsButton />
            <ForecastOverridesButton />
            <Button onClick={() => setPolicyOpen(true)}>补货策略</Button>
            <FormAction
              label="重新计算"
              guard={{ permission: PLAN }}
              title="重新计算补货建议"
              description="按当前生效的策略版本、最新库存与近期销量重新计算，生成一个新批次；旧批次保留，可以随时回看。"
              okText="开始计算"
              successText="已生成新批次"
              buttonProps={{ type: 'primary' }}
              onSubmit={async () => {
                const result = await recompute.mutateAsync({})
                setBatchId(result.batch.id)
                refresh()
              }}
            />
          </Space>
        }
      />

      {batches.data && batches.data.items.length > 0 ? (
        <Space wrap style={{ marginBottom: 8 }}>
          <Typography.Text>批次</Typography.Text>
          <Select
            style={{ width: 360 }}
            aria-label="选择批次"
            value={batchId ?? current?.id}
            options={batches.data.items.map(item => ({ value: item.id, label: `${item.batchNo} · ${BATCH_STATUS_LABEL[item.status]} · ${formatDateTime(item.computedAt)}` }))}
            onChange={value => {
              setBatchId(value)
              refresh()
            }}
          />
          {current ? (
            <LiveLink component="ReplenishmentBatchDetailPage" id={current.id}>
              查看批次详情与结果回看
            </LiveLink>
          ) : null}
        </Space>
      ) : null}

      {snapshot ? (
        <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 8 }}>
          {Object.values(snapshot.skipped).some(count => count > 0) ? <Alert type="info" showIcon message="部分 SKU 没有产出建议" description={skippedText(snapshot.skipped)} /> : null}
          {snapshot.truncated ? <Alert type="warning" showIcon message="范围内 SKU 过多，只计算了前一部分" description="请用顶部范围栏缩小到某些店铺后重新计算。" /> : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            计算日 {snapshot.today}；库存更新于 {snapshot.dataTimes.inventoryUpdatedAt ? formatDateTime(snapshot.dataTimes.inventoryUpdatedAt) : '尚无记录'}；订阅省预测
            {snapshot.subscribeSaveUsed > 0 ? `已用于 ${snapshot.subscribeSaveUsed} 个 SKU` : '没有用到（未开通订阅省或快照已过期）'}。
            {snapshot.overrideUsed ? `人工预测规则用于 ${snapshot.overrideUsed} 个 SKU。` : ''}
            {snapshot.unavoidableSkus ? `${snapshot.unavoidableSkus} 个 SKU 存在必断货量，其中 ${snapshot.unavoidableIncludedSkus ?? 0} 个已计入建议量。` : ''}
          </Typography.Text>
        </Space>
      ) : null}

      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <Space wrap style={{ marginBottom: 8 }}>
          {SHIP_DUE_FILTERS.map(item => (
            <Button key={item} size="small" type={due === item ? 'primary' : 'default'} aria-pressed={due === item} onClick={() => toggleDue(item)}>
              {SHIP_DUE_LABEL[item]}
            </Button>
          ))}
        </Space>
        <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={url.set} onReset={url.reset} />
        <PagedGrid<RecommendationRow>
          gridId="replenishment.recommendations"
          serverViews
          viewFilters={viewFilters}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={RECOMMENDATION_SORTABLE}
          defaultSort={RECOMMENDATION_DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, batchId ?? null, url.signature, version])}
          appliedFilterCount={appliedCount(FIELDS, MODES, values)}
          onClearFilters={url.reset}
          renderBulkActions={bulk}
          onRowOpen={setDetail}
          emptyState={
            meta && !meta.batch
              ? { kind: 'empty', domain: '补货建议', prerequisite: '还没有计算过。先在“补货策略”里设置企业级策略，再点“重新计算”；库存与订单同步完成后建议才有依据。' }
              : {
                  kind: 'empty',
                  domain: '补货建议',
                  prerequisite: narrowed ? '没有符合当前搜索与筛选的建议；可以放宽条件，或点“重置”。' : '当前批次下没有建议；可以查看上方“没有产出建议”的原因。',
                }
          }
          height={560}
        />
      </Card>
      <RecommendationDrawer row={detail} onClose={() => setDetail(null)} onSimulate={setSimulate} />
      <PolicyDrawer open={policyOpen} onClose={() => setPolicyOpen(false)} />
      <SimulationDrawer row={simulate} onClose={() => setSimulate(null)} />
    </div>
  )
}
