import { useState } from 'react'
import { Select, Space } from 'antd'
import { ADS_WEEKDAY_LABEL, DAYPARTING_METRIC_LABEL, DAYPARTING_METRICS, hourlyMetricValue, type DaypartingHeatmap, type DaypartingMetric } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { Section, StateNote } from './ads-ui'

// 分时热力图（P3-12）：近 14 天活动级小时指标，按企业时区累计到“星期 × 小时”。没有行的格子显示“—”（不当 0）；数据流没接入时整块写“尚未接入”。

const text = (metric: DaypartingMetric, value: number): string =>
  metric === 'orders' ? formatNumber(value, { digits: 0 }) : metric === 'acos' ? formatPercent(value, { digits: 0 }) : formatMoney(value, 'USD', { digits: metric === 'cpc' ? 2 : 0 })

function HeatTable({ heatmap, metric }: { heatmap: DaypartingHeatmap; metric: DaypartingMetric }) {
  const byKey = new Map(heatmap.cells.map(cell => [`${cell.weekday}|${cell.hour}`, cell]))
  const values = heatmap.cells.map(cell => hourlyMetricValue(cell, metric)).filter((value): value is number => value !== null)
  const max = Math.max(0, ...values)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-testid="dayparting-heatmap" aria-label="分时热力图" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, hour) => (
              <th key={hour} style={{ padding: '2px 4px', fontWeight: 400 }}>
                {hour}时
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ADS_WEEKDAY_LABEL.map((label, weekday) => (
            <tr key={label}>
              <th style={{ padding: '2px 6px', fontWeight: 400, textAlign: 'right' }}>{label}</th>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = byKey.get(`${weekday}|${hour}`)
                const value = cell ? hourlyMetricValue(cell, metric) : null
                const alpha = value === null ? 0 : max > 0 ? 0.12 + (0.7 * value) / max : 0.12
                return (
                  <td
                    key={hour}
                    title={cell ? `${label} ${hour} 时：累计 ${cell.samples} 个小时样本` : `${label} ${hour} 时：无数据`}
                    style={{ minWidth: 34, height: 24, textAlign: 'center', border: '1px solid #f0f0f0', background: value === null ? '#fafafa' : `rgba(22,119,255,${alpha.toFixed(2)})` }}
                  >
                    {value === null ? '—' : text(metric, value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function HeatmapSection({ heatmap, loading, error, onRetry }: { heatmap?: DaypartingHeatmap; loading: boolean; error: unknown; onRetry: () => void }) {
  const [metric, setMetric] = useState<DaypartingMetric>('spend')
  return (
    <Section title="分时热力图" loading={loading} error={error} onRetry={onRetry} testId="dayparting-heatmap-section">
      {heatmap ? (
        heatmap.state === 'OK' ? (
          <>
            <Space style={{ marginBottom: 8 }} wrap>
              <Select value={metric} aria-label="分时指标" style={{ width: 180 }} options={DAYPARTING_METRICS.map(value => ({ value, label: DAYPARTING_METRIC_LABEL[value] }))} onChange={setMetric} />
              <Muted>
                近 {heatmap.historyDays} 天全部活动（美元），按企业时区（{heatmap.zone}）累计；颜色越深数值越大，没有数据的格子显示“—”。
              </Muted>
            </Space>
            <HeatTable heatmap={heatmap} metric={metric} />
          </>
        ) : (
          <StateNote state={heatmap.state} note={heatmap.note} />
        )
      ) : null}
    </Section>
  )
}
