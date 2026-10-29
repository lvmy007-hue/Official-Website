import { useMemo, useState } from 'react'
import { Drawer, Select, Space } from 'antd'
import type { BrMetricKey, BrTrendsResponse } from '@nova/api-contracts'
import { ChartPanel, MetricStrip } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink } from '../inventory/inventory-ui'
import { METRIC_CHOICES, buildTrendOption } from './business-reports-options'
import { Figure, Frame, StatCard, metricLabel } from './business-reports-ui'

// 单个 ASIN 的逐日趋势（按 ASIN 表格里的“趋势”）：只取子体粒度的日数据，范围内所有店铺逐日相加；同店同日两个来源只用数据中心。
// 官方在 ASIN 粒度不提供退款件数，趋势里不出现退款相关指标；没有记录的日子是空，不画成 0。

const ASIN_METRICS = METRIC_CHOICES.filter(item => item.value !== 'unitsRefunded' && item.value !== 'refundRate')

function Body({ data }: { data: BrTrendsResponse }) {
  const [primary, setPrimary] = useState<BrMetricKey>('orderedSales')
  const [secondary, setSecondary] = useState<BrMetricKey | null>('sessions')
  const option = useMemo(() => buildTrendOption({ primary, secondary, points: data.points }), [primary, secondary, data.points])
  const empty = data.points.every(point => point.source === null)
  return (
    <>
      {data.productId ? (
        <p style={{ margin: '0 0 8px' }}>
          <LiveLink component="Asin360Page" id={data.productId}>
            打开 ASIN 360
          </LiveLink>
        </p>
      ) : null}
      <MetricStrip>
        {(['orderedSales', 'unitsOrdered', 'sessions', 'unitSessionPct'] as BrMetricKey[]).map(key => (
          <StatCard key={key} title={`${metricLabel(key)}（范围合计）`} testId="br-trend-total">
            <Figure metric={key} value={data.totals[key]} />
          </StatCard>
        ))}
      </MetricStrip>
      <ChartPanel
        title="逐日趋势"
        ariaLabel={`${data.asin} 逐日销售与流量趋势图`}
        option={option}
        height={260}
        extra={
          <Space size={4}>
            <Select size="small" style={{ width: 140 }} aria-label="趋势主指标" value={primary} options={ASIN_METRICS} onChange={setPrimary} />
            <Select
              size="small"
              style={{ width: 140 }}
              aria-label="趋势次指标"
              allowClear
              placeholder="次指标（可选）"
              value={secondary ?? undefined}
              options={ASIN_METRICS}
              onChange={value => setSecondary(value ?? null)}
            />
          </Space>
        }
        emptyState={empty ? { kind: 'empty', domain: '逐日趋势', prerequisite: data.note ?? '所选范围内这个 ASIN 没有逐日记录。' } : undefined}
      />
    </>
  )
}

export function AsinTrendDrawer({ asin, title, onClose }: { asin: string; title: string | null; onClose: () => void }) {
  const query = useApiQuery<BrTrendsResponse>({ domain: 'analytics', path: '/analytics/sales-traffic/trends', params: { asin } })
  return (
    <Drawer open width={720} title={`${asin} 的销售与流量趋势${title ? `：${title}` : ''}`} onClose={onClose} destroyOnHidden>
      <Frame query={query} testId="br-trend">
        {data => <Body data={data} />}
      </Frame>
    </Drawer>
  )
}
