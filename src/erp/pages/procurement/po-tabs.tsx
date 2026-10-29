import { Alert, Descriptions, Form, Input, Tag, Timeline, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { APPROVAL_STATUS_LABEL, PAYMENT_KIND_LABEL, PAYMENT_STATUS_LABEL, type PoApprovalView, type PoLineView, type PoPaymentView, type PurchaseOrderDetail } from '@nova/api-contracts'
import { FormAction, SimpleGrid } from '../../components'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { usePoCall } from './po-actions'
import { AttachmentsPanel, count, money, optional } from './procurement-ui'

// 采购单详情的 9 个页签内容。金额类的值只有拥有字段权限 field.cost 才会出现；没有权限时显示“无权查看”。

const LOG_LABEL: Record<string, string> = {
  PURCHASE_ORDER_CREATED: '创建采购单',
  PURCHASE_ORDER_UPDATED: '修改草稿',
  PURCHASE_ORDER_SUBMITTED: '提交审批',
  PURCHASE_ORDER_APPROVED: '审批通过',
  PURCHASE_ORDER_REJECTED: '驳回',
  PURCHASE_ORDER_PRODUCTION_STARTED: '开始生产',
  PURCHASE_RECEIPT_RECORDED: '登记收货',
  PURCHASE_INSPECTION_RECORDED: '登记质检',
  PURCHASE_PAYMENT_RECORDED: '登记付款',
  PURCHASE_ORDER_CLOSED: '关闭订单',
  PURCHASE_ORDER_CANCELLED: '取消订单',
  PURCHASE_ORDER_RETURNED: '退货给供应商',
  ATTACHMENT_ADDED: '上传附件',
}

const text = (value: string | null | undefined, empty = '尚无记录') => value ?? <Muted>{empty}</Muted>

export function BasicTab({ detail }: { detail: PurchaseOrderDetail }) {
  const { order } = detail
  return (
    <>
      {order.deviation ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`交期偏差：预计到货日 ${order.deviation.expectedDate} 晚于补货需要的 ${order.deviation.needByDate}（晚 ${order.deviation.lateDays} 天）`}
          description={`${order.deviation.sku}${order.deviation.batchNo ? `，来自补货批次 ${order.deviation.batchNo}` : ''}。这只是提醒，不影响操作；可以和供应商协商提前，或调整补货计划。`}
        />
      ) : null}
      <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} bordered>
        <Descriptions.Item label="供应商">
          <AppLink to={`/app/suppliers/${encodeURIComponent(order.supplierId)}`}>{order.supplierName}</AppLink>（{order.supplierCode}）
        </Descriptions.Item>
        <Descriptions.Item label="币种">{order.currency}</Descriptions.Item>
        <Descriptions.Item label="创建人">{order.createdByName}</Descriptions.Item>
        <Descriptions.Item label="审批状态">{APPROVAL_STATUS_LABEL[order.approvalStatus] ?? order.approvalStatus}</Descriptions.Item>
        <Descriptions.Item label="付款状态">{PAYMENT_STATUS_LABEL[order.paymentStatus] ?? order.paymentStatus}</Descriptions.Item>
        <Descriptions.Item label="预计到货日">{order.expectedDate ? formatDate(order.expectedDate) : <Muted>未填写</Muted>}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatDateTime(order.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="提交审批">{order.submittedAt ? formatDateTime(order.submittedAt) : <Muted>尚未提交</Muted>}</Descriptions.Item>
        <Descriptions.Item label="下单（审批通过）">{order.orderedAt ? formatDateTime(order.orderedAt) : <Muted>尚未下单</Muted>}</Descriptions.Item>
        <Descriptions.Item label="全部到货">{order.completedAt ? formatDateTime(order.completedAt) : <Muted>尚未完成</Muted>}</Descriptions.Item>
        <Descriptions.Item label="订单金额">{money(order.totalAmount, order.currency)}</Descriptions.Item>
        <Descriptions.Item label="已付金额">{money(order.paidAmount, order.currency)}</Descriptions.Item>
        <Descriptions.Item label="备注" span={3}>
          {text(order.notes, '无')}
        </Descriptions.Item>
      </Descriptions>
    </>
  )
}

const lineColumns: ColumnsType<PoLineView> = [
  { title: 'SKU', dataIndex: 'sellerSku', width: 160 },
  { title: '商品名称', dataIndex: 'title', ellipsis: true, render: (value: string | null) => text(value, '未填写') },
  { title: '订购数量', dataIndex: 'quantity', width: 100, align: 'right', render: count },
  { title: '已收数量', dataIndex: 'receivedQuantity', width: 100, align: 'right', render: count },
  { title: '单价', key: 'unitCost', width: 120, align: 'right', render: (_value, row) => money(row.unitCost, row.currency) },
  { title: '行金额', key: 'lineAmount', width: 130, align: 'right', render: (_value, row) => money(row.lineAmount, row.currency) },
  {
    title: '成本差异',
    key: 'costDiff',
    width: 220,
    render: (_value, row) => {
      const diff = row.costDiff
      if (!diff) return null
      if (!diff.comparable) return <Tag bordered={false}>当前成本币种为 {diff.currency}，无法比较</Tag>
      return (
        <Tag color={diff.ratio !== null && diff.ratio > 0 ? 'warning' : 'processing'} bordered={false}>
          当前成本 {diff.currentUnitCost} {diff.currency}，{diff.ratio === null ? '差异比例无法计算' : `${diff.ratio > 0 ? '高' : '低'} ${formatPercent(Math.abs(diff.ratio), { digits: 1 })}`}
        </Tag>
      )
    },
  },
]

