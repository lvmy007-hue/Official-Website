import { useMemo, useState } from 'react'
import { Alert, Card, Space, Tag, Tooltip } from 'antd'
import { LISTING_LIVE_ANOMALIES, LISTING_TREND_LABEL, LISTING_TREND_METRICS, type ListingLiveAnomaly, type ListingPerfResponse, type ListingTrendMetric } from '@nova/api-contracts'
import { ChartPanel } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { buildListingTrendOption } from './listing-perf-options'

// 刊登表现顶部（05 章 5.3）：趋势图（一次一个指标）+ 异常分布。
// 异常里只有“转化率骤降”现在算得出来，可以点击筛选；其余三类写“尚未接入”和负责的工作包，计数不写 0。

const isLive = (kind: string): kind is ListingLiveAnomaly => (LISTING_LIVE_ANOMALIES as readonly string[]).includes(kind)

export function TrendBlock({ data }: { data: ListingPerfResponse }) {
  const [metric, setMetric] = useState<ListingTrendMetric>('sales')
  const option = useMemo(() => buildListingTrendOption(data.trend.points, metric), [data.trend.points, metric])
  const empty = data.trend.state !== 'OK'
  return (
    <ChartPanel
      title={`${data.range.from} 至 ${data.range.to} 的${LISTING_TREND_LABEL[metric]}`}
      ariaLabel="刊登表现趋势图"
      option={option}
      height={220}
      dimensions={LISTING_TREND_METRICS.map(value => ({ value, label: LISTING_TREND_LABEL[value] }))}
      dimension={metric}
      onDimensionChange={value => setMetric(value as ListingTrendMetric)}
      emptyState={empty ? { kind: 'empty', domain: '逐日趋势', prerequisite: data.trend.note ?? '所选日期范围内没有销售与流量记录。' } : undefined}
    />
  )
}

export function AnomalyCards({ data, active, onPick }: { data: ListingPerfResponse; active?: ListingLiveAnomaly; onPick: (kind: ListingLiveAnomaly | undefined) => void }) {
  return (
    <Space wrap size={8} style={{ marginBottom: 8 }} data-testid="listing-anomalies">
      {data.anomalies.map(item => {
        const live = isLive(item.kind) && item.state !== 'NOT_CONNECTED'
        const selected = live && active === item.kind
        return (
          <Tooltip key={item.kind} title={item.note}>
            <Card
              size="small"
              hoverable={live}
              role={live ? 'button' : undefined}
              aria-pressed={live ? selected : undefined}
              aria-label={`${item.label}${live ? '（点击筛选）' : ''}`}
              tabIndex={live ? 0 : undefined}
              style={{ width: 190, borderColor: selected ? 'var(--ant-color-primary)' : undefined, cursor: live ? 'pointer' : 'default' }}
              onClick={live && isLive(item.kind) ? () => onPick(selected ? undefined : (item.kind as ListingLiveAnomaly)) : undefined}
              onKeyDown={event => {
                if (live && isLive(item.kind) && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  onPick(selected ? undefined : (item.kind as ListingLiveAnomaly))
                }
              }}
            >
              <div>{item.label}</div>
              <div style={{ fontSize: 20 }}>
                {item.state === 'NOT_CONNECTED' ? <Muted>尚未接入</Muted> : item.count === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{item.count}</span>}
              </div>
              {selected ? (
                <Tag color="processing" bordered={false}>
                  已筛选
                </Tag>
              ) : null}
            </Card>
          </Tooltip>
        )
      })}
    </Space>
  )
}

/** 数据来源与权限的提示条：只在不是 OK 时出现，写清原因。 */
export function GateNotes({ data }: { data: ListingPerfResponse }) {
  const labels: Array<[keyof ListingPerfResponse['gates'], string]> = [
    ['traffic', '销售与流量'],
    ['ads', '广告销售'],
    ['returns', '退货率'],
    ['stock', '可售天数'],
  ]
  return (
    <>
      {data.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="商品数量超过读取上限，只处理了前一部分；请用筛选缩小范围" /> : null}
      {labels.map(([key, label]) => (data.gates[key].state === 'OK' ? null : <Alert key={key} type="info" showIcon style={{ marginBottom: 8 }} message={`${label}：${data.gates[key].note ?? ''}`} />))}
    </>
  )
}
