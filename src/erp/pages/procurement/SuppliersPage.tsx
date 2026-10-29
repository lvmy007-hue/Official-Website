import { useCallback, useState } from 'react'
import { Card, Input, Select, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SUPPLIER_STATUS_LABEL, SUPPLIER_STATUSES, type SupplierListResponse, type SupplierRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiMutation } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { count, percent, ratingTag, SupplierFields, supplierBody } from './procurement-ui'

// 供应商列表（P2a-10，06 章 6.8）：编码、联系方式、合作量与表现指标。
// 表现指标由系统根据已完成的采购单与质检记录计算；样本不足（已完成采购单少于 3 张）时不评级，显示“样本不足”，不是 0。

const columns: ColumnsType<SupplierRow> = [
  { title: '编码', dataIndex: 'code', width: 110 },
  { title: '名称', dataIndex: 'name', width: 200, render: (value: string, row) => <AppLink to={`/app/suppliers/${encodeURIComponent(row.id)}`}>{value}</AppLink> },
  { title: '联系人', dataIndex: 'contactName', width: 110, render: (value: string | null) => value ?? <Muted>未填写</Muted> },
  { title: '币种', dataIndex: 'currency', width: 70 },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (value: keyof typeof SUPPLIER_STATUS_LABEL) => (
      <Tag bordered={false} color={value === 'ACTIVE' ? 'success' : 'default'}>
        {SUPPLIER_STATUS_LABEL[value] ?? value}
      </Tag>
    ),
  },
  { title: '采购单', dataIndex: 'poCount', width: 80, align: 'right', render: count },
  { title: '合作 SKU', dataIndex: 'skuCount', width: 90, align: 'right', render: count },
  { title: '准时交付率', dataIndex: 'onTimeRate', width: 110, align: 'right', render: percent },
  { title: '质检合格率', dataIndex: 'qualityPassRate', width: 110, align: 'right', render: percent },
  {
    title: '平均交期',
    dataIndex: 'avgLeadDays',
    width: 100,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>样本不足</Muted> : <span className="erp-num">{value} 天</span>),
  },
  {
    title: '评级',
    dataIndex: 'rating',
    width: 90,
    render: (value: SupplierRow['rating'], row) => <Tooltip title={row.metricsAt ? `指标更新于 ${row.metricsAt.slice(0, 10)}` : '还没有已完成的采购单'}>{ratingTag(value)}</Tooltip>,
  },
]

export default function SuppliersPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [version, setVersion] = useState(0)
  const fetchPage = useCallback<PageFetcher<SupplierRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<SupplierListResponse>(buildPath('/suppliers', { q: q || undefined, status, page, pageSize }), { signal })
      return { items: response.items, total: response.total }
    },
    [q, status],
  )
  const create = useApiMutation<Record<string, unknown>, SupplierRow>({ method: 'POST', path: '/suppliers', invalidate: ['list', 'reference'], silent: true })

  return (
    <div>
      <PageHeader title="供应商" description="供应商资料与表现。准时交付率、质检合格率、平均交期与评级由系统根据已完成的采购单与质检记录计算，样本不足时不评级。" />
      <Card size="small">
        <Space wrap style={{ marginBottom: 8 }}>
          <FormAction
            label="新增供应商"
            guard={{ permission: 'supplier.write' }}
            title="新增供应商"
            initialValues={{ currency: 'CNY' }}
            okText="创建"
            successText="供应商已创建"
            buttonProps={{ type: 'primary' }}
            onSubmit={async values => {
              await create.mutateAsync(supplierBody(values))
              setVersion(current => current + 1)
            }}
          >
            <SupplierFields withCode />
          </FormAction>
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="搜索名称、编码、联系人"
            aria-label="搜索"
            onSearch={value => {
              setQ(value.trim())
            }}
          />
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="全部状态"
            aria-label="状态筛选"
            value={status}
            options={SUPPLIER_STATUSES.map(value => ({ value, label: SUPPLIER_STATUS_LABEL[value] }))}
            onChange={value => {
              setStatus(value)
            }}
          />
        </Space>
        <SimplePagedGrid<SupplierRow>
          gridId="procurement.suppliers"
          columns={columns}
          fetchPage={fetchPage}
          rowKey={row => row.id}
          resetKey={JSON.stringify([q, status, version])}
          emptyState={{ kind: 'empty', domain: '供应商', prerequisite: '还没有供应商。点“新增供应商”建立第一个；采购单必须选择供应商。' }}
        />
      </Card>
    </div>
  )
}
