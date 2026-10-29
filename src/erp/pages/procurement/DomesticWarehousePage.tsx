import { useCallback, useState } from 'react'
import { Button, Card, Drawer, Form, Input, InputNumber, Select, Space, Switch, Tabs, Tag, Tooltip, Typography } from 'antd'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import {
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABEL,
  WAREHOUSE_TABS,
  WAREHOUSE_TAB_LABEL,
  type StockCountListResponse,
  type StockCountRow,
  type WarehouseMovementResponse,
  type WarehouseMovementRow,
  type WarehouseStockResponse,
  type WarehouseStockRow,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, SimplePagedGrid, type PageFetcher } from '../../components'
import { formatDate, formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { count, money } from './procurement-ui'

// 国内仓库存（P2a-10，06 章 6.9）：库存、流水、盘点三个页签。
// 库存由流水汇总：在库 = 流水数量合计；锁定 = 已分配给发货或头程的数量；可用 = 在库 − 锁定。
// 待出库 = 已选这个仓、尚未出库的头程运单（P2a-11）里该 SKU 的数量；货值需要字段权限 field.cost，没有时整列不显示。
// 盘点：录入盘点数 → 提交审批 → 另一位有权限的成员通过后才按差异调整库存；录入的人不能审批自己的盘点。

const today = () => new Date().toISOString().slice(0, 10)
function StockPane() {
  const [q, setQ] = useState('')
  const [warehouseId, setWarehouseId] = useState<string | undefined>()
  // 仓库下拉、合计与货值列是否出现取自列表响应（只取一行）；库存行由表格按页码另取。
  const list = useApiQuery<WarehouseStockResponse>({
    domain: 'list',
    path: '/domestic-warehouse/stock',
    params: { q: q || undefined, warehouseId, page: 1, pageSize: 1 },
    scoped: false,
  })
  const fetchPage = useCallback<PageFetcher<WarehouseStockRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<WarehouseStockResponse>(buildPath('/domestic-warehouse/stock', { q: q || undefined, warehouseId, page, pageSize }), { signal })
      return { items: response.items, total: response.total }
    },
    [q, warehouseId],
  )
  const showValue = list.data?.items.some(row => row.value !== undefined) ?? false
  const columns: ColumnsType<WarehouseStockRow> = [
    { title: '仓库', dataIndex: 'warehouseName', width: 150 },
    { title: 'SKU', dataIndex: 'sku', width: 170 },
    { title: '在库', dataIndex: 'onHand', width: 90, align: 'right', render: count },
    { title: '锁定', dataIndex: 'locked', width: 90, align: 'right', render: count },
    { title: '可用', dataIndex: 'available', width: 90, align: 'right', render: count },
    {
      title: '待出库',
      dataIndex: 'pendingOutbound',
      width: 100,
      align: 'right',
      render: count,
    },
    { title: '库龄', dataIndex: 'ageDays', width: 90, align: 'right', render: (value: number | null) => (value === null ? <Muted>无库存</Muted> : <span className="erp-num">{value} 天</span>) },
    ...(showValue
      ? ([
          {
            title: '货值',
            key: 'value',
            width: 180,
            align: 'right',
            render: (_value, row) =>
              row.value === null || row.value === undefined ? (
                <Tooltip title={row.valueNote ?? undefined}>
                  <span>
                    <Muted>{row.valueNote ? '暂不计算' : '尚无记录'}</Muted>
                  </span>
                </Tooltip>
              ) : (
                money(row.value, row.valueCurrency ?? 'CNY')
              ),
          },
        ] satisfies ColumnsType<WarehouseStockRow>)
      : []),
  ]
  const totals = list.data?.totals
  return (
    <>
      <Space wrap style={{ marginBottom: 8 }}>
        <Input.Search
          allowClear
          style={{ width: 240 }}
          placeholder="搜索 SKU"
          aria-label="搜索 SKU"
          onSearch={value => {
            setQ(value.trim())
          }}
        />
        <Select
          allowClear
          style={{ width: 200 }}
          placeholder="全部仓库"
          aria-label="仓库筛选"
          value={warehouseId}
          options={(list.data?.warehouses ?? []).map(row => ({ value: row.id, label: `${row.name}（${row.costMethodLabel}）` }))}
          onChange={value => {
            setWarehouseId(value)
          }}
        />
      </Space>
      {totals && list.data && list.data.total > 0 ? (
        <Space wrap size={24} style={{ marginBottom: 8 }} data-testid="warehouse-totals">
          <span>在库合计 {count(totals.onHand)}</span>
          <span>锁定合计 {count(totals.locked)}</span>
          <span>可用合计 {count(totals.available)}</span>
        </Space>
      ) : null}
      <SimplePagedGrid<WarehouseStockRow>
        gridId="warehouse-stock"
        columns={columns}
        fetchPage={fetchPage}
        rowKey={row => `${row.warehouseId}|${row.sku}`}
        resetKey={JSON.stringify([q, warehouseId, showValue])}
        emptyState={{ kind: 'empty', domain: '国内仓库存', prerequisite: '采购单登记收货后，国内仓才有库存；在库为 0 的 SKU 不列出。' }}
      />
    </>
  )
}

