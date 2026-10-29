import type { ColumnsType } from 'antd/es/table'
import { Tag, Typography } from 'antd'
import type { AplusRow } from '@nova/api-contracts'
import { formatDateTime, formatNumber } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { pendingRunText } from './aplus-format'
import { StatusTag } from './aplus-ui'

// 列表页的列（P4-14）：没有数据写“尚无记录”或“无”，不显示成 0。

export const detailTo = (id: string) => `/app/aplus/${encodeURIComponent(id)}`

export const aplusColumns: ColumnsType<AplusRow> = [
  {
    title: '名称',
    key: 'name',
    width: 260,
    render: (_v, row) => (
      <div>
        <div>{row.name}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {row.storeName}
        </Typography.Text>
      </div>
    ),
  },
  { title: '类型', key: 'type', width: 120, render: (_v, row) => row.contentTypeLabel },
  {
    title: '状态',
    key: 'status',
    width: 220,
    render: (_v, row) => (
      <div>
        <StatusTag status={row.status} label={row.statusLabel} />
        {row.status === 'REJECTED' ? <div style={{ fontSize: 12, color: '#cf1322', marginTop: 2 }}>被拒原因：{row.rejectionReason ?? '亚马逊没有返回拒绝原因'}</div> : null}
      </div>
    ),
  },
  {
    title: '关联 ASIN 数',
    key: 'asinCount',
    width: 120,
    align: 'right',
    render: (_v, row) => (row.asinCount > 0 ? <span className="erp-num">{formatNumber(row.asinCount, { digits: 0 })}</span> : <Muted>未关联</Muted>),
  },
  { title: '最近更新', key: 'updatedAt', width: 170, render: (_v, row) => formatDateTime(row.updatedAt) },
  {
    title: '进行中写入',
    key: 'pending',
    width: 150,
    render: (_v, row) => (row.pendingRun ? <Tag color="processing">{pendingRunText(row.pendingRun)}</Tag> : <Muted>无</Muted>),
  },
  {
    title: '操作',
    key: 'op',
    width: 80,
    render: (_v, row) => <AppLink to={detailTo(row.id)}>查看</AppLink>,
  },
]
