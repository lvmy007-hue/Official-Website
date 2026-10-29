import { Tag } from 'antd'
import { INVENTORY_ACTION_LABEL, INVENTORY_DETAIL_TABS, INVENTORY_DETAIL_TAB_LABEL, type InventoryDetailResponse, type InventoryDetailTab } from '@nova/api-contracts'
import { EstimateTag, type Suggestion } from '../../components'
import type { IdentityCode, IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { formatDate, formatMoney, formatNumber } from '../../format'
import { AgeFeesTab, ForecastTab } from './detail-tabs-age-forecast'
import { InboundTab, LedgerTab, SnapshotsTab, StructureTab } from './detail-tabs-flow'
import { AuditTab, AwdTab, DispositionTab, ReplenishmentTab } from './detail-tabs-plan'
import { Muted } from './inventory-ui'

// 库存详情的共用部件（P6-05 从详情页拆出）：整页详情与库存健康列表的行详情抽屉用同一套身份区与 10 个页签，
// 页签只在被打开时才取数；AWD 与预计到货时间尚未接入的部分在页签内写明原因与负责的工作包。

const num = (value: number | null | undefined) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>

const TAB_BODY: Record<InventoryDetailTab, (props: { id: string }) => JSX.Element> = {
  structure: StructureTab,
  snapshots: SnapshotsTab,
  ledger: LedgerTab,
  inbound: InboundTab,
  awd: AwdTab,
  replenishment: ReplenishmentTab,
  'age-fees': AgeFeesTab,
  disposition: DispositionTab,
  forecast: ForecastTab,
  audit: AuditTab,
}

/** 10 个详情页签（内容按页签打开时才取数）。 */
export const inventoryDetailTabs = (id: string) =>
  INVENTORY_DETAIL_TABS.map(key => {
    const Body = TAB_BODY[key]
    return { key, label: INVENTORY_DETAIL_TAB_LABEL[key], children: <Body id={id} /> }
  })

/** 编码字段组：SKU、ASIN、FNSKU、店铺。 */
export function inventoryCodes(detail: InventoryDetailResponse): IdentityCode[] {
  const { row } = detail
  return [{ label: 'SKU', value: row.sku }, { label: 'ASIN', value: row.asin }, ...(row.fnsku ? [{ label: 'FNSKU', value: row.fnsku }] : []), { label: '店铺', value: row.storeName }]
}

export function identityMetrics(detail: InventoryDetailResponse): IdentityMetric[] {
  const { row } = detail
  const a = row.assessment
  const cover =
    a.state === 'OK' && a.daysOfCover !== null ? <span className="erp-num">{formatNumber(a.daysOfCover, { digits: 1 })} 天</span> : a.noDemand ? <Muted>近期无销量</Muted> : <Muted>尚无记录</Muted>
  return [
    { label: '可售数量', value: num(row.quantity.sellable) },
    {
      label: '在途合计（计入 / 全部）',
      value: (
        <span className="erp-num">
          {row.quantity.inboundCounted} / {row.quantity.inboundTotal}
        </span>
      ),
    },
    { label: '可售天数', value: cover },
    { label: '预计断货日', value: a.stockoutDate ? formatDate(a.stockoutDate) : <Muted>{a.noDemand ? '近期无销量' : '尚无记录'}</Muted> },
    {
      label: '下月仓储费',
      value:
        row.fees.nextMonthStorage === null ? (
          <Muted>尚无记录</Muted>
        ) : (
          <>
            {formatMoney(row.fees.nextMonthStorage, 'USD', { digits: 2 })} <EstimateTag method="亚马逊库存规划报告的下月预估仓储费" />
          </>
        ),
    },
    {
      label: '库龄附加费预估',
      value:
        row.age.surchargeEstimate === null ? (
          <Muted>尚无记录</Muted>
        ) : (
          <>
            {formatMoney(row.age.surchargeEstimate, 'USD', { digits: 2 })} <EstimateTag method="亚马逊库存规划报告的库龄附加费预估" />
          </>
        ),
    },
  ]
}

export function statusTags(detail: InventoryDetailResponse): StatusTag[] {
  const { row } = detail
  const tags: StatusTag[] = []
  if (row.status.amazonHealth) tags.push({ text: `亚马逊库存健康：${row.status.amazonHealth}`, color: 'default' })
  if (row.quantity.strandedQty) tags.push({ text: `滞留 ${row.quantity.strandedQty} 件`, color: 'warning' })
  if (row.age.atRisk) tags.push({ text: '有库龄附加费风险', color: 'warning' })
  if (row.fees.lowFeeAtRisk) tags.push({ text: '有低库存水平费风险', color: 'warning' })
  return tags
}

export function suggestionsOf(detail: InventoryDetailResponse): Suggestion[] {
  return detail.suggestions.map(item => ({
    id: item.id,
    rule: item.rule,
    evidence: item.evidence,
    impact: item.impact,
    risk: item.risk,
    action: item.action ? (
      <Tag color="blue" bordered={false}>
        {INVENTORY_ACTION_LABEL[item.action]}
      </Tag>
    ) : undefined,
  }))
}