const movementColumns = (showCost: boolean): ColumnsType<WarehouseMovementRow> => [
  { title: '时间', dataIndex: 'occurredAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '仓库', dataIndex: 'warehouseName', width: 130 },
  { title: 'SKU', dataIndex: 'sku', width: 150 },
  { title: '类型', dataIndex: 'typeLabel', width: 100 },
  {
    title: '数量',
    dataIndex: 'quantity',
    width: 90,
    align: 'right',
    render: (value: number) => (
      <span className="erp-num" style={{ color: value < 0 ? 'var(--ant-color-error)' : undefined }}>
        {value > 0 ? `+${value}` : value}
      </span>
    ),
  },
  {
    title: '关联单据',
    key: 'ref',
    width: 190,
    render: (_value, row) =>
      row.referenceType === 'PURCHASE_ORDER' && row.referenceId && row.referenceNo ? (
        <AppLink to={`/app/purchase-orders/${encodeURIComponent(row.referenceId)}`}>{row.referenceNo}</AppLink>
      ) : row.referenceType === 'FIRST_MILE' && row.referenceId && row.referenceNo ? (
        <AppLink to={`/app/first-mile/${encodeURIComponent(row.referenceId)}`}>{row.referenceNo}</AppLink>
      ) : row.referenceType === 'STOCK_COUNT' ? (
        '盘点单'
      ) : (
        <Muted>—</Muted>
      ),
  },
  { title: '操作人', dataIndex: 'operatorName', width: 120 },
  ...(showCost
    ? ([
        { title: '入库单价', key: 'unitCost', width: 130, align: 'right', render: (_value, row) => (row.unitCost ? money(row.unitCost, row.currency ?? 'CNY') : <Muted>—</Muted>) },
      ] satisfies ColumnsType<WarehouseMovementRow>)
    : []),
  { title: '备注', dataIndex: 'notes', render: (value: string | null) => value ?? <Muted>—</Muted> },
]

function MovementsPane() {
  const [q, setQ] = useState('')
  const [type, setType] = useState<string | undefined>()
  // 入库单价列是否出现取自列表响应（只取一行）；流水行由表格按页码另取。
  const list = useApiQuery<WarehouseMovementResponse>({
    domain: 'list',
    path: '/domestic-warehouse/movements',
    params: { q: q || undefined, type, page: 1, pageSize: 1 },
    scoped: false,
  })
  const fetchPage = useCallback<PageFetcher<WarehouseMovementRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<WarehouseMovementResponse>(buildPath('/domestic-warehouse/movements', { q: q || undefined, type, page, pageSize }), { signal })
      return { items: response.items, total: response.total }
    },
    [q, type],
  )
  const showCost = list.data?.items.some(row => row.unitCost !== undefined) ?? false
  return (
    <>
      <Space wrap style={{ marginBottom: 8 }}>
        <Input.Search
          allowClear
          style={{ width: 240 }}
          placeholder="搜索 SKU"
          aria-label="搜索流水 SKU"
          onSearch={value => {
            setQ(value.trim())
          }}
        />
        <Select
          allowClear
          style={{ width: 160 }}
          placeholder="全部类型"
          aria-label="流水类型筛选"
          value={type}
          options={MOVEMENT_TYPES.map(value => ({ value, label: MOVEMENT_TYPE_LABEL[value] }))}
          onChange={value => {
            setType(value)
          }}
        />
      </Space>
      <SimplePagedGrid<WarehouseMovementRow>
        gridId="warehouse-movements"
        columns={movementColumns(showCost)}
        fetchPage={fetchPage}
        rowKey={row => row.id}
        resetKey={JSON.stringify([q, type, showCost])}
        emptyState={{ kind: 'empty', domain: '国内仓流水', prerequisite: '采购收货、退供应商、盘点调整都会在这里留下流水。' }}
      />
    </>
  )
}

