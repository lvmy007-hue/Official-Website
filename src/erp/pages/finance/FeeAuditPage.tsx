import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert, Card, Drawer, Input, Select, Space, Tabs } from 'antd'
import {
  FEE_AUDIT_KINDS,
  FEE_AUDIT_KIND_LABEL,
  FEE_AUDIT_STATUSES,
  FEE_AUDIT_STATUS_LABEL,
  FEE_AUDIT_WINDOW_DAYS,
  SIZE_TIER_CHANGE_DAYS,
  type FeeAuditKind,
  type FeeAuditKindSummary,
  type FeeAuditListResponse,
  type FeeAuditRow,
  type SizeTierChangeRow,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FreshnessBar, LocalGrid, MassiveGrid, PageHeader, type CursorFetcher } from '../../components'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { money } from '../orders/orders-ui'
import { FeeAuditBasis } from './fee-audit-basis'
import { AUDIT_SORTABLE, auditColumns, sizeTierColumns } from './fee-audit-columns'

// 费用核查（P2b-06，07 章 7.6；P6-28 迁到 MassiveGrid / LocalGrid）：用亚马逊的费用基准核对实际收费，分配送费、佣金、仓储费、入仓配置费四个页签。
// 每个页签显示参与核查的对象数、疑似多收的对象数、发生次数与按币种分别合计的累计差额；点一行在右侧抽屉里看依据；疑似多收的可一键转为赔付机会。
// 这里的“多收”是疑似，不是亚马逊认可的结论；没有基准的 SKU 不显示，也不当作“正常”。下方单独列出最近的尺寸分段变化。

const STATUS_OPTIONS = FEE_AUDIT_STATUSES.map(value => ({ value, label: FEE_AUDIT_STATUS_LABEL[value] }))

type Filters = { status?: string; q?: string }
type Meta = Omit<FeeAuditListResponse, 'items' | 'pageInfo'>

function SummaryLine({ summary }: { summary: FeeAuditKindSummary | undefined }) {
  if (!summary || summary.subjects === 0) return <Muted>这一类尚无核查结果</Muted>
  return (
    <Space size={16} wrap>
      <span>
        参与核查 <span className="erp-num">{summary.subjects}</span> 个对象，疑似多收 <span className="erp-num">{summary.suspected}</span> 个，共 <span className="erp-num">{summary.occurrences}</span>{' '}
        次
      </span>
      <span>
        累计差额：
        {summary.overcharge.length === 0
          ? '无'
          : summary.overcharge.map((item, index) => (
              <span key={item.currency}>
                {index > 0 ? '；' : ''}
                {money(item.amount, item.currency)}
              </span>
            ))}
      </span>
    </Space>
  )
}

function SizeTierSection({ rows }: { rows: SizeTierChangeRow[] }) {
  return (
    <Card size="small" title={`最近 ${SIZE_TIER_CHANGE_DAYS} 天尺寸分段变化`} style={{ marginTop: 16 }}>
      <p style={{ margin: '0 0 8px', color: 'rgba(0,0,0,0.65)' }}>亚马逊重新测量后商品所属的尺寸分段变了，配送费会随之变化；分段变化不一定是多收，请对照实物尺寸确认。</p>
      <LocalGrid<SizeTierChangeRow>
        gridId="finance.fee-audit.size-tier"
        columns={sizeTierColumns}
        rows={rows}
        getRowId={row => `${row.sellerAccountId}|${row.sku}`}
        emptyState={{ kind: 'empty', domain: '尺寸分段变化', prerequisite: `最近 ${SIZE_TIER_CHANGE_DAYS} 天没有发现尺寸分段变化；需要每天的预估配送费报告对比前后两天，报告同步后显示。` }}
        height={320}
      />
    </Card>
  )
}

