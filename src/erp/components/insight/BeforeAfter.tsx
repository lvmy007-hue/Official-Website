import { Alert, Card } from 'antd'
import { formatMoney, formatNumber, formatPercent, toneClassName, toneOf } from '../../format'
import { compareBeforeAfter, type BeforeAfterInput } from './analysis'
import { SimpleGrid } from '../table/SimpleGrid'

// 前后对照分析（03 章 3.4 第 4 项）：对任一操作或事件，“前 N 天对后 N 天”，并以同期大盘变化作参照，
// 避免把整体波动误判为操作效果。净变化 = 对象变化 − 大盘变化。

export type BeforeAfterMetric = BeforeAfterInput & { key: string; label: string; format: 'money' | 'number'; currency?: string; goodWhen?: 'up' | 'down' }

function fmt(metric: BeforeAfterMetric, value: number) {
  return metric.format === 'money' ? formatMoney(value, metric.currency ?? 'USD', { digits: 0 }) : formatNumber(value)
}

export function BeforeAfter({ title, windowDays, metrics }: { title: string; windowDays: number; metrics: BeforeAfterMetric[] }) {
  const rows = metrics.map(metric => ({ metric, result: compareBeforeAfter(metric) }))
  const missingBench = rows.some(row => row.result.benchChange === null)
  return (
    <Card size="small" title={`${title}：前 ${windowDays} 天 对比 后 ${windowDays} 天`} data-testid="before-after">
      {missingBench ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="部分指标没有同期大盘参照，只能显示对象自身变化，不能判断是否为操作效果。" /> : null}
      <SimpleGrid
        gridId="insight.before-after"
        columns={[
          { title: '指标', render: (_, row) => row.metric.label },
          { title: `前 ${windowDays} 天`, align: 'right', render: (_, row) => <span className="erp-num">{fmt(row.metric, row.result.beforeTotal)}</span> },
          { title: `后 ${windowDays} 天`, align: 'right', render: (_, row) => <span className="erp-num">{fmt(row.metric, row.result.afterTotal)}</span> },
          {
            title: '自身变化',
            align: 'right',
            render: (_, row) => <span className={`erp-num ${toneClassName(toneOf(row.result.change, row.metric.goodWhen))}`}>{formatPercent(row.result.change, { sign: true })}</span>,
          },
          { title: '同期大盘', align: 'right', render: (_, row) => <span className="erp-num">{formatPercent(row.result.benchChange, { sign: true })}</span> },
          {
            title: '净变化',
            align: 'right',
            render: (_, row) => <strong className={`erp-num ${toneClassName(toneOf(row.result.adjusted, row.metric.goodWhen))}`}>{formatPercent(row.result.adjusted, { sign: true })}</strong>,
          },
        ]}
        rows={rows}
        rowKey={row => row.metric.key}
        emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
      />
    </Card>
  )
}
