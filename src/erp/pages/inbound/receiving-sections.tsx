import { Alert, Card, Tag, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { InboundDiscrepancyResponse, InboundDiscrepancyRow, InboundShipmentTimelineResponse, NoncomplianceItem, OpportunityItem, ReceivingAuditRow } from '@nova/api-contracts'
import { DataState, stateFromError, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { money, qty } from './inbound-ui'

// 货件接收详情的各区块（P2a-13，06 章 6.12）：接收时间线、SKU 差异、不合规问题、赔付任务、审计记录。
// 每个区块自己取数、自己显示加载与错误；没有数据写“尚无记录”，数据源没接入写“尚未接入”，都不写 0。
// 赔付任务只记录机会与截止时间，不在这里提交亚马逊的赔付申请（赔付中心在后续阶段）；估算金额 = 少收数量 × 当前生效的单件商品成本，没有成本不估算。

const base = (id: string) => `/inbound/shipments/${encodeURIComponent(id)}`

function Loaded<T>({ query, children }: { query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }; children: (data: T) => JSX.Element }) {
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={2} />
  return children(query.data)
}

export function TimelineSection({ id }: { id: string }) {
  const query = useApiQuery<InboundShipmentTimelineResponse>({ domain: 'list', path: `${base(id)}/timeline`, scoped: false })
  return (
    <Card size="small" title="接收时间线">
      <Loaded query={query}>
        {data => (
          <>
            {data.events.length === 0 ? (
              <Muted>尚无记录</Muted>
            ) : (
              <Timeline
                items={data.events.map(event => ({
                  children: (
                    <>
                      <Typography.Text strong>{event.title}</Typography.Text> <Typography.Text type="secondary">{formatDateTime(event.at)}</Typography.Text>
                      {event.precision === 'OBSERVED' ? (
                        <Tag bordered={false} style={{ marginLeft: 6 }} title="这是我们同步时看到的时间，不是亚马逊实际发生的时间">
                          同步时观察到
                        </Tag>
                      ) : null}
                      {event.detail ? <div>{event.detail}</div> : null}
                    </>
                  ),
                }))}
              />
            )}
            <Typography.Text type="secondary">{data.note}</Typography.Text>
          </>
        )}
      </Loaded>
    </Card>
  )
}

const ROW_TAG: Record<InboundDiscrepancyRow['state'], { color: string; text: string }> = {
  SHORT: { color: 'error', text: '少收' },
  OVER: { color: 'warning', text: '多收' },
  MATCH: { color: 'success', text: '一致' },
  PENDING: { color: 'default', text: '待货件关闭' },
}

const skuColumns: ColumnsType<InboundDiscrepancyRow> = [
  { title: 'SKU', dataIndex: 'sku', width: 180 },
  { title: 'FNSKU', dataIndex: 'fnsku', width: 130, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '应发', dataIndex: 'shippedQty', width: 90, align: 'right', render: qty },
  { title: '已收', dataIndex: 'receivedQty', width: 90, align: 'right', render: qty },
  { title: '差异', dataIndex: 'discrepancyQty', width: 90, align: 'right', render: qty },
  {
    title: '判定',
    dataIndex: 'state',
    width: 120,
    render: (value: InboundDiscrepancyRow['state']) => (
      <Tag color={ROW_TAG[value].color} bordered={false}>
        {ROW_TAG[value].text}
      </Tag>
    ),
  },
  { title: '差异原因', dataIndex: 'reason', render: (value: string | null) => value ?? <Muted>亚马逊未提供</Muted> },
]

const noncomplianceColumns: ColumnsType<NoncomplianceItem> = [
  { title: 'SKU', dataIndex: 'sku', width: 180 },
  { title: '问题类型', dataIndex: 'problemType', width: 180, render: (value: string | null) => value ?? <Muted>未提供</Muted> },
  { title: '影响数量', dataIndex: 'qty', width: 100, align: 'right', render: (value: number | null) => (value === null ? <Muted>未提供</Muted> : qty(value)) },
  { title: '费用', key: 'amount', width: 120, align: 'right', render: (_value, row) => (row.amount === null ? <Muted>未提供</Muted> : money(row.amount, row.currency ?? 'USD')) },
  { title: '报告日期', dataIndex: 'firstSeenAt', width: 160, render: (value: string) => formatDateTime(value) },
]

const claimColumns: ColumnsType<OpportunityItem> = [
  { title: 'SKU', dataIndex: 'sku', width: 180 },
  { title: '类型', dataIndex: 'ruleLabel', width: 100 },
  { title: '状态', dataIndex: 'statusLabel', width: 110 },
  { title: '少收数量', dataIndex: 'qty', width: 100, align: 'right', render: qty },
  {
    title: '估算金额',
    key: 'amount',
    width: 180,
    align: 'right',
    render: (_value, row) => (row.estimatedAmount === null ? <Muted>无商品成本，无法估算</Muted> : money(row.estimatedAmount, row.currency ?? 'USD')),
  },
  { title: '申请截止', dataIndex: 'deadlineAt', width: 160, render: (value: string | null) => (value ? value.slice(0, 10) : <Muted>尚无记录</Muted>) },
  { title: '发现时间', dataIndex: 'detectedAt', width: 160, render: (value: string) => formatDateTime(value) },
  { title: '证据', key: 'evidence', render: (_value, row) => (row.evidence.length ? row.evidence.map(item => item.label).join('；') : <Muted>尚无记录</Muted>) },
]

/** SKU 差异、不合规问题、赔付任务三块共用一次 /discrepancies 取数。 */
export function DiscrepancySections({ id }: { id: string }) {
  const query = useApiQuery<InboundDiscrepancyResponse>({ domain: 'list', path: `${base(id)}/discrepancies`, scoped: false })
  return (
    <Loaded query={query}>
      {data => (
        <>
          <Card size="small" title="SKU 差异">
            <Typography.Paragraph type="secondary">{data.note}</Typography.Paragraph>
            <SimpleGrid<InboundDiscrepancyRow>
              gridId="inbound.receiving-sections"
              columns={skuColumns}
              rows={data.rows}
              rowKey={row => row.sku}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录' }}
            />
          </Card>
          <Card size="small" title="不合规问题" data-testid="noncompliance-section">
            {data.compliance.state === 'NOT_CONNECTED' ? (
              <Alert type="info" showIcon message="尚未接入" description={`入仓不合规报告还没有同步成功过。${data.compliance.note}`} />
            ) : (
              <>
                {data.compliance.items.length === 0 ? (
                  <Muted>尚无记录</Muted>
                ) : (
                  <SimpleGrid<NoncomplianceItem>
                    gridId="inbound.receiving-sections-2"
                    columns={noncomplianceColumns}
                    rows={data.compliance.items}
                    rowKey={row => `${row.sku}|${row.problemType}`}
                    emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
                  />
                )}
                <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
                  {data.compliance.note}
                </Typography.Paragraph>
              </>
            )}
          </Card>
          <Card size="small" title="赔付任务" data-testid="claims-section">
            <Alert
              type={data.claims.state === 'NOT_JUDGED' ? 'info' : 'warning'}
              showIcon
              style={{ marginBottom: 8 }}
              message={
                data.claims.window
                  ? `等待期至 ${data.claims.window.eligibleFrom}，申请截止 ${data.claims.window.deadline}（${{ WAITING: '还在等待期内', OPEN: '可以申请', EXPIRED: '已过申请期限' }[data.claims.window.state]}）`
                  : '货件关闭后才判断赔付机会'
              }
              description={data.claims.note}
            />
            {data.claims.items.length === 0 ? (
              <Muted>尚无记录</Muted>
            ) : (
              <SimpleGrid<OpportunityItem>
                gridId="inbound.receiving-sections-3"
                columns={claimColumns}
                rows={data.claims.items}
                rowKey={row => row.id}
                emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
              />
            )}
          </Card>
        </>
      )}
    </Loaded>
  )
}

const ACTION_LABEL: Record<string, string> = {
  ATTACHMENT_ADDED: '上传证据附件',
  FBA_INBOUND_TRACKING_UPDATED: '更新追踪号',
  FBA_INBOUND_MARKED_SHIPPED: '标记已发货',
  FBA_INBOUND_LABELS_REQUESTED: '获取亚马逊箱标签',
  FBA_INBOUND_CUSTOM_LABELS_REQUESTED: '生成自定义箱标签',
  FBA_INBOUND_ITEM_LABELS_REQUESTED: '生成商品标签',
  LABEL_PDF_GENERATED: '标签 PDF 生成完成',
  LABEL_TEMPLATE_CREATED: '新增标签模板',
  LABEL_TEMPLATE_UPDATED: '修改标签模板',
  LABEL_TEMPLATE_DELETED: '删除标签模板',
  FBA_INBOUND_PLAN_SUBMITTED: '提交入仓计划',
  FBA_INBOUND_PLAN_CANCELLED: '取消入仓计划',
}
const RESULT_LABEL: Record<string, string> = { SUCCESS: '成功', FAILED: '失败', DENIED: '被拒绝' }

const auditColumns: ColumnsType<ReceivingAuditRow> = [
  { title: '时间', dataIndex: 'at', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '操作', dataIndex: 'action', width: 200, render: (value: string) => ACTION_LABEL[value] ?? value },
  { title: '操作人', dataIndex: 'actorName', width: 140 },
  { title: '结果', dataIndex: 'result', width: 90, render: (value: string) => RESULT_LABEL[value] ?? value },
  { title: '原因', dataIndex: 'reason', render: (value: string | null) => value ?? <Muted>无</Muted> },
]

export function AuditSection({ id }: { id: string }) {
  const query = useApiQuery<ReceivingAuditRow[]>({ domain: 'list', path: `${base(id)}/audit`, scoped: false })
  return (
    <Card size="small" title="审计记录">
      <Loaded query={query}>
        {rows => (
          <SimpleGrid<ReceivingAuditRow>
            gridId="inbound.receiving-sections-4"
            columns={auditColumns}
            rows={rows}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录' }}
          />
        )}
      </Loaded>
    </Card>
  )
}
