import { Progress, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { INSPECTION_RESULT_LABEL, type PoInspectionView, type PoReceiptView, type PurchaseOrderDetail } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { count } from './procurement-ui'

// 采购单详情的“收货”“质检”两个页签（从 po-tabs 拆出，保持单文件不超过 400 行）。

const text = (value: string | null | undefined, empty = '尚无记录') => value ?? <Muted>{empty}</Muted>
const receiptColumns: ColumnsType<PoReceiptView> = [
  { title: '收货单号', dataIndex: 'receiptNo', width: 200 },
  { title: '收货日期', dataIndex: 'receivedAt', width: 120, render: (value: string) => formatDate(value) },
  { title: '仓库', dataIndex: 'warehouseName', width: 140, render: (value: string | null) => text(value, '未记录') },
  { title: '数量', dataIndex: 'totalQty', width: 90, align: 'right', render: count },
  {
    title: '商品明细',
    key: 'lines',
    width: 260,
    render: (_value, row) => row.lines.map(line => <div key={line.lineId}>{`${line.sellerSku} × ${line.quantity}${line.batchNo ? `（批次 ${line.batchNo}）` : ''}`}</div>),
  },
  { title: '登记人', dataIndex: 'receivedByName', width: 120 },
  { title: '备注', dataIndex: 'note', render: (value: string | null) => text(value, '无') },
]

export function ReceivingTab({ detail }: { detail: PurchaseOrderDetail }) {
  return (
    <>
      {detail.lines.map(line => (
        <div key={line.id} style={{ display: 'flex', gap: 12, alignItems: 'center', maxWidth: 560 }}>
          <Typography.Text style={{ width: 160 }}>{line.sellerSku}</Typography.Text>
          <Progress style={{ flex: 1 }} size="small" percent={line.quantity > 0 ? Math.round((line.receivedQuantity / line.quantity) * 100) : 0} />
          <span className="erp-num">
            {formatNumber(line.receivedQuantity)} / {formatNumber(line.quantity)}
          </span>
        </div>
      ))}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        收货记录
      </Typography.Title>
      {detail.receipts.length ? (
        <SimpleGrid<PoReceiptView>
          gridId="procurement.po-tabs-4"
          columns={receiptColumns}
          rows={detail.receipts}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : (
        <Muted>还没有收货记录</Muted>
      )}
    </>
  )
}

const inspectionColumns: ColumnsType<PoInspectionView> = [
  {
    title: '结果',
    dataIndex: 'result',
    width: 100,
    render: (value: keyof typeof INSPECTION_RESULT_LABEL) => (
      <Tag color={value === 'PASS' ? 'success' : value === 'FAIL' ? 'error' : 'warning'} bordered={false}>
        {INSPECTION_RESULT_LABEL[value] ?? value}
      </Tag>
    ),
  },
  { title: '收货单', dataIndex: 'receiptNo', width: 190, render: (value: string | null) => text(value, '整单') },
  { title: '批量', dataIndex: 'lotQty', width: 80, align: 'right', render: count },
  { title: '抽检数', dataIndex: 'sampleQty', width: 90, align: 'right', render: count },
  { title: '不良数', dataIndex: 'defectQty', width: 90, align: 'right', render: count },
  { title: '不良率', dataIndex: 'defectRatio', width: 90, align: 'right', render: (value: number) => formatPercent(value, { digits: 1 }) },
  { title: '处理方式', dataIndex: 'handling', render: (value: string | null) => text(value, '无') },
  { title: '质检人', dataIndex: 'inspectorName', width: 120 },
  { title: '时间', dataIndex: 'inspectedAt', width: 170, render: (value: string) => formatDateTime(value) },
]

export function InspectionTab({ detail }: { detail: PurchaseOrderDetail }) {
  return detail.inspections.length ? (
    <SimpleGrid<PoInspectionView>
      gridId="procurement.po-tabs-5"
      columns={inspectionColumns}
      rows={detail.inspections}
      rowKey={row => row.id}
      emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
    />
  ) : (
    <Muted>还没有质检记录</Muted>
  )
}