export function LinesTab({ detail }: { detail: PurchaseOrderDetail }) {
  const diffs = detail.lines.filter(line => line.costDiff?.comparable && line.costDiff.ratio !== null && line.costDiff.ratio !== 0)
  return (
    <>
      {diffs.length ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`有 ${diffs.length} 个商品的采购单价和当前生效的成本版本不一致`}
          description="只是提醒；收货完成后会自动生成新的成本版本草稿，是否生效在商品成本页面确认。"
        />
      ) : null}
      <SimpleGrid<PoLineView>
        gridId="procurement.po-tabs"
        columns={lineColumns}
        rows={detail.lines}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </>
  )
}

const approvalColumns: ColumnsType<PoApprovalView> = [
  { title: '轮次', dataIndex: 'step', width: 70 },
  { title: '提交人', dataIndex: 'submittedByName', width: 140 },
  { title: '提交时间', dataIndex: 'createdAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '结论', dataIndex: 'decision', width: 100, render: (value: string) => APPROVAL_STATUS_LABEL[value === 'PENDING' ? 'PENDING' : value] ?? value },
  { title: '审批人', dataIndex: 'approverName', width: 140, render: (value: string | null) => text(value, '待审批') },
  { title: '意见', dataIndex: 'comment', render: (value: string | null) => text(value, '无') },
  { title: '处理时间', dataIndex: 'decidedAt', width: 170, render: (value: string | null) => (value ? formatDateTime(value) : <Muted>—</Muted>) },
]

export function ApprovalTab({ detail }: { detail: PurchaseOrderDetail }) {
  const waiting = detail.order.status === 'PENDING_APPROVAL'
  return (
    <>
      {waiting && !detail.canApprove ? (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="等待有审批权限的其他成员处理" description="创建或提交这张采购单的人不能审批它；没有审批权限的成员也不能。" />
      ) : null}
      {detail.approvals.length ? (
        <SimpleGrid<PoApprovalView>
          gridId="procurement.po-tabs-2"
          columns={approvalColumns}
          rows={detail.approvals}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : (
        <Muted>还没有提交过审批</Muted>
      )}
    </>
  )
}

function MarkPaid({ detail, payment }: { detail: PurchaseOrderDetail; payment: PoPaymentView }) {
  const call = usePoCall(detail.order.id)
  return (
    <FormAction
      label="标记已付"
      guard={{ permission: 'purchase.pay' }}
      title="标记为已付"
      initialValues={{ paidAt: new Date().toISOString().slice(0, 10) }}
      okText="确认已付"
      successText="已标记为已付"
      buttonProps={{ type: 'link', size: 'small' }}
      onSubmit={values =>
        call.mutateAsync({
          suffix: 'payments',
          body: {
            version: detail.order.version,
            paymentId: payment.id,
            kind: payment.kind,
            amount: Number(payment.amount),
            paidAt: values.paidAt,
            ...(optional(values.method) ? { method: optional(values.method) } : {}),
          },
        })
      }
    >
      <Form.Item label="付款日" name="paidAt" rules={[{ required: true, message: '请填写付款日' }]}>
        <Input type="date" aria-label="付款日" style={{ width: 180 }} />
      </Form.Item>
      <Form.Item label="付款方式（选填）" name="method">
        <Input aria-label="付款方式" maxLength={60} />
      </Form.Item>
    </FormAction>
  )
}

export function PaymentTab({ detail }: { detail: PurchaseOrderDetail }) {
  const columns: ColumnsType<PoPaymentView> = [
    { title: '款项', dataIndex: 'kind', width: 90, render: (value: keyof typeof PAYMENT_KIND_LABEL) => PAYMENT_KIND_LABEL[value] ?? value },
    { title: '金额', key: 'amount', width: 140, align: 'right', render: (_value, row) => money(row.amount, row.currency) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) =>
        value === 'PAID' ? (
          <Tag color="success" bordered={false}>
            已付
          </Tag>
        ) : (
          <Tag bordered={false}>计划</Tag>
        ),
    },
    { title: '计划付款日', dataIndex: 'plannedAt', width: 120, render: (value: string | null) => (value ? formatDate(value) : <Muted>未填写</Muted>) },
    { title: '付款日', dataIndex: 'paidAt', width: 120, render: (value: string | null) => (value ? formatDate(value) : <Muted>尚未付款</Muted>) },
    { title: '方式', dataIndex: 'method', width: 110, render: (value: string | null) => text(value, '未填写') },
    { title: '登记人', dataIndex: 'createdByName', width: 120 },
    {
      title: '操作',
      key: 'op',
      width: 110,
      render: (_value, row) => (row.status === 'PLANNED' && row.amount !== undefined && detail.actions.includes('PAY') ? <MarkPaid detail={detail} payment={row} /> : null),
    },
  ]
  return detail.payments.length ? (
    <SimpleGrid<PoPaymentView>
      gridId="procurement.po-tabs-3"
      columns={columns}
      rows={detail.payments}
      rowKey={row => row.id}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  ) : (
    <Muted>还没有付款记录</Muted>
  )
}

export function AttachmentsTab({ detail, onChanged }: { detail: PurchaseOrderDetail; onChanged: () => void }) {
  return <AttachmentsPanel base={`/purchase-orders/${encodeURIComponent(detail.order.id)}`} items={detail.attachments} writePermission="purchase.order.write" onChanged={onChanged} />
}

export function LinksTab({ detail }: { detail: PurchaseOrderDetail }) {
  const { links } = detail
  return (
    <>
      <Typography.Title level={5}>补货批次</Typography.Title>
      {links.batches.length ? (
        links.batches.map(batch => (
          <div key={batch.id}>
            <AppLink to={`/app/replenishment/batches/${encodeURIComponent(batch.id)}`}>{batch.batchNo}</AppLink>
          </div>
        ))
      ) : (
        <Muted>这张采购单不是从补货建议生成的</Muted>
      )}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        头程运单
      </Typography.Title>
      {links.firstMile === 'NO_PERMISSION' ? (
        <Muted>无权查看：头程运单需要权限 firstmile.read</Muted>
      ) : links.firstMile.length ? (
        links.firstMile.map(row => (
          <div key={row.id}>
            <AppLink to={`/app/first-mile/${encodeURIComponent(row.id)}`}>{row.waybillNo}</AppLink>
            <span>
              {' '}
              · {row.forwarderName} · 本单发出 {formatNumber(row.quantity, { digits: 0 })} 件
            </span>
          </div>
        ))
      ) : (
        <Muted>还没有头程运单引用这张采购单</Muted>
      )}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        入仓计划
      </Typography.Title>
      {links.inboundPlans === 'NO_PERMISSION' ? (
        <Muted>无权查看：入仓计划需要权限 inbound.read 与 firstmile.read</Muted>
      ) : links.inboundPlans.length ? (
        links.inboundPlans.map(plan => (
          <div key={plan.id}>
            <AppLink to={`/app/supply-chain/${encodeURIComponent(plan.id)}`}>{plan.name}</AppLink>
            <span>
              {' '}
              · {plan.stageLabel} · 货件 {plan.shipmentIds.join('、')}
            </span>
          </div>
        ))
      ) : (
        <Muted>没有找到入仓计划：这张采购单的头程运单上还没有登记入仓货件</Muted>
      )}
      <Muted>依据：顺着头程运单上登记的入仓货件推算，不是采购单的直接关联。</Muted>
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        成本版本
      </Typography.Title>
      {links.costVersions.length ? (
        <SimpleGrid
          gridId="procurement.po-tabs-6"
          columns={[
            { title: 'SKU', dataIndex: 'sku' },
            { title: '版本', dataIndex: 'versionNo', width: 80, render: (value: number) => `v${value}` },
            { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => (value === 'DRAFT' ? '草稿' : value === 'ACTIVE' ? '生效中' : '已替换') },
            { title: '产品成本', key: 'cost', width: 150, align: 'right', render: (_value, row) => money(row.unitProductCost, row.currency) },
          ]}
          rows={links.costVersions}
          rowKey={row => `${row.sku}-${row.versionNo}`}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : (
        <Muted>全部到货后会自动生成成本版本草稿</Muted>
      )}
    </>
  )
}

export function LogTab({ detail }: { detail: PurchaseOrderDetail }) {
  if (!detail.log.length) return <Muted>尚无记录</Muted>
  return (
    <Timeline
      items={detail.log.map(item => ({
        color: item.result === 'SUCCEEDED' ? 'blue' : 'red',
        children: (
          <>
            <Typography.Text strong>{LOG_LABEL[item.action] ?? item.action}</Typography.Text>{' '}
            <Typography.Text type="secondary">
              {item.actorName} · {formatDateTime(item.at)}
            </Typography.Text>
            {item.result !== 'SUCCEEDED' ? (
              <Tag color="error" bordered={false} style={{ marginLeft: 8 }}>
                {item.result === 'DENIED' ? '被拒绝' : '失败'}
              </Tag>
            ) : null}
            {item.reason ? <div>{item.reason}</div> : null}
          </>
        ),
      }))}
    />
  )
}
