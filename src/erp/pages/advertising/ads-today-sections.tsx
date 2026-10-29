import { Progress, Space, Tag, Typography } from 'antd'
import {
  ADS_TODAY_ANOMALY_LABEL,
  ADS_TODAY_BASELINE_DAYS,
  ADS_TODAY_EXHAUST_LABEL,
  type AdsTodayAnomalies,
  type AdsTodayAnomaly,
  type AdsTodayBudget,
  type AdsTodayBudgetRow,
  type AdsTodayOutOfBudget,
  type AdsTodayStockout,
  type AdsTodayStockoutItem,
} from '@nova/api-contracts'
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '../../format'
import { Section, StateNote } from './ads-ui'
import { SimpleGrid } from '../../components'

// 今日广告的预算、超预算、异常与断货区域（08 章 8.2）。
// 没有数据的区域写明状态与原因（尚无记录、尚未接入），不画示例数字、不补 0。

const money = (value: number | null) => formatMoney(value, 'USD', { digits: 2 })

function ExhaustCell({ row }: { row: AdsTodayBudgetRow }) {
  if (!row.exhaust) return <>—</>
  if (row.exhaust === 'PROJECTED' && row.exhaustAt) return <Tag color="warning">预计 {formatDateTime(row.exhaustAt)} 耗尽（估算）</Tag>
  if (row.exhaust === 'EXHAUSTED') return <Tag color="error">{ADS_TODAY_EXHAUST_LABEL.EXHAUSTED}</Tag>
  return <Typography.Text type="secondary">{ADS_TODAY_EXHAUST_LABEL[row.exhaust]}</Typography.Text>
}

export function BudgetSection({ budget }: { budget: AdsTodayBudget }) {
  return (
    <Section title="预算消耗" testId="ads-today-budget">
      {budget.state !== 'OK' ? (
        <>
          <StateNote state={budget.state} note={budget.note} />
          {budget.dailyBudgetTotal !== null ? (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              当前日预算合计 {money(budget.dailyBudgetTotal)}（{budget.budgetedCampaigns} 个活动，来自活动管理接口）
            </Typography.Paragraph>
          ) : null}
        </>
      ) : (
        <>
          <Space size={24} wrap style={{ marginBottom: 8 }} data-testid="ads-today-budget-total">
            <span>
              今日已花费 <strong>{money(budget.spentToday)}</strong>
            </span>
            <span>
              日预算合计 <strong>{money(budget.dailyBudgetTotal)}</strong>
            </span>
            <span>
              进度 <strong>{budget.progress === null ? '—' : formatPercent(budget.progress, { digits: 1 })}</strong>
            </span>
            <span>带日预算的活动 {budget.budgetedCampaigns} 个</span>
          </Space>
          <SimpleGrid
            gridId="advertising.ads-today-sections"
            columns={[
              { title: '活动', dataIndex: 'name' },
              { title: '日预算', dataIndex: 'dailyBudget', align: 'right', render: (value: number) => money(value) },
              { title: '今日花费', dataIndex: 'spend', align: 'right', render: (value: number | null) => money(value) },
              {
                title: '进度',
                dataIndex: 'progress',
                width: 160,
                render: (value: number | null) => (value === null ? '—' : <Progress size="small" percent={Math.min(100, Math.round(value * 100))} status={value >= 1 ? 'exception' : 'normal'} />),
              },
              { title: '预计耗尽', key: 'exhaust', render: (_: unknown, row: AdsTodayBudgetRow) => <ExhaustCell row={row} /> },
            ]}
            rows={budget.rows}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
          {budget.note ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {budget.note}
            </Typography.Text>
          ) : null}
        </>
      )}
    </Section>
  )
}

export function OutOfBudgetSection({ outOfBudget }: { outOfBudget: AdsTodayOutOfBudget }) {
  return (
    <Section title="超预算活动" testId="ads-today-out-of-budget">
      {outOfBudget.state !== 'OK' ? (
        <StateNote state={outOfBudget.state} note={outOfBudget.note} />
      ) : (
        <>
          {outOfBudget.count === 0 ? (
            <Typography.Text>活动管理接口里没有投放状态为“预算用完”的启用中活动</Typography.Text>
          ) : (
            <Space size={[8, 8]} wrap>
              <Typography.Text strong>{outOfBudget.count} 个活动的投放状态是预算用完：</Typography.Text>
              {outOfBudget.rows.map(row => (
                <Tag key={row.key} color="error" title={row.servingStatus}>
                  {row.name}
                </Tag>
              ))}
              {outOfBudget.count > outOfBudget.rows.length ? <Typography.Text type="secondary">只列出前 {outOfBudget.rows.length} 个</Typography.Text> : null}
            </Space>
          )}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {outOfBudget.note}
            </Typography.Text>
          </div>
        </>
      )}
    </Section>
  )
}

