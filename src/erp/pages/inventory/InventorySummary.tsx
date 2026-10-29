import { useMemo } from 'react'
import { Col, Row } from 'antd'
import type { InventoryCard, InventorySummaryResponse } from '@nova/api-contracts'
import { ChartPanel, EstimateTag, MetricCard, MetricStrip, type MetricCardProps } from '../../components'
import { STATE_LABEL } from './inventory-ui'
import { ageOption, coverOption, feeOption, hasFeeData, structureOption } from './inventory-charts'

// 库存健康页顶部：8 张指标卡与 4 张图。没有数据的卡写“尚无记录 / 尚未接入”及原因，不显示成 0；估算类数字带“模型估算”标注。

const VERSION = 'inventory-health@1'
const DEFINITIONS: Record<keyof InventorySummaryResponse['cards'], MetricCardProps['definition']> = {
  sellableTotal: { description: '范围内全部 FBA 库存记录的可售数量之和', source: '库存接口（FBA Inventory）', refresh: '每 30 分钟', version: VERSION },
  inboundTotal: { description: '处理中 + 已发货 + 接收中的在途数量之和', source: '库存接口（FBA Inventory）', refresh: '每 30 分钟', version: VERSION },
  unsellableTotal: { description: '不可售数量之和（不含调查中）', source: '库存接口（FBA Inventory）', refresh: '每 30 分钟', version: VERSION },
  lowSkuCount: {
    description: '风险等级为高或中的 SKU 数',
    formula: '可售天数 =（可售 + 计入的在途）÷ 预测日销；早于最快补货到仓日为高，落在安全库存内为中',
    source: '库存规则（当前生效版本）与订单日汇总',
    refresh: '随订单汇总',
    version: VERSION,
  },
  excessSkuCount: { description: '覆盖天数超过 目标覆盖天数 × 冗余倍数 的 SKU 数', source: '库存规则（当前生效版本）与订单日汇总', refresh: '随订单汇总', version: VERSION },
  nextMonthStorageFee: { description: '亚马逊库存规划报告里的“预计下月仓储费”之和（只含有预估的 SKU）', source: '库存规划报告', refresh: '每日', version: VERSION },
  ageSurchargeEstimate: { description: '亚马逊库龄报告里的库龄附加费预估之和（只含有预估的 SKU）', source: '库龄报告', refresh: '每日', version: VERSION },
  lowFeeRiskSkuCount: { description: '亚马逊库存规划报告标出“适用低库存水平费”或费用大于 0 的 SKU 数', source: '库存规划报告', refresh: '每日', version: VERSION },
}

type Spec = { key: keyof InventorySummaryResponse['cards']; label: string; format: 'money' | 'number'; goodWhen?: 'down'; estimate?: string }
const SPECS: Spec[] = [
  { key: 'sellableTotal', label: '可售库存（件）', format: 'number' },
  { key: 'inboundTotal', label: '在途（件）', format: 'number' },
  { key: 'unsellableTotal', label: '不可售（件）', format: 'number', goodWhen: 'down' },
  { key: 'lowSkuCount', label: '低库存 SKU', format: 'number', goodWhen: 'down' },
  { key: 'excessSkuCount', label: '冗余 SKU', format: 'number', goodWhen: 'down' },
  { key: 'nextMonthStorageFee', label: '预计下月仓储费', format: 'money', goodWhen: 'down', estimate: '亚马逊库存规划报告的预估值' },
  { key: 'ageSurchargeEstimate', label: '库龄附加费预估', format: 'money', goodWhen: 'down', estimate: '亚马逊库龄报告的预估值' },
  { key: 'lowFeeRiskSkuCount', label: '低库存水平费风险 SKU', format: 'number', goodWhen: 'down' },
]

const reasonOf = (card: InventoryCard) => [STATE_LABEL[card.state], card.note].filter(Boolean).join('：')

export function SummaryCards({ summary }: { summary: InventorySummaryResponse }) {
  return (
    <MetricStrip>
      {SPECS.map(spec => {
        const card = summary.cards[spec.key]
        return (
          <MetricCard
            key={spec.key}
            label={spec.label}
            value={card.value}
            format={spec.format}
            goodWhen={spec.goodWhen}
            definition={DEFINITIONS[spec.key]}
            unavailableReason={card.state === 'OK' ? undefined : reasonOf(card)}
            estimate={card.state === 'OK' && spec.estimate ? <EstimateTag method={spec.estimate} /> : undefined}
          />
        )
      })}
    </MetricStrip>
  )
}

const empty = (domain: string, prerequisite: string) => ({ kind: 'empty' as const, domain, prerequisite })

export function SummaryCharts({ summary }: { summary: InventorySummaryResponse }) {
  const { structure, ageDistribution, coverDistribution, feeTrend } = summary.charts
  const hasStructure = structure.length > 0
  const hasAge = ageDistribution.granularity !== null
  const hasCover = coverDistribution.some(bin => bin.count > 0)
  const options = useMemo(
    () => ({ structure: structureOption(structure), age: ageOption(ageDistribution), cover: coverOption(coverDistribution), fee: feeOption(feeTrend) }),
    [structure, ageDistribution, coverDistribution, feeTrend],
  )
  return (
    <Row gutter={[8, 8]} style={{ marginBottom: 8 }}>
      <Col xs={24} lg={12}>
        <ChartPanel title="库存结构（按店铺）" ariaLabel="各店铺库存结构堆叠柱图" option={options.structure} emptyState={hasStructure ? undefined : empty('库存结构', '范围内尚无库存记录')} />
      </Col>
      <Col xs={24} lg={12}>
        <ChartPanel
          title={`库龄分布${ageDistribution.granularity === 'COARSE' ? '（报告未给细分段，按 5 段显示）' : ''}`}
          ariaLabel="库龄分布柱图"
          option={options.age}
          emptyState={hasAge ? undefined : empty('库龄分布', '尚无库龄快照；库龄报告同步后显示')}
        />
      </Col>
      <Col xs={24} lg={12}>
        <ChartPanel
          title="可售天数分布（SKU 数）"
          ariaLabel="可售天数分布柱图"
          option={options.cover}
          emptyState={hasCover ? undefined : empty('可售天数分布', '尚无可计算可售天数的 SKU（需要先配置库存规则并有销量记录）')}
        />
      </Col>
      <Col xs={24} lg={12}>
        <ChartPanel
          title="仓储费趋势（近 6 个月）"
          ariaLabel="仓储费趋势堆叠柱图"
          option={options.fee}
          emptyState={hasFeeData(feeTrend) ? undefined : empty('仓储费趋势', '尚无仓储费记录；仓储费报告同步后显示')}
        />
      </Col>
    </Row>
  )
}
