import { Alert, Descriptions } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  type PromotionAdsRow,
  type PromotionDay,
  type PromotionDetailResponse,
  type PromotionFeeLine,
  type PromotionFeePreview,
  type PromotionIssue,
  type PromotionItemRow,
  type PromotionSectionState,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatMoney, formatNumber } from '../../format'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { EstimateTag, SectionNote, countOr, moneyOr } from './promotions-ui'

// 促销详情六个页签的内容（P4-05）：效果、商品、成本、利润、问题、广告。每个页签自己带状态与说明；估算出来的数字标“估算”。

type Detail = PromotionDetailResponse
const pctText = (value: number | null) => (value === null ? <Muted>基线为 0，不计算</Muted> : <span className="erp-num">{formatNumber(value, { digits: 1 })}%</span>)
const inner = (state: 'OK' | 'NO_DATA' | 'RESTRICTED' | 'NOT_APPLICABLE'): PromotionSectionState => (state === 'OK' ? 'NO_DATA' : state === 'NOT_APPLICABLE' ? 'NO_EFFECT' : state)

const dailyColumns: ColumnsType<PromotionDay> = [
  { title: '日期', dataIndex: 'date', width: 120, render: (value: string) => <span className="erp-num">{value}</span> },
  { title: '实际销量', dataIndex: 'actualUnits', width: 100, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '基线销量（估算）', dataIndex: 'baselineUnits', width: 140, align: 'right', render: (value: number | null) => countOr(value, 'INSUFFICIENT', 1) },
  { title: '实际销售额', dataIndex: 'actualSales', width: 120, align: 'right', render: (value: number | null) => moneyOr(value) },
  { title: '基线销售额（估算）', dataIndex: 'baselineSales', width: 150, align: 'right', render: (value: number | null) => moneyOr(value, 'INSUFFICIENT') },
  { title: '报告销量', dataIndex: 'reportedUnits', width: 100, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '报告销售额', dataIndex: 'reportedSales', width: 120, align: 'right', render: (value: number | null) => moneyOr(value) },
]

