import { useMemo } from 'react'
import { Alert, Card, Space, Tag, Typography } from 'antd'
import { ADS_ANOMALY_LABEL, ADS_QUADRANT_LABEL, type AdsAnomalyItem, type AdsAttributionTree, type AdsOverviewResponse, type DashState } from '@nova/api-contracts'
import { ChartPanel, MetricTreeAttribution, SimpleGrid } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { buildBudgetOption, buildFunnelOption, buildProductOption, buildQuadrantOption } from './ads-options'
import { Section, StateNote } from './ads-ui'

// 广告控制台的其余区域（08 章 8.1）：产品结构、漏斗、预算消耗、目标 ACoS、四象限、异常活动、指标树归因。
// 没有数据的区域写明状态与原因，不画示例图、不补 0。

const money = (value: number | null) => (value === null ? '—' : formatMoney(value, 'USD', { digits: 2 }))

/** 区域状态不是 OK 时用状态说明代替图表。 */
function Gate({ title, state, note, testId, children }: { title: string; state: DashState; note: string | null; testId: string; children: React.ReactNode }) {
  if (state === 'OK') return <>{children}</>
  return (
    <Card size="small" title={title} style={{ marginBottom: 12 }} data-testid={testId}>
      <StateNote state={state} note={note} />
    </Card>
  )
}

export function ProductSection({ data }: { data: AdsOverviewResponse }) {
  const option = useMemo(() => buildProductOption(data.products), [data.products])
  const drawn = data.products.some(row => row.state === 'OK' && (row.spend ?? 0) > 0)
  return (
    <Section title="广告产品结构" testId="ads-products">
      {drawn ? <ChartPanel title="花费占比" ariaLabel="广告产品花费占比" option={option} height={220} /> : null}
      <SimpleGrid
        gridId="advertising.ads-sections"
        columns={[
          { title: '广告产品', dataIndex: 'label' },
          { title: '花费', dataIndex: 'spend', align: 'right', render: (_: unknown, row) => (row.state === 'OK' ? money(row.spend) : <StateNote state={row.state} note={row.note} />) },
          { title: '广告销售额', dataIndex: 'sales', align: 'right', render: (_: unknown, row) => (row.state === 'OK' ? money(row.sales) : '—') },
          { title: '订单', dataIndex: 'orders', align: 'right', render: (_: unknown, row) => (row.state === 'OK' ? formatNumber(row.orders, { digits: 0 }) : '—') },
          { title: '花费占比', dataIndex: 'spendShare', align: 'right', render: (_: unknown, row) => (row.spendShare === null ? '—' : formatPercent(row.spendShare, { digits: 1 })) },
        ]}
        rows={data.products}
        rowKey={row => row.adProduct}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </Section>
  )
}

export function FunnelSection({ data }: { data: AdsOverviewResponse }) {
  const funnel = data.funnel.value
  const option = useMemo(() => (funnel ? buildFunnelOption(funnel) : {}), [funnel])
  return (
    <Gate title="活动漏斗" state={data.funnel.state} note={data.funnel.note} testId="ads-funnel">
      {funnel ? (
        <div data-testid="ads-funnel">
          <ChartPanel title="活动漏斗" ariaLabel="曝光点击订单漏斗" option={option} height={220} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            点击率 {funnel.clickRate === null ? '—' : formatPercent(funnel.clickRate, { digits: 2 })}，转化率（订单 ÷ 点击）{' '}
            {funnel.conversionRate === null ? '—' : formatPercent(funnel.conversionRate, { digits: 2 })}
          </Typography.Text>
        </div>
      ) : null}
    </Gate>
  )
}

export function BudgetSection({ data }: { data: AdsOverviewResponse }) {
  const budget = data.budget
  const option = useMemo(() => buildBudgetOption(budget), [budget])
  return (
    <div data-testid="ads-budget">
      <Gate title="预算消耗" state={budget.state} note={budget.note} testId="ads-budget-empty">
        <ChartPanel title="预算消耗（按日花费）" ariaLabel="按日花费与日预算" option={option} height={240} />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {budget.utilization === null ? '预算利用率无法计算' : `预算利用率 ${formatPercent(budget.utilization, { digits: 1 })}`}，带日预算的活动 {budget.budgetedCampaigns} 个；{budget.note}
        </Typography.Paragraph>
      </Gate>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }} data-testid="ads-over-budget">
        平均超预算时长：<strong>{budget.overBudget.state === 'NOT_CONNECTED' ? '尚未接入' : ''}</strong>，{budget.overBudget.note}
      </Typography.Paragraph>
    </div>
  )
}