const kindColor = { CPC_SURGE: 'orange', SPEND_NO_CONVERSION: 'red' } as const

export function AnomaliesSection({ anomalies }: { anomalies: AdsTodayAnomalies }) {
  return (
    <Section title={`今日异常（${anomalies.count} 项）`} testId="ads-today-anomalies">
      {anomalies.state !== 'OK' ? (
        <StateNote state={anomalies.state} note={anomalies.note} />
      ) : (
        <>
          {anomalies.items.length === 0 ? (
            <StateNote state="NO_DATA" note="今天还没有活动命中规则" />
          ) : (
            <SimpleGrid
              gridId="advertising.ads-today-sections-2"
              columns={[
                { title: '活动', dataIndex: 'name' },
                { title: '异常', dataIndex: 'kind', render: (_: unknown, row: AdsTodayAnomaly) => <Tag color={kindColor[row.kind]}>{ADS_TODAY_ANOMALY_LABEL[row.kind]}</Tag> },
                { title: '今日花费', dataIndex: 'spend', align: 'right', render: (value: number) => money(value) },
                { title: '点击', dataIndex: 'clicks', align: 'right', render: (value: number) => formatNumber(value, { digits: 0 }) },
                { title: '订单', dataIndex: 'orders', align: 'right', render: (value: number) => formatNumber(value, { digits: 0 }) },
                { title: '单次点击成本', dataIndex: 'cpc', align: 'right', render: (value: number | null) => money(value) },
                {
                  title: `对比近 ${ADS_TODAY_BASELINE_DAYS} 天`,
                  key: 'baseline',
                  align: 'right',
                  render: (_: unknown, row: AdsTodayAnomaly) => (row.ratio === null ? '—' : `基线 ${money(row.baselineCpc)}，${row.ratio.toFixed(1)} 倍`),
                },
              ]}
              rows={anomalies.items}
              rowKey={row => `${row.key}-${row.kind}`}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            规则（自定默认值）：今日点击不少于 {anomalies.rules.CPC_MIN_CLICKS}、近 {ADS_TODAY_BASELINE_DAYS} 天点击不少于 {anomalies.rules.BASELINE_MIN_CLICKS}，且今日单次点击成本不低于近{' '}
            {ADS_TODAY_BASELINE_DAYS} 天的 {anomalies.rules.CPC_RATIO} 倍；或今日花费不低于 {anomalies.rules.NO_CONVERSION_MIN_SPEND} 美元、点击不少于 {anomalies.rules.NO_CONVERSION_MIN_CLICKS}{' '}
            但今天还没有订单（转化数据滞后，仅作提示）。
            {anomalies.note ? ` ${anomalies.note}` : ''}
          </Typography.Text>
        </>
      )}
    </Section>
  )
}

export function StockoutSection({ stockout }: { stockout: AdsTodayStockout }) {
  return (
    <Section title="断货商品仍在投放" testId="ads-today-stockout">
      {stockout.state !== 'OK' ? (
        <StateNote state={stockout.state} note={stockout.note} />
      ) : (
        <>
          {stockout.items.length === 0 ? (
            <Typography.Text>近 {stockout.lookbackDays} 天有花费的商品，最近一次库存快照里都还有货</Typography.Text>
          ) : (
            <SimpleGrid
              gridId="advertising.ads-today-sections-3"
              columns={[
                { title: 'ASIN', dataIndex: 'asin' },
                { title: '店铺', dataIndex: 'storeName', render: (value: string | null, row: AdsTodayStockoutItem) => value ?? row.sellerAccountId },
                { title: '可售', dataIndex: 'sellable', align: 'right', render: (value: number) => formatNumber(value, { digits: 0 }) },
                { title: '库存快照日期', dataIndex: 'snapshotDate' },
                { title: `近 ${stockout.lookbackDays} 天花费`, dataIndex: 'spend', align: 'right', render: (value: number) => money(value) },
                { title: '日均浪费', dataIndex: 'dailyWaste', align: 'right', render: (value: number) => money(value) },
              ]}
              rows={stockout.items}
              rowKey={row => row.key}
              emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
            />
          )}
          {stockout.note ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {stockout.note}
            </Typography.Text>
          ) : null}
        </>
      )}
    </Section>
  )
}