export function EffectTab({ detail }: { detail: Detail }) {
  const effect = detail.effect
  const { baseline, window, reported } = effect
  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={detail.methodNote} data-testid="method-note" />
      <SectionNote state={effect.state} note={effect.note} />
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="effect-summary">
        <Descriptions.Item label="活动期间">{window ? `${window.from} 至 ${window.to}（${window.days} 天）` : <Muted>尚未开始</Muted>}</Descriptions.Item>
        <Descriptions.Item label="基线（活动前）">
          {baseline.from ? (
            `${baseline.from} 至 ${baseline.to}，有效日 ${baseline.usedDays} 天、排除 ${baseline.excludedDays} 天`
          ) : (
            <Muted>{effect.state === 'NO_EFFECT' ? '不适用' : '尚未计算'}</Muted>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="实际销量">{countOr(effect.actual.units, effect.state)}</Descriptions.Item>
        <Descriptions.Item label="实际销售额">{moneyOr(effect.actual.sales, effect.state)}</Descriptions.Item>
        <Descriptions.Item label="基线期望销量">
          {countOr(effect.expected.units, effect.state, 1)}
          {effect.expected.units === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="基线期望销售额">
          {moneyOr(effect.expected.sales, effect.state)}
          {effect.expected.sales === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="增量销量">
          {countOr(effect.incremental.units, effect.state, 1)}
          {effect.incremental.units === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="增量销售额">
          {moneyOr(effect.incremental.sales, effect.state)}
          {effect.incremental.sales === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="销售额提升幅度" span={2}>
          {effect.incremental.sales === null ? <Muted>数据不足</Muted> : pctText(effect.incremental.liftPct)}
          {effect.incremental.liftPct === null ? null : <EstimateTag />}
        </Descriptions.Item>
      </Descriptions>
      <h4 style={{ margin: '16px 0 8px' }}>亚马逊绩效报告</h4>
      {reported.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={reported.note} /> : null}
      <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered data-testid="effect-reported">
        <Descriptions.Item label="销量">{reported.state === 'OK' && reported.units === null ? <Muted>报告未提供</Muted> : countOr(reported.units)}</Descriptions.Item>
        <Descriptions.Item label="销售额">{reported.state === 'OK' && reported.sales === null ? <Muted>报告未提供</Muted> : moneyOr(reported.sales)}</Descriptions.Item>
        <Descriptions.Item label="使用次数">{reported.state === 'OK' && reported.redemptions === null ? <Muted>报告未提供</Muted> : countOr(reported.redemptions)}</Descriptions.Item>
        {detail.promotion.type === 'COUPON' ? <Descriptions.Item label="领取次数">{countOr(reported.clips)}</Descriptions.Item> : null}
        {detail.promotion.type === 'COUPON' ? <Descriptions.Item label="已用预算">{moneyOr(reported.budgetSpent)}</Descriptions.Item> : null}
      </Descriptions>
      <h4 style={{ margin: '16px 0 8px' }}>逐日对比</h4>
      <SimpleGrid<PromotionDay>
        gridId="promotions.promotion-tabs"
        columns={dailyColumns}
        rows={effect.daily}
        rowKey={row => row.date}
        emptyState={{ kind: 'empty', domain: '逐日数据', prerequisite: effect.note ?? '尚无记录：活动还没有产生可对比的数据' }}
      />
    </div>
  )
}

const itemColumns: ColumnsType<PromotionItemRow> = [
  {
    title: 'ASIN',
    dataIndex: 'asin',
    width: 140,
    render: (value: string, row) =>
      row.productId ? (
        <LiveLink component="Asin360Page" id={row.productId}>
          {value}
        </LiveLink>
      ) : (
        value || <Muted>未提供</Muted>
      ),
  },
  { title: 'SKU', dataIndex: 'sku', width: 140, render: (value: string) => value || <Muted>未提供</Muted> },
  { title: '商品', dataIndex: 'productTitle', width: 280, ellipsis: true, render: (value: string | null) => value ?? <Muted>主数据里没有这个商品，或没有商品读取权限</Muted> },
  { title: '折扣力度', dataIndex: 'benefitText', width: 140, render: (value: string | null) => value ?? <Muted>未提供</Muted> },
  {
    title: '每位买家限用',
    dataIndex: 'perCustomerUses',
    width: 120,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>未设置</Muted> : <span className="erp-num">{value}</span>),
  },
  { title: '商品预算', dataIndex: 'budgetText', width: 110, render: (value: string | null) => value ?? <Muted>未设置</Muted> },
  {
    title: '问题',
    dataIndex: 'issues',
    width: 260,
    render: (value: PromotionIssue[]) =>
      value.length ? value.map(issue => <div key={`${issue.code}-${issue.message}`}>{`${issue.severity === 'ERROR' ? '错误' : '警告'}：${issue.message}`}</div>) : <Muted>无</Muted>,
  },
]

export function ItemsTab({ detail }: { detail: Detail }) {
  const { items } = detail
  return (
    <div>
      <SectionNote state={items.state} note={items.note} />
      <SimpleGrid<PromotionItemRow>
        gridId="promotions.promotion-tabs-2"
        columns={itemColumns}
        rows={items.items}
        rowKey={row => `${row.asin}|${row.sku}`}
        emptyState={{ kind: 'empty', domain: '商品清单', prerequisite: items.note ?? '尚无记录：没有商品清单' }}
      />
    </div>
  )
}

const feeLineColumns: ColumnsType<PromotionFeeLine> = [
  { title: '费用事件', dataIndex: 'label', width: 280 },
  { title: '笔数', dataIndex: 'count', width: 80, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (value: number) => moneyOr(value) },
]

const previewText = (preview: PromotionFeePreview | null) => {
  if (!preview) return <Muted>亚马逊没有给出预览费率</Muted>
  const parts = [
    preview.upfront ? `一次性费用 ${formatMoney(preview.upfront.amount, preview.upfront.currency, { digits: 2 })}（${preview.upfront.frequency}）` : null,
    preview.variablePct !== null ? `按销售额 ${preview.variablePct}%` : null,
    preview.capAmount !== null ? `变动费用上限 ${formatMoney(preview.capAmount, 'USD', { digits: 2 })}` : null,
  ].filter((part): part is string => part !== null)
  return parts.join('；')
}

export function CostTab({ detail }: { detail: Detail }) {
  const { cost } = detail
  const restricted = cost.discount.state === 'RESTRICTED' || cost.platformFee.state === 'RESTRICTED'
  return (
    <div>
      <SectionNote state={cost.state} note={cost.note} />
      <Descriptions size="small" column={1} bordered data-testid="cost-summary">
        <Descriptions.Item label="折扣成本">
          {moneyOr(cost.discount.amount, inner(cost.discount.state))}
          {cost.discount.note ? (
            <div>
              <Muted>{cost.discount.note}</Muted>
            </div>
          ) : null}
        </Descriptions.Item>
        <Descriptions.Item label="平台费用">
          {moneyOr(cost.platformFee.amount, inner(cost.platformFee.state))}
          {cost.platformFee.note ? (
            <div>
              <Muted>{cost.platformFee.note}</Muted>
            </div>
          ) : null}
        </Descriptions.Item>
        <Descriptions.Item label="合计（折扣成本 + 平台费用）">{moneyOr(cost.total, restricted ? 'RESTRICTED' : cost.state === 'OK' ? 'NO_DATA' : cost.state)}</Descriptions.Item>
        <Descriptions.Item label="亚马逊预览费率">{previewText(cost.feePreview)}</Descriptions.Item>
      </Descriptions>
      {cost.platformFee.lines.length ? (
        <SimpleGrid<PromotionFeeLine>
          gridId="promotions.promotion-tabs-3"
          columns={feeLineColumns}
          rows={cost.platformFee.lines}
          rowKey={row => row.label}
          emptyState={{ kind: 'empty', domain: '费用事件', prerequisite: '尚无记录' }}
        />
      ) : null}
    </div>
  )
}

export function ProfitTab({ detail }: { detail: Detail }) {
  const { profit } = detail
  const state: PromotionSectionState = profit.state === 'OK' ? 'NO_DATA' : profit.state
  return (
    <div>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={detail.methodNote} />
      <SectionNote state={profit.state} note={profit.note} />
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="profit-summary">
        <Descriptions.Item label="活动期间实际毛利">{moneyOr(profit.actualProfit, state)}</Descriptions.Item>
        <Descriptions.Item label="基线期望毛利">
          {moneyOr(profit.expectedProfit, state)}
          {profit.expectedProfit === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="增量毛利">
          {moneyOr(profit.incrementalProfit, state)}
          {profit.incrementalProfit === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="促销投入回报率">
          {profit.roi.value === null ? (
            <Muted>{profit.state === 'RESTRICTED' ? '无权限' : '不给数字（原因见上方说明）'}</Muted>
          ) : (
            <span className="erp-num">{formatNumber(profit.roi.value, { digits: 2 })}</span>
          )}
          {profit.roi.value === null ? null : <EstimateTag />}
        </Descriptions.Item>
        <Descriptions.Item label="计算方式" span={2}>
          {profit.roi.formula}
          {profit.roi.denominator === null ? null : <span>（分母 {formatMoney(profit.roi.denominator, 'USD', { digits: 2 })}）</span>}
        </Descriptions.Item>
      </Descriptions>
    </div>
  )
}

export function IssuesTab({ detail }: { detail: Detail }) {
  const { issues } = detail
  return (
    <div>
      <SectionNote state={issues.state} note={issues.note} />
      {issues.latestRevision ? (
        <Alert type={issues.latestRevision.status === 'FAILED' ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }} message={issues.latestRevision.note} data-testid="revision-note" />
      ) : null}
      {issues.promotionIssues.map(issue => (
        <Alert
          key={`${issue.code}-${issue.message}`}
          type={issue.severity === 'ERROR' ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 8 }}
          message={issue.message}
          description={`问题代码：${issue.code}`}
        />
      ))}
      {issues.itemIssueCount > 0 ? <Muted>有 {issues.itemIssueCount} 个商品带问题提示，详见“商品”页签。</Muted> : null}
    </div>
  )
}

const adsColumns: ColumnsType<PromotionAdsRow> = [
  { title: 'ASIN', dataIndex: 'asin', width: 150 },
  { title: '广告花费', dataIndex: 'spend', width: 120, align: 'right', render: (value: number | null) => moneyOr(value) },
  { title: '广告销售额', dataIndex: 'sales', width: 130, align: 'right', render: (value: number | null) => moneyOr(value) },
  { title: '广告订单', dataIndex: 'orders', width: 100, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '在投广告', dataIndex: 'enabledAds', width: 110, align: 'right', render: (value: number, row) => <span className="erp-num">{`${value} / ${row.totalAds}`}</span> },
]

export function AdsTab({ detail }: { detail: Detail }) {
  const { ads } = detail
  return (
    <div>
      <SectionNote state={ads.state} note={ads.note} />
      {ads.state === 'OK' ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ marginBottom: 12 }} data-testid="ads-totals">
          <Descriptions.Item label="广告花费">{moneyOr(ads.totals.spend)}</Descriptions.Item>
          <Descriptions.Item label="广告销售额">{moneyOr(ads.totals.sales)}</Descriptions.Item>
          <Descriptions.Item label="广告订单">{countOr(ads.totals.orders)}</Descriptions.Item>
        </Descriptions>
      ) : null}
      <SimpleGrid<PromotionAdsRow>
        gridId="promotions.promotion-tabs-4"
        columns={adsColumns}
        rows={ads.items}
        rowKey={row => row.asin}
        emptyState={{ kind: 'empty', domain: '广告表现', prerequisite: ads.note ?? '尚无记录' }}
      />
      {ads.items.length ? <Muted>活动期间所选商品的广告表现，只含美元。</Muted> : null}
    </div>
  )
}