export function TargetAcosSection({ data }: { data: AdsOverviewResponse }) {
  return (
    <Section title="目标广告成本销售比对比" testId="ads-target-acos">
      <StateNote state={data.targetAcos.state} note={data.targetAcos.note} />
    </Section>
  )
}

export function QuadrantSection({ data }: { data: AdsOverviewResponse }) {
  const quadrant = data.quadrant
  const option = useMemo(() => buildQuadrantOption(quadrant), [quadrant])
  return (
    <Gate title="活动四象限（花费 × 广告成本销售比）" state={quadrant.state} note={quadrant.note} testId="ads-quadrant">
      <div data-testid="ads-quadrant">
        <ChartPanel title="活动四象限（花费 × 广告成本销售比）" ariaLabel="活动四象限" option={option} height={300} />
        <Space size={[8, 4]} wrap style={{ fontSize: 12 }}>
          {(Object.keys(ADS_QUADRANT_LABEL) as Array<keyof typeof ADS_QUADRANT_LABEL>).map(key => (
            <Tag key={key} bordered={false}>
              {ADS_QUADRANT_LABEL[key]}：{quadrant.points.filter(point => point.quadrant === key).length} 个
            </Tag>
          ))}
          {quadrant.withoutSales > 0 ? <Typography.Text type="secondary">另有 {quadrant.withoutSales} 个活动没有广告销售额，画不出 ACoS</Typography.Text> : null}
          {quadrant.note ? <Typography.Text type="secondary">{quadrant.note}</Typography.Text> : null}
        </Space>
      </div>
    </Gate>
  )
}

export function AnomalySection({ data }: { data: AdsOverviewResponse }) {
  const anomalies = data.anomalies
  return (
    <Gate title="异常活动" state={anomalies.state} note={anomalies.note} testId="ads-anomalies">
      <Section title={`异常活动（${anomalies.count} 个）`} testId="ads-anomalies">
        {anomalies.items.length === 0 ? (
          <StateNote state="NO_DATA" note={anomalies.note ?? '没有命中规则的活动'} />
        ) : (
          <SimpleGrid
            gridId="advertising.ads-sections-2"
            columns={[
              { title: '活动', dataIndex: 'name' },
              { title: '异常', dataIndex: 'kind', render: (_: unknown, row: AdsAnomalyItem) => <Tag color="warning">{ADS_ANOMALY_LABEL[row.kind]}</Tag> },
              { title: '花费', dataIndex: 'spend', align: 'right', render: (value: number) => money(value) },
              { title: '广告销售额', dataIndex: 'sales', align: 'right', render: (value: number | null) => money(value) },
              { title: '点击', dataIndex: 'clicks', align: 'right' },
              { title: '订单', dataIndex: 'orders', align: 'right' },
            ]}
            rows={anomalies.items}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          规则（自定默认值）：花费不低于 {anomalies.rules.MIN_SPEND} 美元且点击不少于 {anomalies.rules.MIN_CLICKS} 但没有订单；或花费超过广告销售额。
        </Typography.Text>
      </Section>
    </Gate>
  )
}

function Tree({ tree }: { tree: AdsAttributionTree }) {
  return <MetricTreeAttribution title={tree.title} kind="product" factors={tree.factors} formatTotal={value => formatNumber(value, { digits: 2 })} />
}

export function AttributionSection({ data }: { data: AdsOverviewResponse }) {
  const attribution = data.attribution
  return (
    <Section title="指标树归因" testId="ads-attribution">
      {attribution.state !== 'OK' ? (
        <StateNote state={attribution.state} note={attribution.note} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {attribution.note ? <Alert type="info" showIcon message={attribution.note} /> : null}
          {attribution.spend ? <Tree tree={attribution.spend} /> : <StateNote state="NO_DATA" note="花费变化无法拆解" />}
          {attribution.sales ? <Tree tree={attribution.sales} /> : <StateNote state="NO_DATA" note="广告销售额变化无法拆解" />}
        </Space>
      )}
    </Section>
  )
}
