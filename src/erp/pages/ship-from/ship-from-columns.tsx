import type { ICellRendererParams } from 'ag-grid-community'
import { Space, Tag } from 'antd'
import { shipFromSummary, SHIP_FROM_STATUS_LABEL, type ShipFromRow } from '@nova/api-contracts'
import { actionColumn, dateTimeColumn, numberColumn, renderColumn, statusColumn, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { EMPTY_VALUE } from '../../format'
import type { ReactNode } from 'react'

// 发货地址表的列（P6-08，16 章第 4 节）：名称带“默认”标记、店铺、一行地址、电话、状态、被入仓计划使用的次数、更新时间、操作。
// 服务端只允许按名称与更新时间排序。

type Cell = ICellRendererParams<ShipFromRow>

export const SHIP_FROM_SORTABLE = { name: 'name', updatedAt: 'updatedAt' } as const
export const SHIP_FROM_DEFAULT_SORT: SortSpec = { field: 'updatedAt', direction: 'desc' }

const STATUS: Record<string, { label: string; tone: 'success' | 'default' }> = {
  ACTIVE: { label: SHIP_FROM_STATUS_LABEL.ACTIVE, tone: 'success' },
  INACTIVE: { label: SHIP_FROM_STATUS_LABEL.INACTIVE, tone: 'default' },
}

export function shipFromColumns(actions: (row: ShipFromRow) => ReactNode): ErpColDef<ShipFromRow>[] {
  return [
    {
      headerName: '地址名称',
      colId: 'name',
      pin: 'left',
      width: 200,
      valueGetter: ({ data }) => data?.name ?? '',
      cellRenderer: ({ data }: Cell) =>
        data ? (
          <Space size={6}>
            <strong>{data.name}</strong>
            {data.isDefault ? (
              <Tag color="blue" bordered={false} style={{ marginInlineEnd: 0 }}>
                默认
              </Tag>
            ) : null}
          </Space>
        ) : null,
    },
    { headerName: '店铺', colId: 'storeName', width: 150, sortable: false, valueGetter: ({ data }) => data?.storeName ?? '' },
    {
      headerName: '地址',
      colId: 'address',
      width: 380,
      sortable: false,
      valueGetter: ({ data }) => (data ? shipFromSummary(data) : ''),
      tooltipValueGetter: ({ data }) => (data ? shipFromSummary(data) : ''),
    },
    renderColumn<ShipFromRow>('电话', 'phone', row => <span className="erp-num">{row.phone || EMPTY_VALUE}</span>, { width: 140, sortable: false }),
    statusColumn<ShipFromRow>('状态', 'status', STATUS, { width: 110, sortable: false }),
    numberColumn<ShipFromRow>('被入仓计划使用', 'usedByPlans', { width: 140, digits: 0, sortable: false, tooltipValueGetter: () => '被使用过的地址不能删除，只能停用' }),
    dateTimeColumn<ShipFromRow>('更新时间', 'updatedAt', { width: 170 }),
    actionColumn<ShipFromRow>(actions, { width: 320 }),
  ]
}
