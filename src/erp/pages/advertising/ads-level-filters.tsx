import { useState, type ReactNode } from 'react'
import { Badge, Button, InputNumber, Popover, Space, Tag, Tooltip, Typography } from 'antd'
import {
  ADS_BUCKETS,
  ADS_BUCKET_LABEL,
  ADS_RANGE_LABEL,
  ADS_RANGE_METRICS,
  ADS_RANGE_PERCENT,
  type AdsBucket,
  type AdsLevel,
  type AdsLevelCountsResponse,
  type AdsRangeMetric,
} from '@nova/api-contracts'
import type { FilterField } from '../../components'
import type { FilterPatch, FilterValues } from '../../components/filter/filter-model'
import { useApiQuery } from '../../query/api-query'

// 广告层级页的区间筛选与分类计数（P6-23，16 章第 8 节）：五个层级共用。
// - 区间：每个指标一对“下限、上限”，比率按百分数输入（20 表示 20%），写进地址栏时是小数（0.2）；
// - 分类计数：有成交、有点击无成交、有曝光无点击、无曝光，互斥；数字来自 GET /ads/:level/counts，随当前筛选变化，没有指标的对象单独说明，不算任何一类。

const rangeKeys = (metric: AdsRangeMetric) => [`${metric}Min`, `${metric}Max`] as const

/** 区间与分类的地址栏字段：隐藏（不进筛选栏），但由地址栏管理，重置时一并清掉并计入“已应用条件”。 */
export const LEVEL_HIDDEN_FIELDS: FilterField[] = [
  ...ADS_RANGE_METRICS.flatMap(metric => rangeKeys(metric).map(key => ({ key, label: ADS_RANGE_LABEL[metric], kind: 'text' as const, hidden: true }))),
  { key: 'bucket', label: '分类', kind: 'select', hidden: true, options: ADS_BUCKETS.map(value => ({ value, label: ADS_BUCKET_LABEL[value] })) },
]

const toInput = (metric: AdsRangeMetric, text: string | undefined): number | null => {
  if (text === undefined) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return ADS_RANGE_PERCENT.has(metric) ? Math.round(value * 10_000) / 100 : value
}
const toParam = (metric: AdsRangeMetric, input: number | null): string | undefined => {
  if (input === null || !Number.isFinite(input)) return undefined
  return String(ADS_RANGE_PERCENT.has(metric) ? Math.round(input * 100) / 10_000 : input)
}

/** 当前已设置区间的指标个数。 */
export const rangeCount = (values: FilterValues): number => ADS_RANGE_METRICS.filter(metric => rangeKeys(metric).some(key => values[key] !== undefined)).length

export function RangeFilter({ values, onApply, metrics = ADS_RANGE_METRICS }: { values: FilterValues; onApply: (patch: FilterPatch) => void; metrics?: readonly AdsRangeMetric[] }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<string, number | null>>({})
  const count = rangeCount(values)
  const begin = (next: boolean) => {
    if (next) setDraft(Object.fromEntries(metrics.flatMap(metric => rangeKeys(metric).map(key => [key, toInput(metric, values[key])]))))
    setOpen(next)
  }
  const invalid = metrics.find(metric => {
    const [minKey, maxKey] = rangeKeys(metric)
    const min = draft[minKey]
    const max = draft[maxKey]
    return min != null && max != null && min > max
  })
  const apply = () => {
    const patch: FilterPatch = {}
    for (const metric of ADS_RANGE_METRICS) for (const key of rangeKeys(metric)) patch[key] = metrics.includes(metric) ? toParam(metric, draft[key] ?? null) : values[key]
    onApply(patch)
    setOpen(false)
  }
  const clear = () => {
    onApply(Object.fromEntries(ADS_RANGE_METRICS.flatMap(metric => rangeKeys(metric).map(key => [key, undefined]))))
    setOpen(false)
  }
  const content: ReactNode = (
    <div style={{ width: 340 }} data-testid="ads-range-panel">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        例如广告成本销售比下限 20、上限 40，表示 20% 到 40%。留空表示不限；没有指标（或算不出该比率）的对象不会命中已设置的区间。
      </Typography.Paragraph>
      {metrics.map(metric => {
        const [minKey, maxKey] = rangeKeys(metric)
        const percent = ADS_RANGE_PERCENT.has(metric)
        return (
          <div key={metric} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ width: 96, fontSize: 12 }}>{ADS_RANGE_LABEL[metric]}</span>
            <InputNumber
              size="small"
              min={0}
              placeholder="下限"
              aria-label={`${ADS_RANGE_LABEL[metric]}下限`}
              value={draft[minKey] ?? null}
              onChange={value => setDraft(prev => ({ ...prev, [minKey]: value }))}
              style={{ width: 96 }}
            />
            <span>至</span>
            <InputNumber
              size="small"
              min={0}
              placeholder="上限"
              aria-label={`${ADS_RANGE_LABEL[metric]}上限`}
              value={draft[maxKey] ?? null}
              onChange={value => setDraft(prev => ({ ...prev, [maxKey]: value }))}
              style={{ width: 96 }}
            />
            {percent ? <span style={{ fontSize: 12 }}>%</span> : null}
          </div>
        )
      })}
      {invalid ? <Typography.Text type="danger">{ADS_RANGE_LABEL[invalid]}的下限不能大于上限</Typography.Text> : null}
      <Space style={{ marginTop: 8 }}>
        <Button size="small" type="primary" disabled={invalid !== undefined} onClick={apply}>
          应用
        </Button>
        <Button size="small" onClick={clear}>
          清空区间
        </Button>
      </Space>
    </div>
  )
  return (
    <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={begin} content={content} title="指标区间筛选">
      <Badge count={count} size="small" offset={[-2, 2]}>
        <Button size="small" data-testid="ads-range-button">
          指标区间
        </Button>
      </Badge>
    </Popover>
  )
}

/** 分类计数条：点一类就按这一类筛选，再点取消；数字是当前筛选下每类的对象个数。 */
export function BucketChips({ level, params, values, onPick }: { level: AdsLevel; params: Record<string, string | undefined>; values: FilterValues; onPick: (bucket: AdsBucket | undefined) => void }) {
  const { bucket: current, ...rest } = values
  const query = useApiQuery<AdsLevelCountsResponse>({ domain: 'analytics', path: `/ads/${level}/counts`, params: { ...params, ...rest } })
  const data = query.data
  return (
    <div data-testid="ads-bucket-chips" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
      <Tooltip title={data?.rule}>
        <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>分类：</span>
      </Tooltip>
      {ADS_BUCKETS.map(bucket => (
        <Tag.CheckableTag key={bucket} checked={current === bucket} onChange={checked => onPick(checked ? bucket : undefined)}>
          {ADS_BUCKET_LABEL[bucket]} {data ? data.buckets[bucket] : query.error ? '读取失败' : '…'}
        </Tag.CheckableTag>
      ))}
      {data && data.withoutMetrics > 0 ? <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>另有 {data.withoutMetrics} 个对象尚无指标，不在任何一类里</span> : null}
      {data?.truncated ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          对象超过读取上限，计数只含前一部分
        </Typography.Text>
      ) : null}
      {query.error ? (
        <Button size="small" type="link" onClick={() => void query.refetch()}>
          重试
        </Button>
      ) : null}
    </div>
  )
}
