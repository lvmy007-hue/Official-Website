import { Tag, Typography } from 'antd'
import type { HijackRow } from '@nova/api-contracts'
import { renderColumn, RIGHT_ALIGNED, type ErpColDef } from '../../components'
import { formatMoney } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import type { SortSpec } from '../../components/table/cursor-datasource'

// 跟卖监控表的列（P6-17）：商品（SKU、ASIN、标题）、店铺、对方卖家（只有哈希前 6 位，不是卖家编号原文）、首次出现与最近看到、状态、报价、是否 FBA、是否拿到购物车、是否在白名单。
// 数据来自官方竞争摘要，有延迟；时间是“我们读到的时间”，不是对方上架的时间。

export const HIJACK_SORTABLE = { firstSeenAt: 'firstSeenAt', lastSeenAt: 'lastSeenAt', price: 'price' } as const
export const HIJACK_DEFAULT_SORT: SortSpec = { field: 'firstSeenAt', direction: 'desc' }

export const yesNo = (value: boolean) => (value ? '是' : '否')

export const hijackColumns: ErpColDef<HijackRow>[] = [
  renderColumn<HijackRow>(
    '商品',
    'sku',
    row => (
      <div>
        <Typography.Text strong>{row.sku}</Typography.Text>
        <div>
          <Muted>{row.asin || '无 ASIN'}</Muted>
          {row.title ? (
            <div>
              <Muted>{row.title}</Muted>
            </div>
          ) : null}
        </div>
      </div>
    ),
    { group: '商品', pin: 'left', width: 260 },
  ),
  renderColumn<HijackRow>('店铺', 'storeName', row => row.storeName, { group: '商品', width: 130 }),
  renderColumn<HijackRow>('对方卖家', 'sellerRef', row => <span className="erp-num">{row.sellerRef}</span>, { group: '对方', width: 120 }),
  renderColumn<HijackRow>('报价', 'price', row => <span className="erp-num">{formatMoney(row.price, row.currency)}</span>, { group: '对方', width: 110, ...RIGHT_ALIGNED }),
  renderColumn<HijackRow>('FBA', 'isFba', row => yesNo(row.isFba), { group: '对方', width: 70 }),
  renderColumn<HijackRow>(
    '拿到购物车',
    'hasBuybox',
    row =>
      row.hasBuybox ? (
        <Tag color="warning" bordered={false}>
          是
        </Tag>
      ) : (
        '否'
      ),
    { group: '对方', width: 100 },
  ),
  renderColumn<HijackRow>(
    '状态',
    'status',
    row =>
      row.status === 'active' ? (
        <Tag color="error" bordered={false}>
          仍在报价
        </Tag>
      ) : (
        <Tag bordered={false}>已消失</Tag>
      ),
    { group: '时间', width: 100 },
  ),
  renderColumn<HijackRow>('首次出现', 'firstSeenAt', row => timeText(row.firstSeenAt), { group: '时间', width: 170 }),
  renderColumn<HijackRow>('最近看到', 'lastSeenAt', row => timeText(row.lastSeenAt), { group: '时间', width: 170 }),
  renderColumn<HijackRow>('消失时间', 'goneAt', row => (row.goneAt ? timeText(row.goneAt) : <Muted>未消失</Muted>), { group: '时间', width: 170 }),
  renderColumn<HijackRow>('白名单', 'whitelisted', row => (row.whitelisted ? <Tag bordered={false}>白名单</Tag> : <Muted>否</Muted>), { group: '处理', width: 90 }),
]