function CountForm({ warehouses }: { warehouses: WarehouseStockResponse['warehouses'] }) {
  return (
    <>
      <Form.Item label="仓库" name="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
        <Select aria-label="仓库" options={warehouses.map(row => ({ value: row.id, label: row.name }))} style={{ width: 240 }} />
      </Form.Item>
      <Form.Item label="盘点日期" name="countedAt" rules={[{ required: true, message: '请填写盘点日期' }]}>
        <Input type="date" aria-label="盘点日期" style={{ width: 180 }} />
      </Form.Item>
      <Form.List name="lines">
        {(fields, { add, remove }) => (
          <>
            {fields.map(field => (
              <Space key={field.key} align="start" style={{ display: 'flex' }}>
                <Form.Item name={[field.name, 'sellerSku']} rules={[{ required: true, whitespace: true, message: '请填写 SKU' }]}>
                  <Input aria-label="SKU" placeholder="SKU" style={{ width: 200 }} />
                </Form.Item>
                <Form.Item name={[field.name, 'countedQty']} rules={[{ required: true, message: '请填写盘点数' }]}>
                  <InputNumber aria-label="盘点数" placeholder="盘点数" min={0} precision={0} style={{ width: 120 }} />
                </Form.Item>
                {fields.length > 1 ? <MinusCircleOutlined aria-label="删除这一行" onClick={() => remove(field.name)} style={{ marginTop: 8 }} /> : null}
              </Space>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({})}>
              添加一行
            </Button>
          </>
        )}
      </Form.List>
      <Form.Item label="提交审批" name="submit" valuePropName="checked" extra="关闭则只保存为“盘点中”，可以改天继续录；提交后要另一位有权限的成员通过才会调整库存。" style={{ marginTop: 12 }}>
        <Switch aria-label="提交审批" />
      </Form.Item>
    </>
  )
}

function CountsPane({ warehouses }: { warehouses: WarehouseStockResponse['warehouses'] }) {
  const [version, setVersion] = useState(0)
  const [opened, setOpened] = useState<StockCountRow | null>(null)
  const fetchPage = useCallback<PageFetcher<StockCountRow>>(async ({ page, pageSize, signal }) => {
    const response = await apiFetch<StockCountListResponse>(buildPath('/stock-counts', { page, pageSize }), { signal })
    return { items: response.items, total: response.total }
  }, [])
  const save = useApiMutation<Record<string, unknown>, unknown>({ method: 'POST', path: '/stock-counts', invalidate: ['list'], silent: true, onSuccess: () => setVersion(current => current + 1) })
  const approve = useApiMutation<{ id: string; body: Record<string, unknown> }, unknown>({
    method: 'POST',
    path: call => `/stock-counts/${encodeURIComponent(call.id)}/approve`,
    body: call => call.body,
    invalidate: ['list'],
    silent: true,
    onSuccess: () => {
      setVersion(current => current + 1)
      setOpened(null)
    },
  })
  const columns: ColumnsType<StockCountRow> = [
    { title: '盘点日期', dataIndex: 'countedAt', width: 110, render: (value: string) => formatDate(value) },
    { title: '仓库', dataIndex: 'warehouseName', width: 130 },
    {
      title: '状态',
      dataIndex: 'statusLabel',
      width: 90,
      render: (value: string, row) => (
        <Tag bordered={false} color={row.status === 'POSTED' ? 'success' : row.status === 'PENDING_APPROVAL' ? 'warning' : 'default'}>
          {value}
        </Tag>
      ),
    },
    { title: 'SKU 数', key: 'lines', width: 80, align: 'right', render: (_value, row) => count(row.lines.length) },
    { title: '差异合计', dataIndex: 'diffTotal', width: 100, align: 'right', render: (value: number) => <span className="erp-num">{value > 0 ? `+${value}` : value}</span> },
    { title: '录入人', dataIndex: 'createdByName', width: 120 },
    { title: '审批人', dataIndex: 'approvedByName', width: 120, render: (value: string | null) => value ?? <Muted>尚未审批</Muted> },
    { title: '审批意见', dataIndex: 'reviewNote', render: (value: string | null) => value ?? <Muted>—</Muted> },
    {
      title: '操作',
      key: 'op',
      width: 150,
      render: (_value, row) =>
        row.status === 'PENDING_APPROVAL' ? (
          <Space size={0}>
            <FormAction
              label="通过"
              guard={{ permission: 'warehouse.stockcount.approve', condition: { ok: row.canApprove, reason: '录入盘点的人不能审批自己的盘点单' } }}
              title="通过盘点"
              description="通过后按差异在国内仓记“库存调整”流水。"
              okText="通过"
              successText="盘点已过账"
              buttonProps={{ type: 'link', size: 'small' }}
              onSubmit={() => approve.mutateAsync({ id: row.id, body: { decision: 'APPROVED' } })}
            />
            <FormAction
              label="驳回"
              danger
              guard={{ permission: 'warehouse.stockcount.approve', condition: { ok: row.canApprove, reason: '录入盘点的人不能审批自己的盘点单' } }}
              title="驳回盘点"
              reason={{ label: '驳回意见', placeholder: '例如：数量对不上，请复盘' }}
              okText="驳回"
              successText="已驳回，盘点退回“盘点中”"
              buttonProps={{ type: 'link', size: 'small' }}
              onSubmit={values => approve.mutateAsync({ id: row.id, body: { decision: 'REJECTED', comment: values.reason } })}
            />
          </Space>
        ) : null,
    },
  ]
  return (
    <>
      <Space style={{ marginBottom: 8 }}>
        <FormAction
          label="新建盘点"
          guard={{ permission: 'warehouse.stockcount.write', condition: { ok: warehouses.length > 0, reason: '还没有国内仓：采购单第一次登记收货时会自动建立默认国内仓' } }}
          title="新建盘点"
          description="系统数量按保存时的流水合计固定下来；同一仓同一天只有一张盘点单，“盘点中”时可以反复保存。"
          initialValues={{ countedAt: today(), lines: [{}], submit: true, warehouseId: warehouses[0]?.id }}
          okText="保存"
          successText="盘点已保存"
          buttonProps={{ type: 'primary' }}
          onSubmit={values => save.mutateAsync({ warehouseId: values.warehouseId, countedAt: values.countedAt, lines: values.lines, submit: values.submit !== false })}
        >
          <CountForm warehouses={warehouses} />
        </FormAction>
      </Space>
      <SimplePagedGrid<StockCountRow>
        gridId="stock-counts"
        columns={columns}
        fetchPage={fetchPage}
        rowKey={row => row.id}
        resetKey={String(version)}
        onRowOpen={setOpened}
        emptyState={{ kind: 'empty', domain: '盘点', prerequisite: '还没有盘点单。点“新建盘点”录入盘点结果，审批通过后才会调整库存。' }}
      />
      <Drawer open={opened !== null} onClose={() => setOpened(null)} width={560} title={opened ? `盘点明细：${opened.warehouseName} ${formatDate(opened.countedAt)}` : null} destroyOnClose>
        <Space direction="vertical" size={0}>
          {(opened?.lines ?? []).map(line => (
            <Typography.Text key={line.sellerSku}>{`${line.sellerSku}：系统 ${line.systemQty}，实盘 ${line.countedQty}，差异 ${line.diff > 0 ? '+' : ''}${line.diff}`}</Typography.Text>
          ))}
        </Space>
      </Drawer>
    </>
  )
}

export default function DomesticWarehousePage() {
  const [tab, setTab] = useState<(typeof WAREHOUSE_TABS)[number]>('stock')
  const meta = useApiQuery<WarehouseStockResponse>({ domain: 'reference', path: '/domestic-warehouse/stock', params: { pageSize: 1 }, scoped: false })
  const warehouses = meta.data?.warehouses ?? []
  return (
    <div>
      <PageHeader title="国内仓库存" description="采购收货入库后的国内仓库存、流水与盘点。在库、锁定、可用由流水汇总；货值按仓库的计价方法（移动加权平均或先进先出）计算。" />
      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as typeof tab)}
          items={WAREHOUSE_TABS.map(key => ({
            key,
            label: WAREHOUSE_TAB_LABEL[key],
            children: key === 'stock' ? <StockPane /> : key === 'movements' ? <MovementsPane /> : <CountsPane warehouses={warehouses} />,
          }))}
        />
      </Card>
    </div>
  )
}
