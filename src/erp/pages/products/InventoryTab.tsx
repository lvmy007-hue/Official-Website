import { Space, Tabs, Typography } from 'antd'
import { INVENTORY_DETAIL_TAB_LABEL, type Asin360InventoryRef, type InventoryDetailTab } from '@nova/api-contracts'
import { DataState } from '../../components'
import { AgeFeesTab } from '../inventory/detail-tabs-age-forecast'
import { InboundTab, StructureTab } from '../inventory/detail-tabs-flow'
import { AwdTab, ReplenishmentTab } from '../inventory/detail-tabs-plan'
import { LiveLink } from '../inventory/inventory-ui'
import { QueryBody, useProductQuery } from './asin360-hooks'

// 库存补货页签（05 章 5.2）：不另算一套口径，直接复用库存详情（P2a-06 至 P2a-13）的结构趋势、入仓与在途、补货建议、
// 上游仓储（AWD）、库龄与费用；商品只负责对到库存记录。台账、快照、处置与预测在库存详情里看。

type Section = Extract<InventoryDetailTab, 'structure' | 'inbound' | 'replenishment' | 'awd' | 'age-fees'>
const SECTIONS: Array<{ key: Section; Body: (props: { id: string }) => JSX.Element }> = [
  { key: 'structure', Body: StructureTab },
  { key: 'inbound', Body: InboundTab },
  { key: 'replenishment', Body: ReplenishmentTab },
  { key: 'awd', Body: AwdTab },
  { key: 'age-fees', Body: AgeFeesTab },
]

function Body({ data }: { data: Asin360InventoryRef }) {
  const inventoryId = data.inventoryId
  if (data.state !== 'OK' || !inventoryId) {
    return <DataState kind="empty" domain="这个商品的库存与补货" prerequisite={data.note ?? '库存同步后显示（这个商品还没有库存记录）'} />
  }
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        口径与库存详情一致。
        <LiveLink component="InventoryDetailPage" id={inventoryId}>
          查看完整库存详情（含台账、快照、处置与预测）
        </LiveLink>
      </Typography.Text>
      <Tabs size="small" items={SECTIONS.map(({ key, Body: Section }) => ({ key, label: INVENTORY_DETAIL_TAB_LABEL[key], children: <Section id={inventoryId} /> }))} />
    </Space>
  )
}

export function InventoryTab({ id }: { id: string }) {
  const query = useProductQuery<Asin360InventoryRef>(id, 'inventory')
  return <QueryBody query={query}>{data => <Body data={data} />}</QueryBody>
}