export default function FeeAuditPage() {
  const { canPermission } = useSession()
  const { apiParams } = useScope()
  const [kind, setKind] = useState<FeeAuditKind>('FULFILLMENT')
  const [filters, setFilters] = useState<Filters>({})
  const [meta, setMeta] = useState<Meta | null>(null)
  const [opened, setOpened] = useState<FeeAuditRow | null>(null)
  const [nonce, setNonce] = useState(0)
  // 列定义保持稳定（列变了表格会整体重绘）：权限与服务端给的 canConvert 用 ref 取当前值，canConvert 在行返回之前写好
  const canConvertRef = useRef(false)
  const canReimbursementsRef = useRef(false)
  canReimbursementsRef.current = canPermission('reimbursements.read')
  const columns = useMemo(() => auditColumns({ canConvert: () => canConvertRef.current, canReimbursements: () => canReimbursementsRef.current, onChanged: () => setNonce(value => value + 1) }), [])
  const fetchPage = useCallback<CursorFetcher<FeeAuditRow>>(
    async ({ cursor, limit, sort, signal }) => {
      const params = { ...apiParams, ...filters, kind, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined }
      const data = await apiFetch<FeeAuditListResponse>(buildPath('/finance/fee-audit', params), { signal })
      const { items, pageInfo, ...rest } = data
      canConvertRef.current = data.canConvert
      setMeta(rest)
      return { items, nextCursor: pageInfo.hasMore ? pageInfo.nextCursor : null, approxTotal: pageInfo.approxTotal }
    },
    [apiParams, filters, kind],
  )
  const set = (patch: Filters) => setFilters(current => ({ ...current, ...patch }))
  const filterCount = Object.values(filters).filter(Boolean).length
  const byKind = new Map(meta?.summary.map(item => [item.kind, item]))

  return (
    <div>
      <PageHeader
        title="费用核查"
        description="用亚马逊给出的预估费用与尺寸测量核对实际收费：配送费、佣金、仓储费、入仓配置费。发现疑似多收可以转为赔付机会；也会提示尺寸分段变化。核查结果是“疑似”，需要人工确认。"
      />
      <Card size="small">
        <FreshnessBar freshness={meta?.freshness} />
        {meta?.snapshotDate ? (
          <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`当前显示的核查日：${meta.snapshotDate}（核查每 6 小时刷新一次，只看最近 ${FEE_AUDIT_WINDOW_DAYS} 天的订单与收费）`} />
        ) : null}
        <Tabs
          activeKey={kind}
          onChange={key => setKind(key as FeeAuditKind)}
          items={FEE_AUDIT_KINDS.map(key => {
            const item = byKind.get(key)
            return { key, label: item ? `${FEE_AUDIT_KIND_LABEL[key]}（疑似 ${item.suspected}）` : FEE_AUDIT_KIND_LABEL[key] }
          })}
        />
        <Alert type="info" style={{ marginBottom: 8 }} message={byKind.get(kind)?.note ?? FEE_AUDIT_KIND_LABEL[kind]} description={<SummaryLine summary={byKind.get(kind)} />} />
        <Space wrap style={{ margin: '8px 0' }}>
          <Input.Search allowClear style={{ width: 260 }} placeholder="搜索 SKU、ASIN、货件号（开头匹配）" aria-label="搜索费用核查" onSearch={value => set({ q: value.trim() || undefined })} />
          <Select allowClear style={{ width: 150 }} placeholder="状态" aria-label="状态" value={filters.status} options={STATUS_OPTIONS} onChange={value => set({ status: value })} />
        </Space>
        <MassiveGrid<FeeAuditRow>
          gridId="finance.fee-audit"
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.id}
          sortableFields={AUDIT_SORTABLE}
          defaultSort={{ field: 'overchargeAmount', direction: 'desc' }}
          resetKey={JSON.stringify([apiParams, filters, kind, nonce])}
          appliedFilterCount={filterCount}
          onRowOpen={setOpened}
          emptyState={{ kind: 'empty', domain: '费用核查', prerequisite: filterCount > 0 ? '没有符合条件的核查结果；可以放宽筛选条件。' : (meta?.note ?? '尚无费用核查结果。') }}
          height={520}
        />
      </Card>
      <SizeTierSection rows={meta?.sizeTierChanges ?? []} />
      <Drawer title="核查依据" width={760} open={opened !== null} onClose={() => setOpened(null)} destroyOnHidden>
        {opened ? <FeeAuditBasis row={opened} /> : null}
      </Drawer>
    </div>
  )
}
