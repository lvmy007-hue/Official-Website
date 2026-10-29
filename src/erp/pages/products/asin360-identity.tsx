import type { ReactNode } from 'react'
import { Alert, Collapse, Select, Space, Tag, Typography } from 'antd'
import {
  ASIN360_ACTION_RULE_STATE_LABEL,
  INVENTORY_ACTION_LABEL,
  type Asin360ActionRuleState,
  type Asin360ActionRuleView,
  type Asin360ActionsResponse,
  type Asin360IdentityResponse,
  type Asin360KpiCard,
  type Asin360OverviewResponse,
} from '@nova/api-contracts'
import type { Suggestion } from '../../components'
import type { IdentityMetric, StatusTag } from '../../components/detail/DetailLayout'
import { formatDate, formatMoney, formatNumber, formatPercent } from '../../format'
import { useAppNavigate } from '../../nav/AppLink'
import { LiveLink, Muted, STATE_LABEL } from '../inventory/inventory-ui'

// ASIN 360 身份区的内容：6 项关键指标、状态标签、商品信息行（品牌、类目、父体、排名、SKU 切换）与建议动作。
// 没接入的指标写“尚未接入”，没有记录写“尚无记录”，没权限写“无权查看”，永远不显示 0。

const LISTING_LABEL: Record<string, string> = { ACTIVE: '在售', INACTIVE: '不可售', INCOMPLETE: '信息不全' }
const CHANNEL_LABEL: Record<string, string> = { AFN: '亚马逊物流 FBA', MFN: '自发货 FBM', FBA: '亚马逊物流 FBA', FBM: '自发货 FBM' }

function kpiValue(card: Asin360KpiCard | undefined, currency: string): ReactNode {
  if (!card) return <Muted>读取中</Muted>
  if (card.state !== 'OK' || card.value === null) return <Muted>{STATE_LABEL[card.state] || '尚无记录'}</Muted>
  return card.format === 'money' ? formatMoney(card.value, currency, { digits: 2 }) : formatPercent(card.value, { digits: 1 })
}

/** 6 项关键指标：销售额、净利润、转化率、广告占比（随页面顶部时间范围）与可售数量、可售天数（库存口径）。 */
export function identityMetrics(identity: Asin360IdentityResponse, overview: Asin360OverviewResponse | undefined): IdentityMetric[] {
  const card = (key: Asin360KpiCard['key']) => overview?.cards.find(item => item.key === key)
  const currency = overview?.currency ?? identity.product.currency
  const sales = card('sales')
  const stock = identity.stock
  const stockText = (value: number | null, fallback: string) =>
    stock.state === 'OK' && value !== null ? <span className="erp-num">{formatNumber(value, { digits: Number.isInteger(value) ? 0 : 1 })}</span> : <Muted>{fallback}</Muted>
  const unavailable = stock.state === 'RESTRICTED' ? '无权查看' : '尚无记录'
  return [
    {
      label: '销售额',
      value: kpiValue(sales, currency),
      delta: sales && sales.state === 'OK' && overview?.compare ? { label: '较对比期', ratio: sales.change } : undefined,
    },
    { label: '净利润', value: kpiValue(card('profit'), currency) },
    { label: '转化率', value: kpiValue(card('conversion'), currency) },
    { label: '广告占总销售比', value: kpiValue(card('adsShare'), currency) },
    { label: '可售数量', value: stockText(stock.sellable, unavailable) },
    { label: '可售天数', value: stock.noDemand ? <Muted>近期无销量</Muted> : stockText(stock.daysOfCover, stock.state === 'OK' ? '尚未配置库存规则' : unavailable) },
  ]
}

export function statusTags(identity: Asin360IdentityResponse): StatusTag[] {
  const { product, catalog, stock } = identity
  const tags: StatusTag[] = [
    { text: LISTING_LABEL[product.listingStatus] ?? product.listingStatus, color: product.listingStatus === 'ACTIVE' ? 'success' : 'default' },
    { text: CHANNEL_LABEL[product.fulfillmentChannel] ?? product.fulfillmentChannel, color: 'default' },
  ]
  if (catalog.state === 'NOT_FOUND') tags.push({ text: '目录查无此 ASIN（待核实）', color: 'warning' })
  if (stock.riskLabel) tags.push({ text: `库存风险：${stock.riskLabel}`, color: 'warning' })
  return tags
}

const RULE_COLOR: Record<Asin360ActionRuleState, string> = { TRIGGERED: 'red', CLEAR: 'green', NO_DATA: 'default', RESTRICTED: 'orange', NOT_CONNECTED: 'default' }

