import { Alert, Descriptions, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useParams } from '@tanstack/react-router'
import { RETURN_COMMENT_MAX_CHARS, type CommentView, type ReturnDetailResponse, type ReturnFeeLine } from '@nova/api-contracts'
import { DataState, DetailLayout, PiiField, stateFromError, type PiiFieldSpec, SimpleGrid } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { RefundCell, money, text, timeText } from '../orders/orders-ui'
import { DispositionTag, ReimbursementCell } from './returns-ui'

// 退货详情（P2b-02，07 章 7.2）：身份区 ≤6 项关键指标 → 概览 / 退款与费用 / 关联赔付 / 处理时间线。
// 买家备注是自由文本，可能含个人信息：详情只给状态，原文经统一出口查看（填理由、写审计、到点自动隐藏），不进日志与导出。

const metricsOf = (detail: ReturnDetailResponse): IdentityMetric[] => [
  { label: '退货日期', value: timeText(detail.record.returnDate) },
  { label: '数量', value: <span className="erp-num">{detail.record.quantity}</span> },
  { label: '处置', value: <DispositionTag view={detail.disposition} /> },
  { label: '退款（订单口径）', value: <RefundCell refund={detail.refund} currency={detail.refund.currency} /> },
  { label: '退款后是否收到退货', value: detail.receipt.state === 'PENDING_DATA' || detail.receipt.state === 'NO_REFUND' ? <Muted>{detail.receipt.label}</Muted> : detail.receipt.label },
  { label: '赔付', value: <ReimbursementCell view={detail.reimbursement} /> },
]

const statusesOf = (detail: ReturnDetailResponse): StatusTag[] => (detail.record.reportStatus ? [{ text: detail.record.reportStatus }] : [])

const feeColumns: ColumnsType<ReturnFeeLine> = [
  { title: '入账时间', dataIndex: 'postedAt', width: 170, render: (value: string) => timeText(value) },
  { title: '费用', dataIndex: 'label' },
  { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (value: number, row) => money(value, row.currency) },
]

const COMMENT_FIELDS: readonly PiiFieldSpec[] = [{ name: 'customerComments', label: '买家留言' }]

// 买家备注（P6-14）：详情只告诉有没有、含哪几类个人信息；原文走统一出口 POST /pii/reveal，要填理由、写审计、到点自动隐藏。
function BuyerComments({ id, view }: { id: string; view: CommentView }) {
  if (view.state === 'NONE') return <Muted>买家没有留言</Muted>
  return (
    <div data-testid="buyer-comments">
      <PiiField
        objectType="RETURN"
        objectId={id}
        fields={COMMENT_FIELDS}
        layout="text"
        available={view.state === 'AVAILABLE'}
        unavailableNote={<Muted>买家留言已超过保留期，按亚马逊要求已清除。</Muted>}
        kinds={view.kinds}
        retainedUntil={view.retainedUntil}
        buttonLabel="查看买家留言"
        dialogTitle="查看买家留言"
        reasonPlaceholder="例如：核对退货原因"
      />
      {view.state === 'AVAILABLE' ? <Muted>只保存报告里的前 {RETURN_COMMENT_MAX_CHARS} 个字；留言可能含个人信息，请勿外传。</Muted> : null}
    </div>
  )
}

function Overview({ detail }: { detail: ReturnDetailResponse }) {
  const { record, order, product } = detail
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="订单">
          {order.id ? <AppLink to={`/app/orders/${encodeURIComponent(order.id)}`}>{order.amazonOrderId}</AppLink> : <span className="erp-num">{order.amazonOrderId}</span>}
          {order.id ? null : <Muted>（订单尚未同步）</Muted>}
        </Descriptions.Item>
        <Descriptions.Item label="订单状态">{text(order.statusLabel)}</Descriptions.Item>
        <Descriptions.Item label="下单时间">{timeText(order.purchaseDate)}</Descriptions.Item>
        <Descriptions.Item label="订单金额">{money(order.amount, order.currency)}</Descriptions.Item>
        <Descriptions.Item label="商品">
          {product.productId ? (
            <LiveLink component="Asin360Page" id={product.productId}>
              {product.title ?? record.asin}
            </LiveLink>
          ) : (
            (product.title ?? <span className="erp-num">{record.asin}</span>)
          )}
        </Descriptions.Item>
        <Descriptions.Item label="ASIN / SKU / FNSKU">
          <span className="erp-num">{[record.asin, record.sku, record.fnsku].filter(Boolean).join(' · ')}</span>
        </Descriptions.Item>
        <Descriptions.Item label="退货原因">{detail.reason.label ? <span title={detail.reason.code ?? undefined}>{detail.reason.label}</span> : <Muted>未提供原因</Muted>}</Descriptions.Item>
        <Descriptions.Item label="原因代码与大类">
          {detail.reason.code ? (
            <span className="erp-num">
              {detail.reason.code}（{detail.reason.category ?? '未分类'}）
            </span>
          ) : (
            <Muted>尚无记录</Muted>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="报告状态">{text(record.reportStatus)}</Descriptions.Item>
        <Descriptions.Item label="运营中心">{text(record.fulfillmentCenterId)}</Descriptions.Item>
        <Descriptions.Item label="退货件编号">{text(record.licensePlateNumber)}</Descriptions.Item>
        <Descriptions.Item label="店铺">{record.storeName}</Descriptions.Item>
        <Descriptions.Item label="报告导入时间">{timeText(record.importedAt)}</Descriptions.Item>
        <Descriptions.Item label="买家备注" span={2}>
          <BuyerComments id={record.id} view={detail.buyerComments} />
        </Descriptions.Item>
      </Descriptions>
      {detail.siblings.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message={`同一订单还有 ${detail.siblings.length} 条退货记录`}
          description={detail.siblings.map(item => (
            <div key={item.id}>
              <AppLink to={`/app/returns/${encodeURIComponent(item.id)}`}>{`${item.sku || item.asin} × ${item.quantity}`}</AppLink>
              <Muted>（{item.disposition.label}）</Muted>
            </div>
          ))}
        />
      ) : null}
    </div>
  )
}

