import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Tabs } from 'antd'
import {
  LEDGER_EVENT_GROUPS,
  LEDGER_EVENT_GROUP_LABEL,
  LEDGER_VIEWS,
  LEDGER_VIEW_LABEL,
  type LedgerDetailResponse,
  type LedgerDetailRow,
  type LedgerSummaryResponse,
  type LedgerSummaryRow,
  type LedgerView,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import {
  FilterBar,
  FreshnessBar,
  MassiveGrid,
  PageHeader,
  PagedGrid,
  useUrlFilters,
  type CursorFetcher,
  type FilterField,
  type FreshnessInfo,
  type PageFetcher,
  type SearchMode,
} from '../../components'
import { appliedCount } from '../../components/filter/filter-model'
import { useScope } from '../../scope/context'
import { buildPath } from '../../query/api-query'
import { detailColumns, summaryColumns } from './ledger-columns'
import { StateBlock } from './inventory-ui'

// 库存台账（P2a-09，06 章 6.4；P6-28 迁到 PagedGrid 与 MassiveGrid）：汇总按“店铺 × FNSKU × 月”做“期初 + 变动 = 期末”平衡校验，不平衡的行标红并给出差额；
// 明细逐条流水，按事件类型分组筛选。台账量大，明细用游标无限滚动。
// 平衡校验只在页面上标出，不生成预警、不生成赔偿线索（由 P2a-15 与 P2b-03 交付）；库存接口比对只是参考。

type SummaryMeta = Pick<LedgerSummaryResponse, 'freshness' | 'state' | 'note' | 'unbalancedCount' | 'from' | 'to' | 'truncated'>
type DetailMeta = Pick<LedgerDetailResponse, 'freshness' | 'state' | 'note'>

const MODES: SearchMode[] = [{ id: 'keyword', label: 'SKU', key: 'q', placeholder: '搜索 SKU、FNSKU、ASIN' }]
const SUMMARY_FIELDS: FilterField[] = [
  {
    key: 'unbalanced',
    label: '平衡校验',
    kind: 'select',
    width: 160,
    options: [
      { value: 'true', label: '只看不平衡' },
      { value: 'false', label: '全部' },
    ],
  },
]
const DETAIL_FIELDS: FilterField[] = [{ key: 'group', label: '事件类型', kind: 'select', width: 180, options: LEDGER_EVENT_GROUPS.map(value => ({ value, label: LEDGER_EVENT_GROUP_LABEL[value] })) }]
function SummaryPane() {
  const { apiParams } = useScope()
  const url = useUrlFilters(SUMMARY_FIELDS, MODES)
  const q = url.values.q ?? ''
  const unbalanced = url.values.unbalanced === 'true'
  const [meta, setMeta] = useState<SummaryMeta | null>(null)
  const columns = useMemo(() => summaryColumns(), [])
  const fetchPage = useCallback<PageFetcher<LedgerSummaryRow>>(
    async ({ page, pageSize, signal }) => {
      const params = { ...apiParams, view: 'summary', q: q || undefined, unbalanced: unbalanced ? 'true' : undefined, page, pageSize }
      const data = await apiFetch<LedgerSummaryResponse>(buildPath('/inventory/ledger', params), { signal })
      const { freshness, state, note, unbalancedCount, from, to, truncated } = data
      setMeta({ freshness, state, note, unbalancedCount, from, to, truncated })
      return { items: data.items, total: data.total }
    },
    [apiParams, q, unbalanced],
  )
  return (
    <>
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta ? <StateBlock state={meta.state} note={meta.note} /> : null}
      {meta && meta.state === 'OK' ? (
        <Alert
          type={meta.unbalancedCount > 0 ? 'warning' : 'success'}
          showIcon
          style={{ margin: '8px 0' }}
          message={meta.unbalancedCount > 0 ? `${meta.from} 至 ${meta.to} 有 ${meta.unbalancedCount} 行平衡校验不通过` : `${meta.from} 至 ${meta.to} 的台账全部平衡`}
          description="平衡校验：期初 + 各类变动 = 期末（报告里发货、丢失等本身带负号；在途不参与）。不平衡可能是事件类型没有识别、报告缺行，也可能是亚马逊侧差异，需要人工核对。"
        />
      ) : null}
      {meta?.truncated ? (
        <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="范围内台账行数过多，只读取了前 20000 行" description="请用顶部范围栏缩小到某些店铺后再看，以免汇总不完整。" />
      ) : null}
      <FilterBar fields={SUMMARY_FIELDS} modes={MODES} values={url.values} onChange={url.set} onReset={url.reset} />
      <PagedGrid<LedgerSummaryRow>
        gridId="inventory.ledger.summary"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.key}
        resetKey={JSON.stringify([apiParams, url.signature])}
        appliedFilterCount={appliedCount(SUMMARY_FIELDS, MODES, url.values)}
        onClearFilters={url.reset}
        emptyState={{ kind: 'empty', domain: '库存台账', prerequisite: unbalanced ? '当前范围内没有平衡校验不通过的行。' : '店铺授权并完成台账报告同步后显示；台账报告按月汇总。' }}
        height={560}
      />
    </>
  )
}

function DetailPane() {
  const { apiParams } = useScope()
  const url = useUrlFilters(DETAIL_FIELDS, MODES)
  const q = url.values.q ?? ''
  const group = url.values.group || undefined
  const [meta, setMeta] = useState<DetailMeta | null>(null)
  const columns = useMemo(() => detailColumns(), [])
  const fetchPage = useCallback<CursorFetcher<LedgerDetailRow>>(
    async ({ cursor, limit, signal }) => {
      const params = { ...apiParams, view: 'detail', q: q || undefined, group, pageSize: limit, cursor: cursor ?? undefined }
      const data = await apiFetch<LedgerDetailResponse>(buildPath('/inventory/ledger', params), { signal })
      setMeta({ freshness: data.freshness, state: data.state, note: data.note })
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    [apiParams, q, group],
  )
  return (
    <>
      <FreshnessBar freshness={meta?.freshness as FreshnessInfo | undefined} />
      {meta ? <StateBlock state={meta.state} note={meta.note} /> : null}
      <FilterBar fields={DETAIL_FIELDS} modes={MODES} values={url.values} onChange={url.set} onReset={url.reset} />
      <MassiveGrid<LedgerDetailRow>
        gridId="inventory.ledger.detail"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={JSON.stringify([apiParams, url.signature])}
        appliedFilterCount={appliedCount(DETAIL_FIELDS, MODES, url.values)}
        onClearFilters={url.reset}
        emptyState={{ kind: 'empty', domain: '库存台账明细', prerequisite: group ? '当前事件类型下没有流水。' : '店铺授权并完成台账明细报告同步后显示。' }}
        height={560}
      />
    </>
  )
}

export default function InventoryLedgerPage() {
  const [view, setView] = useState<LedgerView>('summary')
  return (
    <div>
      <PageHeader title="库存台账" description="亚马逊库存台账的月度汇总与逐条流水；汇总做“期初 + 变动 = 期末”平衡校验，不平衡的行标红。" />
      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={view}
          onChange={key => setView(key as LedgerView)}
          items={LEDGER_VIEWS.map(key => ({ key, label: LEDGER_VIEW_LABEL[key], children: key === 'summary' ? <SummaryPane /> : <DetailPane /> }))}
        />
      </Card>
    </div>
  )
}
