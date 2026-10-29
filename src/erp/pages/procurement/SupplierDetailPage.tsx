import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Descriptions, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  INSPECTION_RESULT_LABEL,
  SUPPLIER_STATUS_LABEL,
  type SupplierDetail,
  type SupplierInspectionView,
  type SupplierProductView,
  type SupplierTrendPoint,
  type PurchaseOrderRow,
} from '@nova/api-contracts'
import { DataState, DetailLayout, EntityCollaboration, FormAction, RowDetailDrawer, SimpleGrid, stateFromError, useRowDetail } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDate, formatDateTime, formatPercent } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { AttachmentsPanel, count, money, percent, PoStatusTag, ratingTag, SupplierFields, supplierBody } from './procurement-ui'

// 供应商详情（P2a-10，06 章 6.8）：表现指标 → 基本信息、合作商品与报价历史、采购历史、交付趋势、质检记录、附件。
// 报价历史属成本信息，需要字段权限 field.cost；没有权限时该列不显示。指标样本不足时显示“样本不足”，不是 0。

const TABS = [
  ['info', '基本信息'],
  ['products', '合作商品与报价'],
  ['orders', '采购历史'],
  ['trend', '交付趋势'],
  ['inspections', '质检记录'],
  ['attachments', '附件'],
] as const

const productColumns: ColumnsType<SupplierProductView> = [
  { title: 'SKU', dataIndex: 'sku', width: 160 },
  { title: '商品名称', dataIndex: 'title', ellipsis: true, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
  { title: '累计订购', dataIndex: 'orderedQty', width: 100, align: 'right', render: count },
  { title: '最近下单', dataIndex: 'lastOrderedAt', width: 120, render: (value: string) => formatDate(value) },
]

const orderColumns: ColumnsType<PurchaseOrderRow> = [
  { title: '采购单号', dataIndex: 'number', width: 190, render: (value: string, row) => <AppLink to={`/app/purchase-orders/${encodeURIComponent(row.id)}`}>{value}</AppLink> },
  { title: '状态', dataIndex: 'status', width: 110, render: (_value, row) => <PoStatusTag status={row.status} /> },
  { title: '预计到货', dataIndex: 'expectedDate', width: 110, render: (value: string | null) => (value ? formatDate(value) : <Muted>未填写</Muted>) },
  { title: '订购', dataIndex: 'orderedQty', width: 90, align: 'right', render: count },
  { title: '已收', dataIndex: 'receivedQty', width: 90, align: 'right', render: count },
  { title: '金额', key: 'total', width: 140, align: 'right', render: (_value, row) => money(row.totalAmount, row.currency) },
]

const trendColumns: ColumnsType<SupplierTrendPoint> = [
  { title: '完成月份', dataIndex: 'month', width: 110 },
  { title: '全部到货的采购单', dataIndex: 'completed', width: 150, align: 'right', render: count },
  { title: '准时交付率', dataIndex: 'onTimeRate', width: 120, align: 'right', render: percent },
  {
    title: '平均交期',
    dataIndex: 'avgLeadDays',
    width: 110,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>样本不足</Muted> : <span className="erp-num">{value} 天</span>),
  },
]

const inspectionColumns: ColumnsType<SupplierInspectionView> = [
  { title: '采购单', dataIndex: 'poNumber', width: 190 },
  { title: '结果', dataIndex: 'result', width: 100, render: (value: keyof typeof INSPECTION_RESULT_LABEL) => INSPECTION_RESULT_LABEL[value] ?? value },
  { title: '批量', dataIndex: 'lotQty', width: 80, align: 'right', render: count },
  { title: '抽检数', dataIndex: 'sampleQty', width: 90, align: 'right', render: count },
  { title: '不良数', dataIndex: 'defectQty', width: 90, align: 'right', render: count },
  { title: '不良率', dataIndex: 'defectRatio', width: 90, align: 'right', render: (value: number) => formatPercent(value, { digits: 1 }) },
  { title: '时间', dataIndex: 'inspectedAt', width: 170, render: (value: string) => formatDateTime(value) },
]

function Products({ detail }: { detail: SupplierDetail }) {
  const withQuotes = detail.products.some(row => row.quotes !== undefined)
  const drawer = useRowDetail()
  return (
    <>
      <SimpleGrid<SupplierProductView>
        gridId="procurement.supplier-products"
        columns={productColumns}
        rows={detail.products}
        rowKey={row => row.sku}
        onRowOpen={withQuotes ? row => drawer.open(row.sku) : undefined}
        emptyState={{ kind: 'empty', domain: '合作商品', prerequisite: '还没有合作商品（有采购单之后才有）' }}
      />
      <RowDetailDrawer rows={detail.products} rowKey={row => row.sku} openKey={drawer.openKey} onClose={drawer.close} title={row => `报价历史：${row.sku}`} width={640}>
        {row => (
          <SimpleGrid<NonNullable<SupplierProductView['quotes']>[number]>
            gridId="procurement.supplier-quotes"
            rows={row.quotes ?? []}
            rowKey={quote => quote.poNumber}
            emptyState={{ kind: 'empty', domain: '报价历史', prerequisite: '这个商品还没有报价记录' }}
            columns={[
              { title: '采购单', dataIndex: 'poNumber' },
              { title: '下单时间', dataIndex: 'orderedAt', render: (value: string) => formatDate(value) },
              { title: '单价（报价）', key: 'unitCost', align: 'right', render: (_value, quote) => money(quote.unitCost, quote.currency) },
            ]}
          />
        )}
      </RowDetailDrawer>
    </>
  )
}