/** 建议规则清单（05 章 5.2 的 6 条）：已触发的规则在“建议动作”里执行；没有数据来源的规则写“尚未接入”，不当作“没触发”。 */
export function ActionRules({ rules }: { rules: readonly Asin360ActionRuleView[] }) {
  const live = rules.filter(rule => rule.state !== 'NOT_CONNECTED').length
  const hit = rules.filter(rule => rule.state === 'TRIGGERED').length
  return (
    <Collapse
      size="small"
      data-testid="asin360-action-rules"
      items={[
        {
          key: 'rules',
          label: `建议规则：${rules.length} 条中 ${live} 条已接入，${hit} 条已触发`,
          children: (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {rules.map(rule => (
                <div key={rule.key} data-testid={`asin360-rule-${rule.key}`}>
                  <Tag color={RULE_COLOR[rule.state]} bordered={false}>
                    {ASIN360_ACTION_RULE_STATE_LABEL[rule.state]}
                  </Tag>
                  {rule.trigger} → {rule.advice}
                  {rule.note ? (
                    <Muted>
                      （{rule.note}
                      {rule.workPackage ? `，由 ${rule.workPackage} 交付` : ''}）
                    </Muted>
                  ) : null}
                </div>
              ))}
            </Space>
          ),
        },
      ]}
    />
  )
}

export function IdentityExtra({ identity, rules }: { identity: Asin360IdentityResponse; rules?: readonly Asin360ActionRuleView[] }) {
  const { product, catalog, siblings, variants, ranks } = identity
  const navigate = useAppNavigate()
  return (
    <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 8 }} data-testid="asin360-identity-extra">
      <Space size={16} wrap>
        <span>品牌：{product.brand ?? <Muted>{catalog.state === 'OK' ? '目录未给出' : '尚未同步'}</Muted>}</span>
        <span>类目：{product.categoryPath ?? <Muted>{catalog.state === 'OK' ? '目录未给出' : '尚未同步'}</Muted>}</span>
        <span>负责人：{product.ownerName ?? <Muted>未指定</Muted>}</span>
        {product.productType ? <span>商品类型：{product.productType}</span> : null}
        {product.price !== null ? <span>标价：{formatMoney(product.price, product.currency, { digits: 2 })}</span> : null}
      </Space>
      <Space size={12} wrap>
        {variants.parentAsin ? (
          <span>
            父体 <Typography.Text copyable>{variants.parentAsin}</Typography.Text>
            {variants.siblingCount !== null ? `（同父体另有 ${variants.siblingCount} 个子体${variants.variationTheme ? `，变体维度 ${variants.variationTheme}` : ''}）` : ''}
          </span>
        ) : null}
        {variants.isParent ? <Tag bordered={false}>父体，含 {variants.childCount} 个子体</Tag> : null}
        {siblings.length > 1 ? (
          <span>
            同 ASIN 的 SKU：
            <Select
              size="small"
              style={{ minWidth: 180 }}
              value={product.id}
              aria-label="切换 SKU"
              options={siblings.map(item => ({ value: item.id, label: item.sku }))}
              onChange={value => navigate(`/app/products/${encodeURIComponent(value)}`)}
            />
          </span>
        ) : null}
      </Space>
      <Space size={6} wrap>
        <span>销售排名：</span>
        {ranks.state === 'OK' ? (
          <>
            {ranks.items.map(item => (
              <Tag key={item.classificationId} bordered={false} color="blue">
                {item.name} #{formatNumber(item.rank, { digits: 0 })}
              </Tag>
            ))}
            <Muted>（{formatDate(ranks.snapshotDate)} 目录快照）</Muted>
          </>
        ) : (
          <Muted>{ranks.note ?? '尚无记录'}</Muted>
        )}
      </Space>
      {rules ? <ActionRules rules={rules} /> : null}
      {catalog.state !== 'OK' ? (
        <Alert
          type={catalog.state === 'NOT_FOUND' ? 'warning' : 'info'}
          showIcon
          message={catalog.state === 'NOT_FOUND' ? '商品目录查无此 ASIN' : '商品目录尚未同步'}
          description={catalog.note ?? undefined}
        />
      ) : null}
    </Space>
  )
}

/** 建议动作：本阶段只有库存类规则；执行入口链到库存详情与补货建议（页面已上线才出现）。 */
export function suggestionsOf(actions: Asin360ActionsResponse | undefined): Suggestion[] {
  if (!actions || actions.state !== 'OK' || !actions.inventoryId) return []
  const inventoryId = actions.inventoryId
  return actions.items.map(item => ({
    id: item.id,
    rule: item.rule,
    evidence: item.evidence,
    impact: item.impact,
    risk: item.risk,
    action: item.action ? (
      <Space size={8}>
        <Tag color="blue" bordered={false}>
          {INVENTORY_ACTION_LABEL[item.action]}
        </Tag>
        <LiveLink component="InventoryDetailPage" id={inventoryId}>
          查看库存详情
        </LiveLink>
      </Space>
    ) : undefined,
  }))
}
