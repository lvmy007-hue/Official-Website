import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Input, Progress, Select, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PAYMENT_STATUS_LABEL, PO_STATUSES, PO_STATUS_LABEL, type PurchaseOrderListResponse, type PurchaseOrderRow, type SupplierListResponse } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { ActionGuard, PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { formatDate } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { PoDrawer } from './PoDrawer'
import { money, PoStatusTag } from './procurement-ui'

// 采购订单列表（P2a-10，06 章 6.7）：筛选、收货进度、交期偏差提醒。
// 采购不挂店铺，列表不受全局店铺范围影响。金额列只有拥有字段权限 field.cost 的人才有，没有权限时整列不显示。
// 交期偏差：采购单预计到货日晚于它所来自的补货建议需要的日期，只是提醒，不阻断任何操作。

const PAY_COLOR: Record<string, string> = { UNPAID: 'default', PARTIAL: 'warning', PAID: 'success' }

const columns = (showAmount: boolean): ColumnsType<PurchaseOrderRow> => [
  { title: '采购单号', dataIndex: 'number', width: 190, render: (value: string, row) => <AppLink to={`/app/purchase-orders/${encodeURIComponent(row.id)}`}>{value}</AppLink> },
  { title: '供应商', dataIndex: 'supplierName', width: 160, ellipsis: true },
  { title: '状态', dataIndex: 'status', width: 110, render: (_value, row) => <PoStatusTag status={row.status} /> },
  {
    title: '付款',
    dataIndex: 'paymentStatus',
    width: 100,
    render: (value: string) => (
      <Tag color={PAY_COLOR[value]} bordered={false}>
        {PAYMENT_STATUS_LABEL[value] ?? value}
      </Tag>
    ),
  },
  { title: '预计到货', dataIndex: 'expectedDate', width: 110, render: (value: string | null) => (value ? formatDate(value) : <Muted>未填写</Muted>) },
  {
    title: '收货进度',
    key: 'receive',
    width: 180,
    render: (_value, row) =>
      row.receiveRatio === null ? (
        <Muted>尚无记录</Muted>
      ) : (
        <Tooltip title={`已收 ${row.receivedQty} / 订购 ${row.orderedQty}`}>
          <Progress percent={Math.round(row.receiveRatio * 100)} size="small" status={row.status === 'CANCELLED' ? 'exception' : undefined} />
        </Tooltip>
      ),
  },
  {
    title: '交期提醒',
    key: 'deviation',
    width: 150,
    render: (_value, row) =>
      row.deviation ? (
        <Tooltip title={`${row.deviation.sku}${row.deviation.batchNo ? `（批次 ${row.deviation.batchNo}）` : ''} 需要在 ${row.deviation.needByDate} 前到货，预计到货 ${row.deviation.expectedDate}`}>
          <Tag color="warning" bordered={false}>
            晚于需求 {row.deviation.lateDays} 天
          </Tag>
        </Tooltip>
      ) : null,
  },
  ...(showAmount
    ? ([
        { title: '订单金额', key: 'total', width: 140, align: 'right', render: (_value, row) => money(row.totalAmount, row.currency) },
        { title: '已付金额', key: 'paid', width: 140, align: 'right', render: (_value, row) => money(row.paidAmount, row.currency) },
      ] satisfies ColumnsType<PurchaseOrderRow>)
    : []),
]

export default function PurchaseOrdersPage() {
  const { canPermission } = useSession()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [supplierId, setSupplierId] = useState<string | undefined>()
  const [paymentStatus, setPaymentStatus] = useState<string | undefined>()
  const [version, setVersion] = useState(0)
  const [creating, setCreating] = useState(false)
  const fetchPage = useCallback<PageFetcher<PurchaseOrderRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<PurchaseOrderListResponse>(buildPath('/purchase-orders', { q: q || undefined, status, supplierId, paymentStatus, page, pageSize }), { signal })
      return { items: response.items, total: response.total }
    },
    [q, status, supplierId, paymentStatus],
  )
  const suppliers = useApiQuery<SupplierListResponse>({ domain: 'reference', path: '/suppliers', params: { pageSize: 200 }, scoped: false, enabled: canPermission('supplier.read') })
  const showAmount = canPermission('field.cost')
  const tableColumns = useMemo(() => columns(showAmount), [showAmount])
  return (
    <div>
      <PageHeader title="采购订单" description="从草稿到全部到货的采购全流程：审批、付款、分批收货与质检。采购不分店铺，不受全局店铺范围影响。" />
      <Card size="small">
        <Space wrap style={{ marginBottom: 8 }}>
          <ActionGuard label="新建采购单" guard={{ permission: 'purchase.order.write' }} onExecute={async () => setCreating(true)} buttonProps={{ type: 'primary' }} />
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="搜索采购单号、SKU、供应商"
            aria-label="搜索"
            onSearch={value => {
              setQ(value.trim())
            }}
          />
          <Select
            allowClear
            style={{ width: 150 }}
            placeholder="全部状态"
            aria-label="状态筛选"
            value={status}
            options={PO_STATUSES.map(value => ({ value, label: PO_STATUS_LABEL[value] }))}
            onChange={value => {
              setStatus(value)
            }}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 180 }}
            placeholder="全部供应商"
            aria-label="供应商筛选"
            value={supplierId}
            options={(suppliers.data?.items ?? []).map(item => ({ value: item.id, label: item.name }))}
            onChange={value => {
              setSupplierId(value)
            }}
          />
          <Select
            allowClear
            style={{ width: 130 }}
            placeholder="付款状态"
            aria-label="付款状态筛选"
            value={paymentStatus}
            options={Object.entries(PAYMENT_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
            onChange={value => {
              setPaymentStatus(value)
            }}
          />
        </Space>
        {!showAmount ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="你没有成本字段权限（field.cost），订单金额与已付金额不显示。" /> : null}
        <SimplePagedGrid<PurchaseOrderRow>
          gridId="procurement.purchase-orders"
          columns={tableColumns}
          fetchPage={fetchPage}
          rowKey={row => row.id}
          resetKey={JSON.stringify([q, status, supplierId, paymentStatus, version])}
          emptyState={{ kind: 'empty', domain: '采购订单', prerequisite: '还没有采购单。点“新建采购单”，或在补货建议里“生成采购单草稿”。' }}
        />
      </Card>
      <PoDrawer
        open={creating}
        onClose={() => {
          setCreating(false)
          setVersion(current => current + 1)
        }}
      />
    </div>
  )
}
