import { Space, Tag } from 'antd'
import type { ReactNode } from 'react'
import type { CarrierRow } from '@nova/api-contracts'
import { actionColumn, numberColumn, renderColumn, statusColumn, type ErpColDef } from '../../components'
import { EMPTY_VALUE } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 物流渠道表的列（P6-26）：物流商一行，展开后是它的渠道；渠道行带材积除数、分抛系数、报价条数与覆盖地区。
// 一张表放两种行，用 kind 区分；物流商行没有的字段留空，不写 0。

export type CarrierGridRow = {
  id: string
  kind: 'CARRIER' | 'CHANNEL'
  carrierId: string
  name: string
  code: string
  status: 'ACTIVE' | 'INACTIVE'
  version: number
  volumetricDivisor: number | null
  splitFactor: number | null
  rateCount: number | null
  regions: string[]
  shipmentCount: number | null
  channelCount: number | null
  childRows: CarrierGridRow[]
}

export function carrierGridRows(items: readonly CarrierRow[]): CarrierGridRow[] {
  return items.map(carrier => ({
    id: carrier.id,
    kind: 'CARRIER',
    carrierId: carrier.id,
    name: carrier.name,
    code: carrier.code,
    status: carrier.status,
    version: carrier.version,
    volumetricDivisor: null,
    splitFactor: null,
    rateCount: null,
    regions: [],
    shipmentCount: null,
    channelCount: carrier.channelCount,
    childRows: carrier.channels.map(channel => ({
      id: channel.id,
      kind: 'CHANNEL',
      carrierId: carrier.id,
      name: channel.name,
      code: channel.code,
      status: channel.status,
      version: channel.version,
      volumetricDivisor: channel.volumetricDivisor,
      splitFactor: channel.splitFactor,
      rateCount: channel.rateCount,
      regions: channel.regions,
      shipmentCount: channel.shipmentCount,
      channelCount: null,
      childRows: [],
    })),
  }))
}

const STATUS = { ACTIVE: { label: '使用中', tone: 'success' as const }, INACTIVE: { label: '已停用', tone: 'default' as const } }

export function carrierColumns(actions: (row: CarrierGridRow) => ReactNode): ErpColDef<CarrierGridRow>[] {
  return [
    renderColumn<CarrierGridRow>('物流商 / 渠道', 'name', row => (row.kind === 'CARRIER' ? <strong>{row.name}</strong> : <span>{row.name}</span>), { width: 240, pin: 'left', sortable: false }),
    renderColumn<CarrierGridRow>('代码', 'code', row => <span className="erp-num">{row.code}</span>, { width: 110, sortable: false }),
    renderColumn<CarrierGridRow>('类型', 'kind', row => <Tag bordered={false}>{row.kind === 'CARRIER' ? '物流商' : '渠道'}</Tag>, { width: 90, sortable: false }),
    statusColumn<CarrierGridRow>('状态', 'status', STATUS, { width: 100, sortable: false }),
    numberColumn<CarrierGridRow>('材积除数', 'volumetricDivisor', { width: 100, digits: 0, sortable: false, tooltipValueGetter: () => '体积重 = 体积（立方厘米）÷ 除数；常见 6000 或 5000' }),
    numberColumn<CarrierGridRow>('分抛系数', 'splitFactor', { width: 100, digits: 2, sortable: false, tooltipValueGetter: () => '体积重超过实重的部分只按这个比例计入计费重量；1 表示取两者较大者' }),
    numberColumn<CarrierGridRow>('报价条数', 'rateCount', { width: 100, digits: 0, sortable: false }),
    renderColumn<CarrierGridRow>(
      '覆盖地区',
      'regions',
      row =>
        row.kind === 'CARRIER' ? (
          <span>{EMPTY_VALUE}</span>
        ) : row.regions.length === 0 ? (
          <Muted>尚无报价</Muted>
        ) : (
          <Space size={2} wrap>
            {row.regions.map(region => (
              <Tag key={region} bordered={false}>
                {region}
              </Tag>
            ))}
          </Space>
        ),
      { width: 220, sortable: false },
    ),
    numberColumn<CarrierGridRow>('在用运单', 'shipmentCount', { width: 100, digits: 0, sortable: false, tooltipValueGetter: () => '选用了这个渠道的头程运单数；在用的渠道不能删除' }),
    actionColumn<CarrierGridRow>(actions, { width: 420 }),
  ]
}