function RefundTab({ detail }: { detail: ReturnDetailResponse }) {
  const { refund } = detail
  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message="退款金额是订单口径：同一订单有多个商品时，是整个订单的退款，不是这一条退货的退款。" />
      <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered data-testid="return-refund">
        <Descriptions.Item label="退款状态">
          <RefundCell refund={refund} currency={refund.currency} />
        </Descriptions.Item>
        <Descriptions.Item label="第一笔退款入账">{timeText(refund.firstRefundAt)}</Descriptions.Item>
        <Descriptions.Item label="退款后是否收到退货">{detail.receipt.label}</Descriptions.Item>
        <Descriptions.Item label="退货相关费用合计">{refund.feeTotal === null ? <Muted>尚无记录</Muted> : money(refund.feeTotal, refund.currency)}</Descriptions.Item>
      </Descriptions>
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        退款交易
      </Typography.Title>
      <SimpleGrid
        gridId="returns.return-detail-page"
        columns={[
          { title: '入账时间', dataIndex: 'postedAt', width: 170, render: (value: string) => timeText(value) },
          { title: '金额', dataIndex: 'amount', width: 120, align: 'right' as const, render: (value: number, row: (typeof refund.items)[number]) => money(value, row.currency) },
          { title: '交易状态', dataIndex: 'status', render: (value: string | null) => text(value) },
        ]}
        rows={refund.items}
        rowKey={row => `${row.postedAt}|${row.amount}`}
        emptyState={{ kind: 'empty', domain: '退款交易', prerequisite: '这个订单还没有退款交易；财务交易每 4 小时同步一次。' }}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        退货相关费用
      </Typography.Title>
      <SimpleGrid<ReturnFeeLine>
        gridId="returns.return-detail-page-2"
        columns={feeColumns}
        rows={refund.fees}
        rowKey={row => `${row.postedAt}|${row.label}|${row.amount}`}
        emptyState={{ kind: 'empty', domain: '退货费用', prerequisite: '没有找到退货处理费、退款佣金等费用明细。' }}
      />
    </div>
  )
}

function ReimbursementTab({ detail }: { detail: ReturnDetailResponse }) {
  const { reimbursement } = detail
  return (
    <div>
      <Descriptions size="small" column={1} bordered data-testid="return-reimbursement">
        <Descriptions.Item label="赔付状态">
          <ReimbursementCell view={reimbursement} />
        </Descriptions.Item>
        <Descriptions.Item label="关联赔付案件">{reimbursement.caseId ? reimbursement.caseId : <Muted>尚无关联案件</Muted>}</Descriptions.Item>
      </Descriptions>
      {reimbursement.state === 'NOT_REVIEWED' ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message="这条退货还没有核查过是否需要索赔"
          description="赔付中心会按规则识别可索赔的退货（承运人或仓库损坏、退款后未收到退货）并建案件；这里暂不显示这条退货是否已被识别，请到赔付中心的“赔付机会”里查看。"
        />
      ) : null}
    </div>
  )
}

function TimelineTab({ detail }: { detail: ReturnDetailResponse }) {
  if (detail.timeline.length === 0) return <Muted>尚无记录</Muted>
  return (
    <Timeline
      data-testid="return-timeline"
      items={detail.timeline.map(item => ({
        key: `${item.at}|${item.kind}|${item.title}`,
        children: (
          <div>
            <div>{item.title}</div>
            <Muted>
              {timeText(item.at)} · {item.source}
            </Muted>
          </div>
        ),
      }))}
    />
  )
}

export default function ReturnDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<ReturnDetailResponse>({ domain: 'list', path: `/returns/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'returns.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  return (
    <DetailLayout
      title={`退货 ${detail.order.amazonOrderId}`}
      subtitle={`${detail.record.storeName} · ${detail.record.sku || detail.record.asin} × ${detail.record.quantity}`}
      imageUrl={detail.product.imageUrl}
      statuses={statusesOf(detail)}
      metrics={metricsOf(detail)}
      freshness={{ lastSuccessAt: detail.freshness.lastSuccessAt, sources: detail.freshness.sources, qualityIssues: detail.freshness.qualityIssues }}
      tabs={[
        { key: 'overview', label: '概览', children: <Overview detail={detail} /> },
        { key: 'refund', label: '退款与费用', children: <RefundTab detail={detail} /> },
        { key: 'reimbursement', label: '关联赔付', children: <ReimbursementTab detail={detail} /> },
        { key: 'timeline', label: '处理时间线', children: <TimelineTab detail={detail} /> },
      ]}
    />
  )
}