export default function SupplierDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [tab, setTab] = useState<string>('info')
  const path = `/suppliers/${encodeURIComponent(id)}`
  const query = useApiQuery<SupplierDetail>({ domain: 'list', path, scoped: false })
  const update = useApiMutation<Record<string, unknown>, unknown>({ method: 'PATCH', path, invalidate: ['list', 'reference'], silent: true })
  const deactivate = useApiMutation<void, unknown>({ method: 'DELETE', path, invalidate: ['list', 'reference'], silent: true })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'supplier.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { supplier } = detail
  const active = supplier.status === 'ACTIVE'
  const metrics: IdentityMetric[] = [
    { label: '评级', value: ratingTag(supplier.rating) },
    { label: '准时交付率', value: percent(supplier.onTimeRate) },
    { label: '质检合格率', value: percent(supplier.qualityPassRate) },
    { label: '平均交期', value: supplier.avgLeadDays === null ? <Muted>样本不足</Muted> : <span className="erp-num">{supplier.avgLeadDays} 天</span> },
    { label: '采购单数', value: count(supplier.poCount) },
    { label: '合作 SKU', value: count(supplier.skuCount) },
  ]
  const body: Record<string, JSX.Element> = {
    info: (
      <>
        <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
          <Descriptions.Item label="编码">{supplier.code}</Descriptions.Item>
          <Descriptions.Item label="状态">{SUPPLIER_STATUS_LABEL[supplier.status as keyof typeof SUPPLIER_STATUS_LABEL] ?? supplier.status}</Descriptions.Item>
          <Descriptions.Item label="联系人">{supplier.contactName ?? <Muted>未填写</Muted>}</Descriptions.Item>
          <Descriptions.Item label="电话">{supplier.phone ?? <Muted>未填写</Muted>}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{supplier.email ?? <Muted>未填写</Muted>}</Descriptions.Item>
          <Descriptions.Item label="币种">{supplier.currency}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{formatDateTime(supplier.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="指标更新">{supplier.metricsAt ? formatDateTime(supplier.metricsAt) : <Muted>还没有已完成的采购单</Muted>}</Descriptions.Item>
          <Descriptions.Item label="备注" span={2}>
            {supplier.notes ?? <Muted>无</Muted>}
          </Descriptions.Item>
        </Descriptions>
        <Typography.Title level={5} style={{ marginTop: 16 }}>
          指标口径
        </Typography.Title>
        {Object.values(detail.basis).map(line => (
          <Typography.Paragraph key={line} type="secondary" style={{ marginBottom: 4 }}>
            {line}
          </Typography.Paragraph>
        ))}
      </>
    ),
    products: <Products detail={detail} />,
    orders: detail.purchaseOrders.length ? (
      <SimpleGrid<PurchaseOrderRow>
        gridId="procurement.supplier-detail-page"
        columns={orderColumns}
        rows={detail.purchaseOrders}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    ) : (
      <Muted>还没有采购单</Muted>
    ),
    trend: detail.trend.length ? (
      <SimpleGrid<SupplierTrendPoint>
        gridId="procurement.supplier-detail-page-2"
        columns={trendColumns}
        rows={detail.trend}
        rowKey={row => row.month}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    ) : (
      <Muted>还没有全部到货的采购单，暂无趋势</Muted>
    ),
    inspections: detail.inspections.length ? (
      <SimpleGrid<SupplierInspectionView>
        gridId="procurement.supplier-detail-page-3"
        columns={inspectionColumns}
        rows={detail.inspections}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    ) : (
      <Muted>还没有质检记录</Muted>
    ),
    attachments: <AttachmentsPanel base={path} items={detail.attachments} writePermission="supplier.write" onChanged={() => void query.refetch()} />,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AppLink to="/app/suppliers">返回供应商</AppLink>
      <DetailLayout
        title={supplier.name}
        subtitle={`${supplier.code} · ${supplier.currency}`}
        statuses={[{ text: SUPPLIER_STATUS_LABEL[supplier.status as keyof typeof SUPPLIER_STATUS_LABEL] ?? supplier.status, color: active ? 'success' : 'default' }]}
        metrics={metrics}
        primaryActions={
          <>
            <FormAction
              label="编辑"
              guard={{ permission: 'supplier.write' }}
              title="编辑供应商"
              initialValues={{
                name: supplier.name,
                contactName: supplier.contactName ?? '',
                phone: supplier.phone ?? '',
                email: supplier.email ?? '',
                currency: supplier.currency,
                notes: supplier.notes ?? '',
              }}
              okText="保存"
              successText="已保存"
              onSubmit={values => update.mutateAsync({ ...supplierBody(values), version: supplier.version })}
            >
              <SupplierFields withCode={false} />
            </FormAction>
            {active ? (
              <FormAction
                label="停用"
                danger
                guard={{ permission: 'supplier.write' }}
                title="停用供应商"
                description="停用后不能再用它新建采购单；历史采购单、质检与附件都保留。"
                okText="停用"
                successText="已停用"
                onSubmit={() => deactivate.mutateAsync()}
              />
            ) : (
              <FormAction
                label="恢复合作"
                guard={{ permission: 'supplier.write' }}
                title="恢复合作"
                okText="恢复"
                successText="已恢复合作"
                onSubmit={() => update.mutateAsync({ version: supplier.version, status: 'ACTIVE' })}
              />
            )}
          </>
        }
        tabs={TABS.map(([key, label]) => ({ key, label, children: body[key] }))}
        activeTab={tab}
        onTabChange={setTab}
        rail={[{ key: 'collab', title: '评论与关注', children: <EntityCollaboration entityType="SUPPLIER" entityId={supplier.id} /> }]}
      />
    </div>
  )
}
